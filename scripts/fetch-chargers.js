#!/usr/bin/env node
/**
 * Fetches EV charger data from NREL AFDC API for Alberta, Canada.
 * Outputs to data/chargers.json in the format expected by the app.
 *
 * Usage:
 *   node scripts/fetch-chargers.js [API_KEY]
 *
 * Get a free API key at: https://developer.nrel.gov/signup/
 * Or use DEMO_KEY for testing (rate-limited to 30 req/hour).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

var API_KEY = process.argv[2] || 'DEMO_KEY';
var OUTPUT_PATH = path.join(__dirname, '..', 'data', 'chargers.json');

// NREL AFDC API - fetch all electric stations in Alberta, Canada
var params = [
  'api_key=' + API_KEY,
  'fuel_type=ELEC',
  'state=AB',
  'country=CA',
  'status=E,T',         // E=open, T=temporarily unavailable
  'access=public',
  'limit=all',
].join('&');

var url = 'https://developer.nrel.gov/api/alt-fuel-stations/v1.json?' + params;

console.log('Fetching Alberta EV charger data from NREL AFDC...');
console.log('API Key: ' + (API_KEY === 'DEMO_KEY' ? 'DEMO_KEY (rate-limited)' : API_KEY.slice(0, 6) + '...'));

https.get(url, function (res) {
  var body = '';
  res.on('data', function (chunk) { body += chunk; });
  res.on('end', function () {
    if (res.statusCode !== 200) {
      console.error('API error: HTTP ' + res.statusCode);
      console.error(body.slice(0, 500));
      process.exit(1);
    }

    var data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      console.error('Failed to parse API response:', e.message);
      process.exit(1);
    }

    if (!data.alt_fuel_station || !data.alt_fuel_station.length) {
      // Try alternate response key
      var stations = data.alt_fuel_station || data.fuel_stations || [];
      if (!stations.length) {
        console.error('No stations found in response. Keys:', Object.keys(data));
        process.exit(1);
      }
    }

    var stations = data.alt_fuel_station || data.fuel_stations || [];
    console.log('Received ' + stations.length + ' stations from NREL');

    // Convert to our app format
    var converted = [];
    var skipped = 0;

    for (var i = 0; i < stations.length; i++) {
      var s = stations[i];

      // Skip stations without coordinates
      if (!s.latitude || !s.longitude) {
        skipped++;
        continue;
      }

      // Determine charger level
      var hasDCFC = (s.ev_dc_fast_num || 0) > 0;
      var hasL2 = (s.ev_level2_evse_num || 0) > 0;
      var hasL1 = (s.ev_level1_evse_num || 0) > 0;
      var chargerLevel = hasDCFC ? 'DCFC' : (hasL2 ? 'L2' : 'L1');

      // Parse connector types
      var connectorTypes = [];
      if (s.ev_connector_types && Array.isArray(s.ev_connector_types)) {
        connectorTypes = s.ev_connector_types.map(function (c) {
          // Normalize NREL connector names to our format
          var map = {
            'CHADEMO': 'CHAdeMO',
            'J1772': 'J1772',
            'J1772COMBO': 'CCS',
            'TESLA': 'NACS',
            'NEMA_5_15': 'NEMA 5-15',
            'NEMA_14_50': 'NEMA 14-50',
            'NEMA_5_20': 'NEMA 5-20',
          };
          return map[c] || c;
        });
      }

      // Extract max power (kW) from ev_charging_units nested structure
      var maxPowerKw = null;
      if (s.ev_charging_units && Array.isArray(s.ev_charging_units)) {
        for (var u = 0; u < s.ev_charging_units.length; u++) {
          var unit = s.ev_charging_units[u];
          if (unit.connectors) {
            // connectors is an object keyed by connector type
            var connKeys = Object.keys(unit.connectors);
            for (var k = 0; k < connKeys.length; k++) {
              var conn = unit.connectors[connKeys[k]];
              if (conn.power_kw && (maxPowerKw === null || conn.power_kw > maxPowerKw)) {
                maxPowerKw = conn.power_kw;
              }
            }
          }
        }
      }
      // Fallback to top-level fields if available
      if (!maxPowerKw && s.ev_dc_fast_max_kw) {
        maxPowerKw = s.ev_dc_fast_max_kw;
      }

      // Network name cleanup
      var network = s.ev_network || 'Non-Networked';

      // Total connector count
      var connectorCount = (s.ev_dc_fast_num || 0) + (s.ev_level2_evse_num || 0) + (s.ev_level1_evse_num || 0);
      if (connectorCount === 0) {
        skipped++;
        continue;
      }

      // Map status
      var status = 'operational';
      if (s.status_code === 'T') status = 'temporarily_unavailable';

      converted.push({
        id: 'nrel-' + s.id,
        name: s.station_name || 'Unknown',
        lat: s.latitude,
        lng: s.longitude,
        address: [s.street_address, s.city, s.state].filter(Boolean).join(', '),
        network: network,
        connectorCount: connectorCount,
        connectorTypes: connectorTypes,
        chargerLevel: chargerLevel,
        dcFastNum: s.ev_dc_fast_num || 0,
        level2Num: s.ev_level2_evse_num || 0,
        level1Num: s.ev_level1_evse_num || 0,
        maxPowerKw: maxPowerKw,
        status: status,
      });
    }

    // Deduplicate: same network within 200m, OR any network within 50m (exact same spot).
    // Keeps the station with the most connectors / highest power.
    converted.sort(function (a, b) { return b.connectorCount - a.connectorCount || (b.maxPowerKw || 0) - (a.maxPowerKw || 0); });
    var deduped = [];
    for (var d = 0; d < converted.length; d++) {
      var isDup = false;
      for (var e = 0; e < deduped.length; e++) {
        var dLat = Math.abs(converted[d].lat - deduped[e].lat);
        var dLng = Math.abs(converted[d].lng - deduped[e].lng);
        var sameNetwork = converted[d].network === deduped[e].network;
        // Same network within 200m = duplicate
        // Any network within 50m = duplicate (same physical site, misattributed network)
        if ((sameNetwork && dLat < 0.002 && dLng < 0.002) || (dLat < 0.0005 && dLng < 0.0005)) {
          isDup = true;
          break;
        }
      }
      if (!isDup) deduped.push(converted[d]);
    }
    var dupCount = converted.length - deduped.length;
    converted = deduped;

    // Sort by name for consistency
    converted.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    // Write output
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(converted, null, 2), 'utf8');

    console.log('\nDone!');
    console.log('  Stations saved: ' + converted.length);
    console.log('  Duplicates removed: ' + dupCount);
    console.log('  Skipped (no coords/connectors): ' + skipped);
    console.log('  With DCFC: ' + converted.filter(function (s) { return s.dcFastNum > 0; }).length);
    console.log('  With power ratings: ' + converted.filter(function (s) { return s.maxPowerKw; }).length);
    console.log('  Output: ' + OUTPUT_PATH);
  });
}).on('error', function (err) {
  console.error('Request failed:', err.message);
  process.exit(1);
});
