#!/usr/bin/env node
/**
 * Fetches EV charger data from Open Charge Map and merges with existing
 * NREL data in data/chargers.json. Adds missing stations and fills in
 * missing power ratings from OCM where NREL data is incomplete.
 *
 * Usage:
 *   node scripts/merge-ocm.js <OCM_API_KEY>
 *
 * Get a free API key at: https://openchargemap.org/site/profile/register
 *
 * Run AFTER fetch-chargers.js (NREL is the primary source, OCM supplements it).
 */

var https = require('https');
var fs = require('fs');
var path = require('path');

var OCM_KEY = process.argv[2];
if (!OCM_KEY) {
  console.error('Usage: node scripts/merge-ocm.js <OCM_API_KEY>');
  console.error('Get a free key at: https://openchargemap.org/site/profile/register');
  process.exit(1);
}

var DATA_PATH = path.join(__dirname, '..', 'data', 'chargers.json');

// Alberta bounding box
var ALBERTA = {
  latMin: 49.0,
  latMax: 60.0,
  lngMin: -120.0,
  lngMax: -110.0,
};

// OCM connection type IDs → our connector names
var OCM_CONNECTOR_MAP = {
  1: 'J1772',       // Type 1 (J1772)
  2: 'CHAdeMO',     // CHAdeMO
  25: 'CCS',        // Type 2 (CCS)
  32: 'CCS',        // CCS (SAE Combo)
  33: 'CCS',        // CCS Type 2
  27: 'NACS',       // Tesla Supercharger
  30: 'NACS',       // Tesla (Model S/X)
};

// OCM status type IDs
var OCM_STATUS_OPERATIONAL = [50, 75]; // 50=Operational, 75=Partly Operational

// OCM operator IDs → network names (common ones)
var OCM_OPERATOR_MAP = {
  1: 'ChargePoint Network',
  2: 'Blink',
  3: 'SemaCharge',
  5: 'Tesla',
  23: 'FLO',
  89: 'Electrify Canada',
  3534: 'PETROCAN',
};

console.log('Fetching Alberta EV charger data from Open Charge Map...');

// OCM API: fetch all stations in Alberta bounding box
// Using multiple requests to handle pagination
var allOcmStations = [];
var pageSize = 500;

