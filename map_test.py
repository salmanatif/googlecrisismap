#!/usr/bin/python
# Copyright 2012 Google Inc.  All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License"); you may not
# use this file except in compliance with the License.  You may obtain a copy
# of the License at: http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software distrib-
# uted under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES
# OR CONDITIONS OF ANY KIND, either express or implied.  See the License for
# specific language governing permissions and limitations under the License.

"""Tests for map.py."""

__author__ = 'shakusa@google.com (Steve Hakusa)'

import map  # pylint: disable=redefined-builtin
import model
import test_utils


class MapTest(test_utils.BaseTest):
  """Tests for the map.py request handlers."""

  def testGetClientConfig(self):
    """Confirms that GetClientConfig sets up the correct JS parameters."""

    analytics_id = 'US-foo'
    config = map.ClientConfig.Create(
        'goog-test',
        allowed_referer_domains=['google.org', 'cr.appspot.com'],
        hide_footer=True,
        hide_share_button=True,
        hide_my_location_button=True,
        allow_embed_map_callback=True,
        show_login=True,
        analytics_id=analytics_id,
        enable_editing=True)
    config.put()

    self.assertEquals({'hide_share_button': True,
                       'hide_my_location_button': True,
                       'hide_footer': True,
                       'allow_embed_map_callback': True,
                       'show_login': True,
                       'hide_google_plus_button': False,
                       'hide_facebook_button': False,
                       'hide_twitter_button': False,
                       'analytics_id': analytics_id,
                       'panel_side': 'right',
                       'panel_float': False,
                       'enable_editing': True,
                       'enable_metadata_pipeline': False,
                       'enable_osm_map_type': False,
                       'enable_osm_map_type_editing': False,
                       'enable_wms_layer_editing': False,
                       'minimal_map_controls': False,
                       'hide_panel_header': False},
                      config.AsDict())

    config_dict = config.AsDict()

    # Try invalid referers.
    self.assertEquals({}, map.GetClientConfig(None, None))
    self.assertEquals({}, map.GetClientConfig('', ''))
    self.assertEquals({}, map.GetClientConfig('goog-test', None))

    # Try referers that aren't allowed to use this config.
    self.assertEquals({}, map.GetClientConfig(
        'goog-test', 'http://foo.appspot.com'))
    self.assertEquals({}, map.GetClientConfig(
        'goog-test', 'http://fakegoogle.org'))
    # Try a nonexistent config.
    self.assertEquals({}, map.GetClientConfig(
        'goog-test2', 'http://cr.appspot.com'))

    # Try referers that should be allowed to use this config.
    self.assertEquals(config_dict, map.GetClientConfig(
        'goog-test', None, dev_mode=True))
    self.assertEquals(config_dict, map.GetClientConfig(
        'goog-test', 'http://cr.appspot.com'))
    self.assertEquals(config_dict, map.GetClientConfig(
        'goog-test', 'https://www.google.org'))

    # test that setting default overrides even without a referer domain.
    map.ClientConfig.Create('default', enable_editing=True).put()
    self.assertTrue(map.GetClientConfig(None, None)['enable_editing'])

  def testGetMapMenuItems(self):
    """Tests GetMapMenuItems()."""
    test_utils.BecomeAdmin()
    m1 = model.CatalogEntryModel(key_name='foo.com:m1', domain='foo.com',
                                 label='m1', title='Map 1', is_listed=True)
    m1.put()

    map_catalog = map.GetMapMenuItems('foo.com')
    self.assertEquals('Map 1', map_catalog[0]['title'])
    self.assertEquals('/crisismap/a/foo.com/m1', map_catalog[0]['url'])

  def testClientConfigOverride(self):
    """Verifies that query parameters can override client config settings."""
    test_utils.BecomeAdmin()
    config = map.GetConfig(test_utils.SetupRequest('/?dev=1&show_login=true'))
    self.assertEquals(True, config['show_login'])

  def testGetMapsApiClientId(self):
    """Tests the GetMapsApiClientId method."""
    self.assertEquals('google-crisis-response',
                      map.GetMapsApiClientId('google.com'))
    self.assertEquals('google-crisis-response',
                      map.GetMapsApiClientId('google.org'))
    self.assertEquals('google-crisis-response',
                      map.GetMapsApiClientId('foo.google.com'))
    self.assertEquals('google-crisis-response',
                      map.GetMapsApiClientId('foo.google.com:8000'))
    self.assertEquals('', map.GetMapsApiClientId('localhost'))
    self.assertEquals('', map.GetMapsApiClientId('localhost:8000'))
    self.assertEquals('', map.GetMapsApiClientId('foo.appspot.com'))
    self.assertEquals('', map.GetMapsApiClientId('foo.googleplex.com'))

  def testMapsApiUrlI18n(self):
    """Verifies that language and region are set correctly for the Maps API."""
    config = map.GetConfig(test_utils.SetupRequest('/'))
    self.assertTrue('language=en' in config['maps_api_url'])
    self.assertFalse('region=' in config['maps_api_url'])

    config = map.GetConfig(test_utils.SetupRequest('/?hl=ja'))
    self.assertTrue('language=ja' in config['maps_api_url'])
    self.assertFalse('region=' in config['maps_api_url'])

    config = map.GetConfig(test_utils.SetupRequest('/?hl=th&gl=IN'))
    self.assertTrue('language=th' in config['maps_api_url'])
    self.assertTrue('region=IN' in config['maps_api_url'])

if __name__ == '__main__':
  test_utils.main()
