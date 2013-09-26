// Copyright 2012 Google Inc.  All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not
// use this file except in compliance with the License.  You may obtain a copy
// of the License at: http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software distrib-
// uted under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES
// OR CONDITIONS OF ANY KIND, either express or implied.  See the License for
// specific language governing permissions and limitations under the License.

/**
 * @fileoverview A custom map overlay rendered from image tiles.
 * @author giencke@google.com (Pete Giencke)
 */
goog.provide('cm.TileOverlay');

goog.require('cm');
goog.require('cm.AppState');
goog.require('cm.LatLonBox');
goog.require('cm.LayerModel');
goog.require('cm.ProxyTileMapType');
goog.require('cm.events');
goog.require('cm.geometry');
goog.require('goog.Uri');
goog.require('goog.net.Jsonp');
goog.require('goog.net.XhrIo');

var JSON_PROXY_URL = '/crisismap/.jsonp';

// Period to refresh the dynamic tile index json.
var INDEX_REFRESH_PERIOD_MS = 180000; // 3 min

// Period to wait for tiles to load before swapping in a new tile url.
var MAX_TILE_LOAD_MS = 2000; // 2s

var TILESET_CONFIGURE_URL = '/crisismap/.wms/configure';

var TILECACHE_URL = '/crisismap/.wms/tiles';

/**
 * A map overlay which displays tiles and a bounding box.  It wraps an
 * ImageMapType and defines the same interface as KmlLayer, namely setMap.
 * @param {cm.LayerModel} layer The layer model.
 * @param {google.maps.Map} map The map on which to display this tile layer.
 * @param {cm.AppState} appState The application state model.
 * @param {cm.MetadataModel} metadataModel The metadata model.  If the layer is
 *     specified with a tile index, the TileOverlay will update the metadata
 *     update_time field using the update_time in the tile index.
 * @constructor
 * @extends google.maps.MVCObject
 */
