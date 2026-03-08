(function () {
  'use strict';

  // ============================================================
  // MAP
  // ============================================================
  var ALBERTA_CENTER = [53.93, -116.58];
  var ALBERTA_ZOOM = 6;
  var CANADA_CENTER = [56.13, -106.35];
  var CANADA_ZOOM = 4;
  var map;

  function initMap() {
    map = L.map('map', {
      center: ALBERTA_CENTER,
      zoom: ALBERTA_ZOOM,
      zoomControl: true,
      preferCanvas: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 18,
    }).addTo(map);
  }

  function viewAlberta() { map.setView(ALBERTA_CENTER, ALBERTA_ZOOM); }
  function viewCanada()  { map.setView(CANADA_CENTER, CANADA_ZOOM); }

  // ============================================================
  // TEMPERATURE
  // ============================================================
  function getRangeFactor(tempC) {
    if (tempC >= 20) return 1.0;
    if (tempC <= -20) return 0.50;
    // Linear from 100% at 20°C to 50% at -20°C
    return 1.0 - (20 - tempC) * (0.5 / 40);
  }

  // ============================================================
  // HIGHWAY SPEED
  // ============================================================
  // Range loss: 0% at 90 km/h, scaling up to 28% at 140 km/h
  // Quadratic curve fits real-world aero drag data
  // Lookup table based on real-world EV highway data
  // Aero drag scales with speed squared, so losses climb fast
  var SPEED_LOSS = {
    90: 0, 95: 0.05, 100: 0.10, 105: 0.15, 110: 0.20,
    115: 0.24, 120: 0.28, 125: 0.33, 130: 0.38, 135: 0.43, 140: 0.48
  };

  function getSpeedFactor(speedKmh) {
    if (speedKmh <= 90) return 1.0;
    if (speedKmh >= 140) return 1.0 - SPEED_LOSS[140];
    // Interpolate between table entries
    var lower = Math.floor(speedKmh / 5) * 5;
    var upper = lower + 5;
    var t = (speedKmh - lower) / 5;
    var lossLow = SPEED_LOSS[lower] || 0;
    var lossHigh = SPEED_LOSS[upper] || lossLow;
    return 1.0 - (lossLow + (lossHigh - lossLow) * t);
  }

  function getAdjustedRange(baseRangeKm, tempC) {
    return baseRangeKm * getRangeFactor(tempC) * getSpeedFactor(currentSpeed);
  }

  // ============================================================
  // CHARGERS
  // ============================================================
  var allStations = [];  // full dataset
  var circleLayer = null;
  var markerLayer = null;

  // Priority: higher number wins when multiple stations cover same area
  var RISK_PRIORITY = { red: 1, yellow: 2, blue: 3, green: 4 };
  var RISK_RGB = {
    red:    [255, 65, 54],
    yellow: [255, 220, 0],
    green:  [46, 204, 64],
    blue:   [74, 158, 255],
  };
  var RISK_COLORS = {
    red:    { fillColor: '#ff4136' },
    yellow: { fillColor: '#ffdc00' },
    green:  { fillColor: '#2ecc40' },
    blue:   { fillColor: '#4a9eff' },
  };

  function getRiskLevel(station) {
    if (station.chargerLevel === 'L2') return 'blue';
    if (station.connectorCount >= 3) return 'green';
    if (station.connectorCount === 2) return 'yellow';
    return 'red';
  }

  async function loadChargers() {
    var resp = await fetch('data/chargers.json');
    if (!resp.ok) throw new Error('Failed to load chargers: ' + resp.status);
    allStations = await resp.json();
    return allStations;
  }

  // Filter stations based on current toggle state
  function getVisibleStations() {
    return allStations.filter(function (s) {
      if (s.chargerLevel === 'L2' && !showL2) return false;
      return true;
    });
  }

  // Get stations that count toward coverage (visible + not dimmed by safe route)
  function getCoverageStations() {
    var visible = getVisibleStations();
    if (safeRoute) {
      return visible.filter(function (s) { return s.connectorCount >= 2; });
    }
    return visible;
  }

  // Precomputed station data for the coverage tile layer
  var coverageStationData = []; // [{lat, lng, risk, priority, rgb}]
  var currentRadiusKm = 160;

  // Custom canvas tile layer: each pixel gets exactly one color (highest priority)
  var CoverageTileLayer = L.GridLayer.extend({
    createTile: function (coords) {
      var tile = document.createElement('canvas');
      var size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;

      var ctx = tile.getContext('2d');
      var stationData = coverageStationData;
      var radiusKm = currentRadiusKm;
      var opacity = overlayOpacity;

      if (stationData.length === 0) return tile;

      // Convert radius to approximate degrees for fast comparison
      var threshDeg = radiusKm / 111.32;
      var threshSq = threshDeg * threshDeg;

      // Get tile bounds in lat/lng
      var nwPoint = coords.scaleBy(size);
      var sePoint = nwPoint.add(size);
      var nw = this._map.unproject(nwPoint, coords.z);
      var se = this._map.unproject(sePoint, coords.z);

      // Pre-filter: only stations whose circle could intersect this tile
      var tilePadLat = threshDeg;
      var tilePadLng = threshDeg / Math.cos(((nw.lat + se.lat) / 2) * Math.PI / 180);
      var nearby = [];
      for (var i = 0; i < stationData.length; i++) {
        var s = stationData[i];
        if (s.lat >= se.lat - tilePadLat && s.lat <= nw.lat + tilePadLat &&
            s.lng >= nw.lng - tilePadLng && s.lng <= se.lng + tilePadLng) {
          nearby.push(s);
        }
      }

      if (nearby.length === 0) return tile;

      // Sample every STEP pixels for performance, fill blocks
      var STEP = 4;
      var imgData = ctx.createImageData(size.x, size.y);
      var data = imgData.data;

      var latRange = nw.lat - se.lat;
      var lngRange = se.lng - nw.lng;
      var alphaVal = Math.round(opacity * 255);

      for (var py = 0; py < size.y; py += STEP) {
        var lat = nw.lat - (py / size.y) * latRange;
        var cosLat = Math.cos(lat * Math.PI / 180);

        for (var px = 0; px < size.x; px += STEP) {
          var lng = nw.lng + (px / size.x) * lngRange;

          // Find highest priority station covering this point
          var bestPriority = 0;
          var bestRgb = null;

          for (var si = 0; si < nearby.length; si++) {
            var st = nearby[si];
            if (st.priority <= bestPriority) continue;
            var dLat = st.lat - lat;
            var dLng = (st.lng - lng) * cosLat;
            if (dLat * dLat + dLng * dLng <= threshSq) {
              bestPriority = st.priority;
              bestRgb = st.rgb;
              if (bestPriority === 4) break; // can't do better than green
            }
          }

          if (bestRgb) {
            // Fill the STEP x STEP block
            for (var by = 0; by < STEP && py + by < size.y; by++) {
              for (var bx = 0; bx < STEP && px + bx < size.x; bx++) {
                var idx = ((py + by) * size.x + (px + bx)) * 4;
                data[idx]     = bestRgb[0];
                data[idx + 1] = bestRgb[1];
                data[idx + 2] = bestRgb[2];
                data[idx + 3] = alphaVal;
              }
            }
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);
      return tile;
    }
  });

  var coverageTileLayer = null;

  function drawCircles(radiusKm) {
    // Remove old layers
    if (coverageTileLayer) { map.removeLayer(coverageTileLayer); coverageTileLayer = null; }
    if (markerLayer) map.removeLayer(markerLayer);

    markerLayer = L.layerGroup();
    var visible = getVisibleStations();

    // Build station data for tile renderer
    coverageStationData = [];
    visible.forEach(function (station) {
      var risk = getRiskLevel(station);
      var dimmed = safeRoute && risk === 'red';
      if (!dimmed) {
        coverageStationData.push({
          lat: station.lat,
          lng: station.lng,
          risk: risk,
          priority: RISK_PRIORITY[risk],
          rgb: RISK_RGB[risk],
        });
      }
    });

    currentRadiusKm = radiusKm;

    // Add coverage tile layer
    coverageTileLayer = new CoverageTileLayer({ tileSize: 256 });
    coverageTileLayer.addTo(map);

    // Draw station markers on top
    visible.forEach(function (station) {
      var risk = getRiskLevel(station);
      var colors = RISK_COLORS[risk];
      var dimmed = safeRoute && risk === 'red';

      var marker = L.circleMarker([station.lat, station.lng], {
        radius: station.chargerLevel === 'L2' ? 4 : 6,
        color: '#fff',
        weight: 2,
        fillColor: colors.fillColor,
        fillOpacity: dimmed ? 0.2 : 1,
        opacity: dimmed ? 0.3 : 1,
      });

      marker.bindPopup(buildPopup(station, risk));
      markerLayer.addLayer(marker);
    });

    markerLayer.addTo(map);
  }

  function buildPopup(station, risk) {
    var warning = '';
    if (risk === 'red') {
      warning = '<div class="popup-warning">⚠ Single charger — have a backup plan</div>';
    }

    var statusLabel = station.status.replace('_', ' ');
    statusLabel = statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1);

    var connectorInfo = station.connectorTypes.length > 0
      ? station.connectorTypes.join(', ')
      : 'N/A';

    var portDetails = '';
    if (station.dcFastNum > 0) portDetails += station.dcFastNum + ' DC Fast';
    if (station.level2Num > 0) {
      if (portDetails) portDetails += ', ';
      portDetails += station.level2Num + ' L2';
    }

    return '<div class="popup-station">' +
      '<h3>' + station.name + '</h3>' +
      '<div class="popup-detail">' +
        '<strong>Address:</strong> ' + station.address + '<br>' +
        '<strong>Network:</strong> ' + station.network + '<br>' +
        '<strong>Level:</strong> ' + station.chargerLevel + '<br>' +
        '<strong>Ports:</strong> ' + portDetails + '<br>' +
        '<strong>Connectors:</strong> ' + connectorInfo + '<br>' +
        '<strong>Status:</strong> ' + statusLabel +
      '</div>' +
      warning +
    '</div>';
  }

  // ============================================================
  // VEHICLE RANGE (simple input)
  // ============================================================
  var baseRangeKm = 450;

  // ============================================================
  // COVERAGE
  // ============================================================
  var ALBERTA_POLYGON = [
    [49.0, -120.0], [49.0, -110.0],
    [52.0, -110.0], [54.0, -110.0],
    [56.0, -110.0], [58.0, -110.0],
    [60.0, -110.0],
    [60.0, -120.0],
    [58.0, -120.0], [56.0, -120.0],
    [54.0, -120.0], [52.0, -120.0],
  ];

  var GRID_STEP = 0.08;
  var albertaPoints = null;

  function generateAlbertaGrid() {
    if (albertaPoints) return albertaPoints;
    albertaPoints = [];
    for (var lat = 49.0; lat <= 60.0; lat += GRID_STEP) {
      for (var lng = -120.0; lng <= -110.0; lng += GRID_STEP) {
        if (pointInPolygon(lat, lng, ALBERTA_POLYGON)) {
          albertaPoints.push([lat, lng]);
        }
      }
    }
    return albertaPoints;
  }

  function pointInPolygon(lat, lng, polygon) {
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var yi = polygon[i][0], xi = polygon[i][1];
      var yj = polygon[j][0], xj = polygon[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
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

  // Use squared-distance approximation for speed (avoid trig in inner loop)
  // Convert radius in km to approximate squared degree threshold
  function approxDistSq(lat1, lng1, lat2, lng2) {
    var dLat = lat2 - lat1;
    var dLng = (lng2 - lng1) * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180);
    return dLat * dLat + dLng * dLng;
  }

  var coverageTimer = null;

  function calculateCoverageAsync(radiusKm, callback) {
    var points = generateAlbertaGrid();
    var active = getCoverageStations();

    if (active.length === 0) { callback(0); return; }

    // Pre-compute threshold in degrees (approx: 1 deg lat ≈ 111.32 km)
    var threshDeg = radiusKm / 111.32;
    var threshSq = threshDeg * threshDeg;

    var covered = 0;
    var idx = 0;
    var chunkSize = 2000;

    function processChunk() {
      var end = Math.min(idx + chunkSize, points.length);
      for (; idx < end; idx++) {
        var pLat = points[idx][0], pLng = points[idx][1];
        for (var s = 0; s < active.length; s++) {
          if (approxDistSq(pLat, pLng, active[s].lat, active[s].lng) <= threshSq) {
            covered++;
            break;
          }
        }
      }
      if (idx < points.length) {
        coverageTimer = setTimeout(processChunk, 0);
      } else {
        callback((covered / points.length) * 100);
      }
    }

    processChunk();
  }

  // ============================================================
  // APP STATE & ORCHESTRATOR
  // ============================================================
  var currentTemp = 0;
  var currentSpeed = 120;
  var startingSoc = 0.80;
  var batteryReserve = 0.20;
  var rangeMode = 'roundtrip';
  var safeRoute = false;
  var showL2 = false;
  var overlayOpacity = 0.40;
  var refreshTimer = null;

  function getEffectiveRadius() {
    var adjusted = getAdjustedRange(baseRangeKm, currentTemp) * (startingSoc - batteryReserve);
    return rangeMode === 'roundtrip' ? adjusted / 2 : adjusted;
  }

  function refresh() {
    // Cancel any pending async work
    if (coverageTimer) { clearTimeout(coverageTimer); coverageTimer = null; }
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }

    var radiusKm = getEffectiveRadius();
    drawCircles(radiusKm);
    updateStationCount();

    // Debounce coverage calc — let the map render first
    document.getElementById('coverage-display').textContent = '...';
    refreshTimer = setTimeout(function () {
      calculateCoverageAsync(radiusKm, function (pct) {
        var el = document.getElementById('coverage-display');
        el.textContent = pct.toFixed(1) + '%';

        if (pct >= 70) el.style.color = 'var(--color-green)';
        else if (pct >= 40) el.style.color = 'var(--color-yellow)';
        else el.style.color = 'var(--color-red)';
      });
    }, 100);
  }

  function updateStationCount() {
    var visible = getVisibleStations();
    var dcfc = visible.filter(function (s) { return s.chargerLevel === 'DCFC'; }).length;
    var l2 = visible.filter(function (s) { return s.chargerLevel === 'L2'; }).length;
    var label = dcfc + ' DCFC';
    if (l2 > 0) label += ', ' + l2 + ' L2';
    label += ' stations shown';
    document.getElementById('coverage-label').textContent = label;
  }

  function updateBatteryInfo() {
    var usable = Math.round((startingSoc - batteryReserve) * 100);
    document.getElementById('reserve-info').textContent = 'Usable battery: ' + usable + '%';
  }

  function updateSpeedDisplay() {
    document.getElementById('speed-value').textContent = currentSpeed + ' km/h';
    var loss = ((1 - getSpeedFactor(currentSpeed)) * 100).toFixed(0);
    document.getElementById('speed-factor').textContent = 'Speed loss: ' + loss + '%';
  }

  function updateTempDisplay() {
    document.getElementById('temp-value').textContent = currentTemp + '°C';
    var factor = getRangeFactor(currentTemp);
    document.getElementById('temp-factor').textContent = 'Range factor: ' + (factor * 100).toFixed(0) + '%';
  }

  function wireEvents() {
    // Vehicle range input
    document.getElementById('range-input').addEventListener('input', function (e) {
      var val = parseInt(e.target.value);
      if (val && val >= 50 && val <= 1000) {
        baseRangeKm = val;
        refresh();
      }
    });

    // Starting charge slider
    document.getElementById('soc-slider').addEventListener('input', function (e) {
      startingSoc = parseInt(e.target.value) / 100;
      document.getElementById('soc-value').textContent = e.target.value + '%';
      updateBatteryInfo();
      refresh();
    });

    // Battery reserve slider
    document.getElementById('reserve-slider').addEventListener('input', function (e) {
      batteryReserve = parseInt(e.target.value) / 100;
      document.getElementById('reserve-value').textContent = e.target.value + '%';
      updateBatteryInfo();
      refresh();
    });

    // Highway speed slider
    document.getElementById('speed-slider').addEventListener('input', function (e) {
      currentSpeed = parseInt(e.target.value);
      updateSpeedDisplay();
      refresh();
    });

    // Temperature slider
    document.getElementById('temp-slider').addEventListener('input', function (e) {
      currentTemp = parseInt(e.target.value);
      updateTempDisplay();
      refresh();
    });

    // Range mode toggle
    document.querySelectorAll('input[name="range-mode"]').forEach(function (radio) {
      radio.addEventListener('change', function (e) {
        rangeMode = e.target.value;
        refresh();
      });
    });

    // Safe route toggle
    document.getElementById('safe-route-toggle').addEventListener('change', function (e) {
      safeRoute = e.target.checked;
      refresh();
    });

    // Show L2 toggle
    document.getElementById('show-l2-toggle').addEventListener('change', function (e) {
      showL2 = e.target.checked;
      refresh();
    });

// Overlay opacity slider
    document.getElementById('opacity-slider').addEventListener('input', function (e) {
      overlayOpacity = parseInt(e.target.value) / 100;
      document.getElementById('opacity-value').textContent = e.target.value + '%';
      refresh();
    });

// Mobile sidebar toggle
    document.getElementById('sidebar-toggle').addEventListener('click', function () {
      document.getElementById('sidebar').classList.toggle('collapsed');
    });

    // Info modal
    document.getElementById('info-btn').addEventListener('click', function () {
      document.getElementById('info-modal').classList.remove('hidden');
    });
    document.getElementById('info-close').addEventListener('click', function () {
      document.getElementById('info-modal').classList.add('hidden');
    });
    document.getElementById('info-modal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });
  }

  // ============================================================
  // INIT
  // ============================================================
  async function init() {
    var spinner = document.getElementById('loading-spinner');
    spinner.classList.remove('hidden');

    try {
      console.log('[EV] Initializing map...');
      initMap();

      console.log('[EV] Loading data...');
      var chargers = await loadChargers();
      console.log('[EV] Loaded ' + chargers.length + ' chargers');

      wireEvents();
      updateSpeedDisplay();
      updateTempDisplay();
      updateBatteryInfo();
      refresh();
      console.log('[EV] Init complete');
    } catch (err) {
      console.error('[EV] Init failed:', err);
      document.getElementById('coverage-display').textContent = 'Error';
      document.getElementById('coverage-label').textContent = err.message;
    } finally {
      spinner.classList.add('hidden');
    }
  }

  init();
})();