function fetchOcmPage(offset) {
  // Use center of Alberta with large radius instead of bounding box
  // Edmonton ~53.5, -113.5, radius 500km covers all of Alberta
  var params = [
    'key=' + OCM_KEY,
    'output=json',
    'countrycode=CA',
    'latitude=53.5',
    'longitude=-113.5',
    'distance=500',
    'distanceunit=KM',
    'maxresults=' + pageSize,
    'offset=' + offset,
    'compact=true',
    'verbose=false',
    'statustypeid=50,75',  // Operational + Partly Operational
    'usagetypeid=1,4,5,7', // Public, Public (membership required), Public (pay at location), Public (notice required)
  ].join('&');

  var url = 'https://api.openchargemap.io/v3/poi/?' + params;

  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode !== 200) {
          reject(new Error('OCM API error: HTTP ' + res.statusCode + ' - ' + body.slice(0, 200)));
          return;
        }
        try {
          var data = JSON.parse(body);
          resolve(data);
        } catch (e) {
          reject(new Error('Failed to parse OCM response: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

function convertOcmStation(s) {
  var addr = s.AddressInfo;
  if (!addr || !addr.Latitude || !addr.Longitude) return null;

  // Check it's actually in Alberta
  if (addr.Latitude < ALBERTA.latMin || addr.Latitude > ALBERTA.latMax) return null;
  if (addr.Longitude < ALBERTA.lngMin || addr.Longitude > ALBERTA.lngMax) return null;

  // Parse connections for connector types, power, and counts
  var connectorTypes = [];
  var connectorSet = {};
  var maxPowerKw = null;
  var dcFastNum = 0;
  var level2Num = 0;
  var level1Num = 0;
  var totalConnectors = 0;

  if (s.Connections && Array.isArray(s.Connections)) {
    for (var c = 0; c < s.Connections.length; c++) {
      var conn = s.Connections[c];
      var qty = conn.Quantity || 1;
      totalConnectors += qty;

      // Map connector type
      var typeId = conn.ConnectionTypeID;
      var typeName = OCM_CONNECTOR_MAP[typeId] || null;
      if (typeName && !connectorSet[typeName]) {
        connectorSet[typeName] = true;
        connectorTypes.push(typeName);
      }

      // Power
      if (conn.PowerKW && (maxPowerKw === null || conn.PowerKW > maxPowerKw)) {
        maxPowerKw = conn.PowerKW;
      }

      // Count by level
      var levelId = conn.LevelID;
      if (levelId === 3) {
        dcFastNum += qty;  // Level 3 = DC Fast
      } else if (levelId === 2) {
        level2Num += qty;
      } else {
        level1Num += qty;
      }
    }
  }

  if (totalConnectors === 0) return null;

  // Determine charger level
  var chargerLevel = dcFastNum > 0 ? 'DCFC' : (level2Num > 0 ? 'L2' : 'L1');

  // Network/operator
  var network = 'Non-Networked';
  if (s.OperatorID && OCM_OPERATOR_MAP[s.OperatorID]) {
    network = OCM_OPERATOR_MAP[s.OperatorID];
  } else if (s.OperatorInfo && s.OperatorInfo.Title) {
    network = s.OperatorInfo.Title;
  }

  var addressParts = [addr.AddressLine1, addr.Town, addr.StateOrProvince].filter(Boolean);

  return {
    id: 'ocm-' + s.ID,
    name: addr.Title || 'Unknown',
    lat: addr.Latitude,
    lng: addr.Longitude,
    address: addressParts.join(', '),
    network: network,
    connectorCount: totalConnectors,
    connectorTypes: connectorTypes,
    chargerLevel: chargerLevel,
    dcFastNum: dcFastNum,
    level2Num: level2Num,
    level1Num: level1Num,
    maxPowerKw: maxPowerKw,
    status: 'operational',
  };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function main() {
  // Fetch all pages from OCM
  var offset = 0;
  var MAX_STATIONS = 5000; // Safety cap
  while (true) {
    var page = await fetchOcmPage(offset);
    if (!page || page.length === 0) break;
    allOcmStations = allOcmStations.concat(page);
    console.log('  Fetched ' + allOcmStations.length + ' stations so far...');
    if (page.length < pageSize) break;
    if (allOcmStations.length >= MAX_STATIONS) {
      console.log('  Hit safety cap of ' + MAX_STATIONS + ' stations');
      break;
    }
    offset += pageSize;
    // Rate limit: small delay between pages
    await new Promise(function (r) { setTimeout(r, 500); });
  }

  console.log('Total OCM stations fetched: ' + allOcmStations.length);

  // Convert OCM stations
  var ocmConverted = [];
  for (var i = 0; i < allOcmStations.length; i++) {
    var converted = convertOcmStation(allOcmStations[i]);
    if (converted) ocmConverted.push(converted);
  }
  console.log('Valid OCM stations in Alberta: ' + ocmConverted.length);

  // Load existing NREL data
  var existing = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  console.log('Existing NREL stations: ' + existing.length);

  // Duplicate detection: OCM station is a duplicate if an NREL station exists
  // within 200m on the same network, OR within 50m on any network (same physical site).
  // OCM network names are often wrong, so 50m is a strong location match regardless of network.
  var SAME_NETWORK_THRESHOLD_KM = 0.2;
  var ANY_NETWORK_THRESHOLD_KM = 0.15; // 150m — OCM often has wrong network names for same physical station

  var added = 0;
  var updatedPower = 0;
  var duplicates = 0;

  for (var o = 0; o < ocmConverted.length; o++) {
    var ocm = ocmConverted[o];
    var isDuplicate = false;

    for (var e = 0; e < existing.length; e++) {
      var dist = haversineKm(ocm.lat, ocm.lng, existing[e].lat, existing[e].lng);
      var sameNetwork = ocm.network === existing[e].network;
      if ((sameNetwork && dist < SAME_NETWORK_THRESHOLD_KM) || dist < ANY_NETWORK_THRESHOLD_KM) {
        isDuplicate = true;

        // Fill in missing power rating from OCM
        if (!existing[e].maxPowerKw && ocm.maxPowerKw) {
          existing[e].maxPowerKw = ocm.maxPowerKw;
          updatedPower++;
        }

        // Fill in missing connector types
        if (ocm.connectorTypes.length > existing[e].connectorTypes.length) {
          existing[e].connectorTypes = ocm.connectorTypes;
        }

        break;
      }
    }

    if (isDuplicate) {
      duplicates++;
    } else {
      // New station not in NREL — add it
      existing.push(ocm);
      added++;
    }
  }

  // Sort by name
  existing.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });

  // Write merged output
  fs.writeFileSync(DATA_PATH, JSON.stringify(existing, null, 2), 'utf8');

  console.log('\nMerge complete!');
  console.log('  Duplicates found: ' + duplicates);
  console.log('  New stations added: ' + added);
  console.log('  Power ratings filled in: ' + updatedPower);
  console.log('  Total stations: ' + existing.length);
  console.log('  With power ratings: ' + existing.filter(function (s) { return s.maxPowerKw; }).length);
  console.log('  Output: ' + DATA_PATH);
}

main().catch(function (err) {
  console.error('Error:', err.message);
  process.exit(1);
});