cm.TileOverlay = function(layer, map, appState, metadataModel) {
  google.maps.MVCObject.call(this);

  /**
   * @type {cm.AppState}
   * @private
   */
  this.appState_ = appState;

  /**
   * @type {cm.MetadataModel}
   * @private
   */
  this.metadataModel_ = metadataModel;

  /**
   * @type {google.maps.Map}
   * @private
   */
  this.map_ = map;

  /**
   * @type {cm.ProxyTileMapType}
   * @private
   */
  this.mapType_ = null;

  /**
   * Tracks whether or not this layer is currently displayed on the map.
   * @type {boolean}
   * @private
   */
  this.onMap_ = false;

  /**
   * Tracks the last time tiles were loaded for the current viewport.
   * @type {number}
   * @private
   */
  this.lastTilesLoadedMs_ = 0;

  /**
   * The bounds of this map.  Initialized in init_().
   * @type {google.maps.LatLngBounds}
   * @private
   */
  this.bounds_ = new google.maps.LatLngBounds();

  /**
   * The URL pattern for requesting tiles, using either Google or Bing tile
   * coordinates.
   * Google tile coordinates are indexed by X,Y,Z and require a
   *   pattern like http://foo/{X}_{Y}_{Z}.jpg, where {X}, {Y}, and {Z} are
   *   replaced dynamically. See
   *   https://developers.google.com/maps/documentation/javascript/
   *     maptypes#TileCoordinates
   * Bing tile coordinates are indexed by quadkeys. See
   *   http://msdn.microsoft.com/en-us/library/bb259689.aspx
   * @type {?string}
   * @private
   */
  this.tileUrlPattern_ = null;

  /**
   * The new tile url pattern to use when the current set of tiles
   * has finished loading.  This helps prevent a viewport from containing
   * tiles from tile sets at different epochs.
   * @type {?string}
   * @private
   */
  this.nextTileUrlPattern_ = null;

  /**
   * If the url is a tile index, this is the cross-domain channel from
   * which to fetch tile index updates for periodic refreshing.
   * @type {?goog.net.Jsonp}
   * @private
   */
  this.tileIndexFetcher_ = null;

  /**
   * Interval ID for canceling the tile index refresh.
   * @type {?number}
   * @private
   */
  this.intervalId_ = null;

  /**
   * The object used to cancel the tile index request.
   * @type {?Object}
   * @private
   */
  this.requestDescriptor_ = null;

  /**
   * @type {cm.LayerModel}
   * @private
   */
  this.layer_ = layer;

  /**
   * To be populated if bounds are specified.
   * @type {?string}
   * @private
   */
  this.boundsString_ = null;

  /**
   * Minimum zoom at which tiles are visible. If NaN, visible at all
   * levels less than or equal to this.maxZoom_.
   * @type {number}
   * @private
   */
  this.minZoom_ = NaN;

  /**
   * Maximum zoom at which tiles are visible. If NaN, visible at all
   * levels greater than or equal to this.minZoom_.
   * @type {number}
   * @private
   */
  this.maxZoom_ = NaN;

  /**
   * The map's projection, for computing point coordinates to LatLngs;
   * populated when the map finishes initialising.
   * @type {google.maps.Projection}
   * @private
   */
  this.projection_ = null;

  /**
   * The type of tile coordinates used for constructing the tile URL.
   * @type {cm.LayerModel.TileCoordinateType}
   * @private
   */
  this.tileCoordinateType_ = /** @type cm.LayerModel.TileCoordinateType */(
      layer.get('tile_coordinate_type'));

  /**
   * Whether to replace replace all Google-style tiles that are not on the
   * edge of the layer's bounding box with .jpg tiles so that the border
   * tiles are transparent and the inside tiles are compressed.
   * @type {boolean}
   * @private
   */
  this.isHybrid_ = /** @type boolean */(layer.get('is_hybrid'));

  /**
   * @type {cm.LatLonBox}
   * @private
   */
  this.viewport_ = /** @type cm.LatLonBox */(layer.get('viewport')) ||
      cm.LatLonBox.ENTIRE_MAP;

  // To be populated if bounds are specified
  /**
   * @type {?string}
   */
  this.bounds_string = null;

  /**
   * @type {number}
   */
  this.minZoom = NaN;

  /**
   * @type {number}
   */
  this.maxZoom = NaN;

  /**
   * @type {boolean}
   * @private
   */
  this.initDone_ = false;

  this.bindTo('type', layer);
  this.bindTo('url', layer);
  this.bindTo('url_is_tile_index', layer);
  this.bindTo('wms_layers', layer);

  var layerBounds = layer.get('bounds');
  if (layerBounds) {
    this.boundsString_ = /** @type {string} */(layerBounds['coords']);
    this.minZoom_ = parseInt(layerBounds['min_zoom'], 10);
    this.maxZoom_ = parseInt(layerBounds['max_zoom'], 10);

    if (layerBounds['display_bounds']) {
      /**
       * A polygon that is rendered around the imagery for better
       * discoverability.
       * @type {google.maps.Polygon}
       * @private
       */
      this.outline_ = new google.maps.Polygon(
          /** @type {google.maps.PolygonOptions} */({
        fillOpacity: 0,
        strokeColor: '#ff0000',
        strokeWeight: 1,
        clickable: false
      }));
    }
  }

  cm.events.onChange(this, ['url', 'wms_layers'],
                     this.updateWmsTilesetId_, this);
  this.updateWmsTilesetId_();
  cm.events.onChange(this, ['url_is_tile_index', 'wms_tileset_id'],
                     this.updateTileUrlPattern_, this);
  this.updateTileUrlPattern_();

  // Try to initialize the layer, and if unsuccessful, set up a listener to
  // retry until the projection is valid.
  this.initialize_();
  if (!this.initDone_) {
    var token = cm.events.listen(map, 'projection_changed', function() {
      this.initialize_();
      if (this.projection_) {
        // Once we have a valid projection, stop listening for changes even
        // if the initialization wasn't successful due to an invalid
        // tile URL pattern. initialize_() will be called again when
        // this.tileUrlPattern_ is set.
        cm.events.unlisten(token);
      }
    }, this);
  }
};
goog.inherits(cm.TileOverlay, google.maps.MVCObject);

/**
 * If the map's projection object and the tile URL pattern are ready, finish
 * initializing the overlay.
 * @this {cm.TileOverlay}
 * @private
 */
cm.TileOverlay.prototype.initialize_ = function() {
  if (this.initDone_) {
    return;
  }
  // We only support the map's initial projection.  If the map's projection
  // changes, we would need to refresh everything - including the imagery.
  if (!this.projection_ && this.map_) {
    this.projection_ = this.map_.getProjection();
  }
  // We can only finish initializing if we have both a projection and a tile url
  // pattern.
  if (this.projection_ && this.tileUrlPattern_) {
    // Define the bounding box to intersect with requested tile coordinates
    // when determining whether to fetch tiles. Also optionally drawn on
    // the map for content discoverability.
    var boundingBox;
    if (this.boundsString_) {
      boundingBox = cm.TileOverlay.normalizeCoords(this.boundsString_);
      for (var i = 0; i < boundingBox.length; ++i) {
        this.bounds_.extend(boundingBox[i]);
      }
    } else {
      // Until MapRoot layers include something akin to a 'bounds' field,
      // use the viewport as a poor approximation for avoiding unnecessary
      // tile requests. Since we still use the intersect functions in
      // geometry.js, the polygon coordinates must be provided in
      // counter-clockwise order.
      var n = this.viewport_.getNorth();
      var s = this.viewport_.getSouth();
      var e = this.viewport_.getEast();
      var w = this.viewport_.getWest();
      boundingBox = [new google.maps.LatLng(s, w), new google.maps.LatLng(s, e),
                     new google.maps.LatLng(n, e), new google.maps.LatLng(n, w),
                     new google.maps.LatLng(s, w)];
      // For tile layers with no explicit bounds, set this to null so
      // that getDefaultViewport() returns null.
      this.bounds_ = null;
    }

    this.mapType_ = this.initializeImageMapType_(boundingBox);
    if (this.outline_) {
      this.outline_.setPath(boundingBox);
    }

    cm.events.onChange(this.appState_, 'layer_opacities', this.updateOpacity_,
                       this);
    this.updateOpacity_();

    if (this.onMap_) {
      this.map_.overlayMapTypes.push(this.mapType_);
    }
    this.initDone_ = true;
  }
};

/**
 * Updates the layer opacity according to the application state model.
 * @private
 */
cm.TileOverlay.prototype.updateOpacity_ = function() {
  var opacities = this.appState_.get('layer_opacities') || {};
  var id = /** @type {string} */(this.layer_.get('id'));
  this.mapType_.set('opacity', id in opacities ? opacities[id] / 100 : 1.0);
};

/**
 * Converts the coordinates string into an array of LatLngs.
 * @param {string} coordString String in the format "lng1,lat1 lng2,lat2".
 * @return {Array.<google.maps.LatLng>} An array of LatLngs.
 */
cm.TileOverlay.normalizeCoords = function(coordString) {
  var outputCoordArray = [];
  var splitSpaces = String(coordString).split(' ');
  var splitSpace;
  for (splitSpace in splitSpaces) {
    var splitCommas = splitSpaces[splitSpace].split(',');
    var lng = splitCommas[0];
    var lat = splitCommas[1];
    if (lat != undefined && lng != undefined) {
      outputCoordArray.push(new google.maps.LatLng(parseFloat(lat),
                                                   parseFloat(lng)));
    }
  }
  return outputCoordArray;
};

/**
 * @param {Array.<google.maps.LatLng>} boundingBox The box used to determine
 *     whether or not to request a tile.
 * @return {cm.ProxyTileMapType} The image map type object.
 * @private
 */
cm.TileOverlay.prototype.initializeImageMapType_ = function(boundingBox) {
  var mapTypeOptions = {
    getTileUrl: goog.bind(this.getTileUrl_, this, boundingBox, this.isHybrid_),
    tileSize: new google.maps.Size(256, 256)
  };

  return new cm.ProxyTileMapType(mapTypeOptions);
};

/**
 * @param {Array.<google.maps.LatLng>} boundingBox The box used to determine
 *     whether or not to request a tile.
 * @param {boolean} isHybrid If true, the file extension for Google tiles is
 *     replaced with .png along the edge and .jpg inside so that the border
 *     tiles are transparent and the inside tiles are compressed.
 * @param {google.maps.Point} coord The tile coordinates.
 * @param {number} zoom The map zoom level.
 * @return {?string} The URL of the tile to fetch.
 * @private
 */
cm.TileOverlay.prototype.getTileUrl_ = function(boundingBox, isHybrid,
                                                coord, zoom) {
  this.lastTilesLoadedMs_ = new Date().getTime();
  var tileUrl = this.tileUrlPattern_;
  if (!tileUrl) return null;

  if (!isNaN(this.minZoom_) && zoom < this.minZoom_ ||
      !isNaN(this.maxZoom_) && zoom > this.maxZoom_) {
    return null;
  }

  // If we're zoomed out far enough, we get tiles outside a valid x range
  // because maps repeats the globe.
  var maxTilesHorizontal = 1 << zoom;
  var x = coord.x % maxTilesHorizontal;
  // Javascript modulo doesn't do the right thing for -ve numbers.
  if (x < 0) {
    x += maxTilesHorizontal;
  }
  var y = coord.y;
  coord.x = x;

  // Do not make any tile requests outside of the bounding box.
  var tileCorners = getTileRange(x, y, zoom);
  var boundaryOverlap = quadTileOverlap(applyProjection(
      this.projection_, boundingBox), tileCorners[0], tileCorners[1]);
  if (boundaryOverlap === Overlap.OUTSIDE) {
    return null;
  }
  if (this.tileCoordinateType_ === cm.LayerModel.TileCoordinateType.BING) {
    // Reference: http://msdn.microsoft.com/en-us/library/bb259689.aspx
    var quadKey = '';
    for (var i = zoom, mask = (1 << (zoom - 1)); i > 0; i--, mask >>= 1) {
      var cell = 0;   // the digit for this level
      if ((x & mask) != 0) cell++;
      if ((y & mask) != 0) cell += 2;
      quadKey += cell;
    }
    return tileUrl + '/' + quadKey;
  } else {
    // Google-style tile coordinates
    var url = tileUrl;
    // Replace parameters in Google tile URL, e.g. http://foo/{X}_{Y}_{Z}.jpg
    url = url.replace(/{X}/, x.toString()).
              replace(/{Y}/, y.toString()).
              replace(/{Z}/, zoom.toString());
    if (isHybrid) {
      url = url.replace(/\.\w*$/, boundaryOverlap === Overlap.INTERSECTING ?
                        '.png' : '.jpg');
    }
    // If loading from google static tile service, round robin between
    // mw1 and mw2 - browser will open 4 parallel connections to each.
    if (coord.x % 2 == 1) {
      url = url.replace('mw1.gstatic.com', 'mw2.gstatic.com');
    }
    return url;
  }
};

/**
 * Handles refreshing the tile index url.
 * @private
 */
cm.TileOverlay.prototype.refreshTileIndex_ = function() {
  if (!this.tileIndexFetcher_) {
    return;
  }
  this.requestDescriptor_ = this.tileIndexFetcher_.send(
      null, goog.bind(this.handleTileIndex_, this));
};

/**
 * Handles the callback that results from loading the tile index url in
 * refreshTileIndex_.
 * @param {Object} indexJson The new index JSON.
 * @private
 */
cm.TileOverlay.prototype.handleTileIndex_ = function(indexJson) {
  // Throw away any responses lingering after the layer has been changed
  // to a tile index.
  if (!this.get('url_is_tile_index')) {
    return;
  }

  var activeTileset = indexJson ? indexJson['active_tileset'] : null;
  if (!activeTileset) {
    return;
  }

  var updateTime = activeTileset['update_time'];
  this.metadataModel_.setUpdateTime(this.layer_, updateTime);

  var newTilesetUrl = activeTileset['url'];
  if (!this.tileUrlPattern_) {
    this.tileUrlPattern_ = newTilesetUrl;
  } else {
    this.nextTileUrlPattern_ = newTilesetUrl;
    this.updateIndexedTileUrlPattern_();
  }
  this.initialize_();
};

/**
 * Updates tileUrlPattern_ depending on whether or not the URL is a tile
 * index, in which case the tile index fetcher handler updates will update
 * it, and whether the layer type is WMS, in which case the pattern is
 * computed from the WMS tileset ID.
 * @private
 */
cm.TileOverlay.prototype.updateTileUrlPattern_ = function() {
  if (this.get('url_is_tile_index')) {
    var uri = new goog.Uri(JSON_PROXY_URL);
    uri.setParameterValue('url', this.get('url'));
    this.tileIndexFetcher_ = new goog.net.Jsonp(uri);
    // Refresh the tile index every so often to pick up changes
    this.intervalId_ = goog.global.setInterval(
        goog.bind(this.refreshTileIndex_, this), INDEX_REFRESH_PERIOD_MS);
    // Refresh the first time
    this.refreshTileIndex_();
  } else {
    // Clear the tile index fetcher.
    goog.global.clearInterval(this.intervalId_);
    this.intervalId_ = null;
    if (this.requestDescriptor_) {
      this.tileIndexFetcher_.cancel(this.requestDescriptor_);
    }
    this.tileIndexFetcher_ = null;
    this.requestDescriptor_ = null;
    this.nextTileUrlPattern_ = null;
    this.metadataModel_.setUpdateTime(this.layer_, null);
    if (this.get('type') !== cm.LayerModel.Type.WMS) {
      this.tileUrlPattern_ = /** @type string */(this.get('url'));
    } else {
      var tilesetId = /** @type string */(this.get('wms_tileset_id'));
      if (tilesetId) {
        this.tileUrlPattern_ = TILECACHE_URL + '/' + tilesetId +
            '/{Z}/{X}/{Y}.png';
        this.initialize_();
        // Display the tiles if the layer is enabled.
        if (this.onMap_) {
          this.setMap(null);
          this.setMap(this.map_);
        }
      }
    }
  }
};

/**
 * Updates tileUrlPattern_, redrawing the layer if there is an update.
 * @private
 */
cm.TileOverlay.prototype.updateIndexedTileUrlPattern_ = function() {
  if (!this.nextTileUrlPattern_) {
    return;
  }

  if (new Date().getTime() - this.lastTilesLoadedMs_ < MAX_TILE_LOAD_MS) {
    // Tiles are loading, wait until activity stops to swap in a new tile url.
    // Note we do this rather than listening for the map's tilesloaded event
    // because tilesloaded does not fire when only image overlay tiles change.
    goog.global.setTimeout(goog.bind(this.updateIndexedTileUrlPattern_, this),
                           MAX_TILE_LOAD_MS);
  } else {
    var isUpdate = this.nextTileUrlPattern_ != this.tileUrlPattern_;
    this.tileUrlPattern_ = this.nextTileUrlPattern_;
    this.nextTileUrlPattern_ = null;
    // Only redraw the layer if it's toggled on and there is an update.
    if (isUpdate && this.onMap_) {
      this.setMap(null);
      this.setMap(this.map_);
    }
  }
};

/**
 * Update the tileset ID needed to construct the URL from which to fetch tiles.
 * @private
 */
cm.TileOverlay.prototype.updateWmsTilesetId_ = function() {
  if (this.get('type') === cm.LayerModel.Type.WMS) {
    var wmsUrl = /** @type string */(this.get('url'));
    if (wmsUrl) {
      wmsUrl = wmsUrl.replace(/^\s+|\s+$/g, '');
    }
    var wmsLayers = /** @type Array.<string> */(this.get('wms_layers'));
    var wmsProjection = 'EPSG:3857';

    // TODO(romano): if there is significant latency due to waiting for the
    // config response, consider precomputing the tilesetId so that tile
    // requests can begin immediately.
    if (wmsUrl && wmsLayers && wmsLayers.length && wmsProjection) {
      // Query the server for this tileset ID and configure an entry
      // if it doesn't already exist.
      var postArgs = 'server_url=' + encodeURIComponent(wmsUrl) +
                     '&projection=' + encodeURIComponent(wmsProjection) +
                     '&layers=' + encodeURIComponent(wmsLayers.join(','));
      goog.net.XhrIo.send(TILESET_CONFIGURE_URL, goog.bind(function(e) {
        if (e.target.isSuccess()) {
          var tilesetId = e.target.getResponseJson();
          this.set('wms_tileset_id', tilesetId);
        }
      }, this), 'POST', postArgs);
    }
  }
};

/**
 * Add or remove this layer from this object's map overlay list, depending on
 * the value of the 'map' parameter.
 * @param {google.maps.Map} map The map to show this tile layer on, or null
 *     if the layer should be removed from this object's map. This parameter is
 *     actually ignored by Maps API, as a TileOverlay can only be shown on the
 *     map on which it was initialized.
 */
cm.TileOverlay.prototype.setMap = function(map) {
  var mapType = this.mapType_;
  if (map && !this.onMap_) {
    // Only push the overlay if initialize_() succeeded.
    if (this.initDone_) {
      this.map_.overlayMapTypes.push(mapType);
    }
  } else if (!map && this.onMap_) {
    var index = null;
    this.map_.overlayMapTypes.forEach(function(overlay, i) {
      if (overlay == mapType) {
        index = i;
      }
    });
    if (index != null) {
      this.map_.overlayMapTypes.removeAt(
          /** @type {number} */ (index));
    }
  }
  if (this.outline_) {
    this.outline_.setMap(map);
  }
  this.onMap_ = !!map;
};

/**
 * @return {google.maps.Map} Returns the map on which this TileOverlay is
 *     displayed, or null if it is not showing.
 */
cm.TileOverlay.prototype.getMap = function() {
  return this.onMap_ ? this.map_ : null;
};

/**
 * Returns the LatLngBounds object that shows the entire tile layer.  When the
 * user clicks on the "Zoom to" link, the map is fit to this bounds.
 * @return {google.maps.LatLngBounds} The layer's bounds.
 */
cm.TileOverlay.prototype.getDefaultViewport = function() {
  return this.bounds_;
};
