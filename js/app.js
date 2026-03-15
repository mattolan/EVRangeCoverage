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
  var selectedCircle = null;

  function clearSelectedCircle() {
    if (selectedCircle) {
      map.removeLayer(selectedCircle);
      selectedCircle = null;
    }
  }

  function drawCircles(radiusKm) {
    // Remove old layers
    if (coverageTileLayer) { map.removeLayer(coverageTileLayer); coverageTileLayer = null; }
    if (markerLayer) map.removeLayer(markerLayer);
    clearSelectedCircle();

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

      // Click to show this station's range circle
      (function (s, r, c) {
        marker.on('click', function () {
          clearSelectedCircle();
          selectedCircle = L.circle([s.lat, s.lng], {
            radius: radiusKm * 1000,
            color: c.fillColor,
            fillColor: c.fillColor,
            fillOpacity: 0.08,
            weight: 2,
            opacity: 0.8,
            dashArray: '8, 6',
          }).addTo(map);
        });
      })(station, risk, colors);

      markerLayer.addLayer(marker);
    });

    markerLayer.addTo(map);
  }

  function buildPopup(station, risk) {
    var warning = '';
    if (risk === 'red') {
      warning = '<div class="popup-warning">⚠ Single charger — have a backup plan</div>';
    }
    if (station.network === 'Tesla' && (!station.maxPowerKw || station.maxPowerKw < 200)) {
      warning += '<div class="popup-warning">⚠ Possible Access Restrictions: Check the Tesla app for third-party access</div>';
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

    var powerLine = '';
    if (station.maxPowerKw) {
      powerLine = '<strong>Max Power:</strong> ' + station.maxPowerKw + ' kW<br>';
    }

    return '<div class="popup-station">' +
      '<h3>' + station.name + '</h3>' +
      '<div class="popup-detail">' +
        '<strong>Address:</strong> ' + station.address + '<br>' +
        '<strong>Network:</strong> ' + station.network + '<br>' +
        '<strong>Level:</strong> ' + station.chargerLevel + '<br>' +
        '<strong>Ports:</strong> ' + portDetails + '<br>' +
        powerLine +
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
  var batteryKwh = 85;     // Battery capacity in kWh
  var startingSoc = 0.80;
  var batteryReserve = 0.20;
  var chargeToSoc = 0.80;  // SOC to charge to at public stations
  var preferMajorStations = true;
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
    updateRangeDisplay(radiusKm);
    updateSettingSummaries();

    pushURL();

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

    // Recalculate route if one is active
    if (routeStart && routeEnd && !routeMode) {
      showRouteSpinner(true);
      calculateRoute();
    }
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

  function updateRangeDisplay(radiusKm) {
    var effectiveRange = rangeMode === 'roundtrip' ? radiusKm * 2 : radiusKm;
    document.getElementById('range-display').textContent = Math.round(effectiveRange) + ' km';

    // Build breakdown
    var tempFactor = getRangeFactor(currentTemp);
    var speedFactor = getSpeedFactor(currentSpeed);
    var batteryUsable = startingSoc - batteryReserve;
    var afterTemp = baseRangeKm * tempFactor;
    var afterSpeed = afterTemp * speedFactor;
    var afterBattery = afterSpeed * batteryUsable;
    var modeLabel = rangeMode === 'roundtrip' ? '÷ 2 round-trip' : 'one-way';

    var html =
      '<div class="breakdown-line"><span>Rated range</span><span>' + baseRangeKm + ' km</span></div>' +
      '<div class="breakdown-line"><span>Temperature (' + currentTemp + '°C)</span><span>× ' + (tempFactor * 100).toFixed(0) + '% = ' + Math.round(afterTemp) + ' km</span></div>' +
      '<div class="breakdown-line"><span>Speed (' + currentSpeed + ' km/h)</span><span>× ' + (speedFactor * 100).toFixed(0) + '% = ' + Math.round(afterSpeed) + ' km</span></div>' +
      '<div class="breakdown-line"><span>Battery (' + Math.round(startingSoc * 100) + '% → ' + Math.round(batteryReserve * 100) + '%)</span><span>× ' + (batteryUsable * 100).toFixed(0) + '% = ' + Math.round(afterBattery) + ' km</span></div>' +
      '<div class="breakdown-line breakdown-result"><span>' + modeLabel + '</span><span>' + Math.round(effectiveRange) + ' km</span></div>';

    document.getElementById('range-breakdown').innerHTML = html;
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
    document.getElementById('battery-kwh-slider').addEventListener('input', function (e) {
      batteryKwh = parseInt(e.target.value);
      document.getElementById('battery-kwh-value').textContent = batteryKwh + ' kWh';
      refresh();
    });

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

    // Charge-to slider (route planner)
    document.getElementById('charge-to-slider').addEventListener('input', function (e) {
      chargeToSoc = parseInt(e.target.value) / 100;
      document.getElementById('charge-to-value').textContent = e.target.value + '%';
      if (routeStart && routeEnd && !routeMode) {
        showRouteSpinner(true);
        calculateRoute();
      }
    });

    // Prefer major stations toggle
    document.getElementById('prefer-major-toggle').addEventListener('change', function (e) {
      preferMajorStations = e.target.checked;
      if (routeStart && routeEnd && !routeMode) {
        showRouteSpinner(true);
        calculateRoute();
      }
    });

// Mobile sidebar toggle
    document.getElementById('sidebar-toggle').addEventListener('click', function () {
      document.getElementById('sidebar').classList.toggle('collapsed');
    });

    // Collapsible section headers
    document.querySelectorAll('.section-header').forEach(function (header) {
      header.addEventListener('click', function () {
        var section = document.getElementById(header.getAttribute('data-section'));
        if (section) section.classList.toggle('collapsed');
      });
    });

    // Click map background — route mode or clear selected station
    map.on('click', function (e) {
      if (routeMode) {
        handleRouteClick(e);
      } else {
        clearSelectedCircle();
      }
    });

    // Route planner buttons
    document.getElementById('route-toggle').addEventListener('click', function () {
      if (routeMode) {
        exitRouteMode();
        expandSettingsPanels();
      } else {
        enterRouteMode();
      }
    });

    document.getElementById('route-clear').addEventListener('click', function () {
      clearRoute();
      exitRouteMode();
      var sidebar = document.getElementById('sidebar');
      var scrollPos = sidebar.scrollTop;
      expandSettingsPanels();
      sidebar.scrollTop = scrollPos;
    });

    // Reset button
    document.getElementById('reset-btn').addEventListener('click', resetDefaults);

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
  // COLLAPSIBLE SETTINGS PANELS
  // ============================================================
  function collapseSettingsPanels() {
    document.querySelectorAll('#settings-panels .collapsible').forEach(function (s) {
      s.classList.add('collapsed');
    });
    updateSettingSummaries();
  }

  function expandSettingsPanels() {
    document.querySelectorAll('#settings-panels .collapsible').forEach(function (s) {
      s.classList.remove('collapsed');
    });
  }

  function updateSettingSummaries() {
    document.getElementById('summary-range').textContent = baseRangeKm + ' km';
    document.getElementById('summary-speed').textContent = currentSpeed + ' km/h';
    document.getElementById('summary-temp').textContent = currentTemp + '°C';
    document.getElementById('summary-battery').textContent =
      batteryKwh + ' kWh · ' + Math.round(startingSoc * 100) + '% → ' + Math.round(batteryReserve * 100) + '% reserve';
    var opts = [];
    if (rangeMode === 'roundtrip') opts.push('Round-trip');
    else opts.push('One-way');
    if (safeRoute) opts.push('Safe');
    document.getElementById('summary-options').textContent = opts.join(', ');
  }

  // ============================================================
  // ROUTE PLANNER
  // ============================================================
  var routeMode = false;
  var routeStart = null;    // {lat, lng}
  var routeEnd = null;      // {lat, lng}
  var routeStartMarker = null;
  var routeEndMarker = null;
  var routeLineLayer = null;
  var routeStopMarkers = null;

  function clearRoute() {
    if (routeStartMarker) { map.removeLayer(routeStartMarker); routeStartMarker = null; }
    if (routeEndMarker) { map.removeLayer(routeEndMarker); routeEndMarker = null; }
    if (routeLineLayer) { map.removeLayer(routeLineLayer); routeLineLayer = null; }
    if (routeStopMarkers) { map.removeLayer(routeStopMarkers); routeStopMarkers = null; }
    routeStart = null;
    routeEnd = null;
    cachedCorridorKey = null;
    cachedCorridorGeometry = null;
    cachedCorridorStations = null;
    cachedCorridorFailed = false;
    document.getElementById('route-result').classList.add('hidden');
    document.getElementById('route-result').innerHTML = '';
    document.getElementById('route-clear').classList.add('hidden');
    showRouteSpinner(false);
  }

  function exitRouteMode() {
    routeMode = false;
    document.getElementById('route-toggle').textContent = 'Plan a Route';
    document.getElementById('route-instructions').classList.add('hidden');
    map.getContainer().style.cursor = '';
    hideCursorTooltip();
    map.off('mousemove', onMapMouseMove);
  }

  // Cursor tooltip for route mode
  var cursorTooltip = null;

  function createCursorTooltip() {
    if (cursorTooltip) return;
    cursorTooltip = document.createElement('div');
    cursorTooltip.id = 'route-cursor-tooltip';
    cursorTooltip.className = 'route-cursor-tooltip';
    document.getElementById('map-wrapper').appendChild(cursorTooltip);
  }

  function updateCursorTooltip(text) {
    if (!cursorTooltip) createCursorTooltip();
    cursorTooltip.textContent = text;
    cursorTooltip.style.display = 'block';
  }

  function hideCursorTooltip() {
    if (cursorTooltip) cursorTooltip.style.display = 'none';
  }

  function onMapMouseMove(e) {
    if (!cursorTooltip || cursorTooltip.style.display === 'none') return;
    var container = map.getContainer().getBoundingClientRect();
    var x = e.originalEvent.clientX - container.left + 15;
    var y = e.originalEvent.clientY - container.top - 10;
    cursorTooltip.style.left = x + 'px';
    cursorTooltip.style.top = y + 'px';
  }

  function enterRouteMode() {
    routeMode = true;
    clearRoute();
    collapseSettingsPanels();
    document.getElementById('route-toggle').textContent = 'Cancel Route';
    document.getElementById('route-instructions').classList.remove('hidden');
    document.getElementById('route-instructions').textContent = 'Click the map to set your start point';
    map.getContainer().style.cursor = 'crosshair';
    updateCursorTooltip('Click to set starting point');
    map.on('mousemove', onMapMouseMove);
  }

  function handleRouteClick(e) {
    if (!routeMode) return;

    if (!routeStart) {
      routeStart = { lat: e.latlng.lat, lng: e.latlng.lng };
      routeStartMarker = L.marker([routeStart.lat, routeStart.lng], {
        icon: L.divIcon({
          className: 'route-icon route-icon-start',
          html: 'A',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        })
      }).addTo(map);
      document.getElementById('route-instructions').textContent = 'Click the map to set your destination';
      updateCursorTooltip('Click to set destination');
    } else if (!routeEnd) {
      routeEnd = { lat: e.latlng.lat, lng: e.latlng.lng };
      routeEndMarker = L.marker([routeEnd.lat, routeEnd.lng], {
        icon: L.divIcon({
          className: 'route-icon route-icon-end',
          html: 'B',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        })
      }).addTo(map);
      document.getElementById('route-instructions').classList.add('hidden');
      hideCursorTooltip();
      map.off('mousemove', onMapMouseMove);
      map.getContainer().style.cursor = '';
      calculateRoute();
    }
  }

  var routeCalcId = 0; // cancel stale route calculations

  // Cache the corridor so parameter changes don't re-fetch the direct route
  var cachedCorridorKey = null;   // "lat,lng|lat,lng"
  var cachedCorridorGeometry = null;
  var cachedCorridorStations = null;
  var cachedCorridorFailed = false; // true if corridor had no charger coverage

  function showRouteSpinner(show) {
    var el = document.getElementById('route-calc-indicator');
    if (show) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  async function calculateRoute() {
    var myId = ++routeCalcId;
    var adjustedRange = getAdjustedRange(baseRangeKm, currentTemp);
    // First leg uses starting SOC, subsequent legs use charge-to SOC
    var maxFirstLegKm = adjustedRange * (startingSoc - batteryReserve);
    var maxLegKm = adjustedRange * (chargeToSoc - batteryReserve);

    var visible = getVisibleStations();
    var stations = safeRoute
      ? visible.filter(function (s) { return s.connectorCount >= 2; })
      : visible;

    // Show calculating indicators
    var el = document.getElementById('route-result');
    el.innerHTML = '<div style="color:#999;font-size:0.85rem;">Calculating route...</div>';
    el.classList.remove('hidden');
    showRouteSpinner(true);

    // Step 1: Get corridor — use cache if start/end haven't changed
    var corridorKey = routeStart.lat + ',' + routeStart.lng + '|' + routeEnd.lat + ',' + routeEnd.lng;
    var corridorStations = stations;
    var corridorGeometry = null;
    var useHaversineFallback = false;

    if (corridorKey === cachedCorridorKey && cachedCorridorFailed) {
      // This corridor previously had no charger coverage — skip straight to haversine
      console.log('[Route] Corridor known to fail for these endpoints, using haversine');
      useHaversineFallback = true;
    } else if (corridorKey === cachedCorridorKey && cachedCorridorStations) {
      // Reuse cached corridor but re-filter with current station visibility
      corridorGeometry = cachedCorridorGeometry;
      if (corridorGeometry) {
        corridorStations = filterStationsNearRoute(stations, corridorGeometry, 50);
        if (corridorStations.length < 3) {
          corridorStations = filterStationsNearRoute(stations, corridorGeometry, 100);
        }
      }
    } else {
      // Fetch driving route to establish corridor
      var directRoute = await fetchOSRMRoute([routeStart, routeEnd]);
      if (myId !== routeCalcId) { showRouteSpinner(false); return; }

      if (directRoute && directRoute.geometry) {
        corridorGeometry = directRoute.geometry;
        corridorStations = filterStationsNearRoute(stations, corridorGeometry, 50);
        console.log('[Route] ' + corridorStations.length + '/' + stations.length + ' stations within 50km of route');
        if (corridorStations.length < 3) {
          corridorStations = filterStationsNearRoute(stations, corridorGeometry, 100);
          console.log('[Route] Widened to 100km: ' + corridorStations.length + ' stations');
        }
      }
      // Cache it
      cachedCorridorKey = corridorKey;
      cachedCorridorGeometry = corridorGeometry;
      cachedCorridorStations = corridorStations;
      cachedCorridorFailed = false;
    }

    // Step 2: Find the chain of chargers along the corridor
    var chain;
    if (useHaversineFallback) {
      chain = findChargerChainHaversine(routeStart, routeEnd, stations, maxFirstLegKm, maxLegKm);
    } else {
      chain = findChargerChain(routeStart, routeEnd, corridorStations, maxFirstLegKm, maxLegKm, corridorGeometry);

      // Step 2b: If corridor route fails, retry with ALL stations using haversine fallback
      // The OSRM route may follow a road with no chargers (e.g. Hwy 16 via Jasper),
      // while a longer alternate route (Hwy 43/2 via Edmonton) has charger coverage.
      if (!chain.feasible && corridorStations.length < stations.length) {
        console.log('[Route] Corridor route failed, retrying with all ' + stations.length + ' stations (haversine fallback)');
        chain = findChargerChainHaversine(routeStart, routeEnd, stations, maxFirstLegKm, maxLegKm);
        if (chain.feasible) {
          // Mark this corridor as failed so we skip it on parameter changes
          cachedCorridorFailed = true;
          console.log('[Route] Corridor marked as failed — will use haversine for this route');
        }
      }
    }

    // Step 3: Build waypoints and fetch OSRM routes
    var chargerWaypoints = [routeStart];
    for (var i = 0; i < chain.chain.length; i++) {
      var c = chain.chain[i];
      if (c.type === 'charger') {
        chargerWaypoints.push({ lat: c.station.lat, lng: c.station.lng });
      }
    }

    await new Promise(function (r) { setTimeout(r, 200); });
    if (myId !== routeCalcId) { showRouteSpinner(false); return; }

    if (chain.feasible) {
      // Feasible: one OSRM request for the full route
      var allWaypoints = chargerWaypoints.concat([routeEnd]);
      var osrmResult = await fetchOSRMRoute(allWaypoints);
      if (myId !== routeCalcId) { showRouteSpinner(false); return; }

      showRouteSpinner(false);
      displayRouteResult(chain, maxLegKm, osrmResult, null);
    } else {
      // Infeasible: separate OSRM for the feasible portion and the gap
      var osrmFeasible = null;
      var osrmGap = null;
      var lastReached = chargerWaypoints[chargerWaypoints.length - 1];

      if (chargerWaypoints.length > 1) {
        // Feasible portion: start → charger stops
        osrmFeasible = await fetchOSRMRoute(chargerWaypoints);
        if (myId !== routeCalcId) { showRouteSpinner(false); return; }
        await new Promise(function (r) { setTimeout(r, 200); });
        if (myId !== routeCalcId) { showRouteSpinner(false); return; }
      }

      // Gap portion: last reached point → destination
      osrmGap = await fetchOSRMRoute([lastReached, routeEnd]);
      if (myId !== routeCalcId) { showRouteSpinner(false); return; }

      showRouteSpinner(false);
      displayRouteResult(chain, maxLegKm, osrmFeasible, osrmGap);
    }
  }

  // Fetch road-following route from OSRM demo server
  async function fetchOSRMRoute(waypoints) {
    try {
      var coords = waypoints.map(function (w) { return w.lng + ',' + w.lat; }).join(';');
      var url = 'https://router.project-osrm.org/route/v1/driving/' + coords +
        '?overview=full&geometries=geojson&steps=false';
      var resp = await fetch(url);
      if (!resp.ok) {
        console.warn('[Route] OSRM HTTP error:', resp.status);
        return null;
      }
      var data = await resp.json();
      if (data.code !== 'Ok' || !data.routes || !data.routes[0]) {
        console.warn('[Route] OSRM response error:', data.code, data.message);
        return null;
      }

      var route = data.routes[0];
      return {
        geometry: route.geometry.coordinates, // [[lng,lat], ...]
        totalDistM: route.distance,           // meters
        totalDurS: route.duration,            // seconds
        legs: route.legs.map(function (leg) {
          return { distM: leg.distance, durS: leg.duration };
        }),
      };
    } catch (err) {
      console.warn('[Route] OSRM fetch failed:', err);
      return null;
    }
  }

  // Filter stations to those within corridorKm of the driving route
  // Uses pre-sampled route points and fast squared-degree check before haversine
  function filterStationsNearRoute(stations, routeGeometry, corridorKm) {
    // Sample route geometry down to ~100 points for speed
    var step = Math.max(1, Math.floor(routeGeometry.length / 100));
    var sampled = [];
    for (var i = 0; i < routeGeometry.length; i += step) {
      sampled.push(routeGeometry[i]); // [lng, lat]
    }
    // Always include last point
    if (sampled[sampled.length - 1] !== routeGeometry[routeGeometry.length - 1]) {
      sampled.push(routeGeometry[routeGeometry.length - 1]);
    }

    // Rough degree threshold for quick reject (~1 degree ≈ 111km at equator, less at higher lat)
    var degThreshold = corridorKm / 80; // conservative for Alberta's latitude (~52°N)

    return stations.filter(function (s) {
      // Quick bounding box check against sampled points
      for (var i = 0; i < sampled.length; i++) {
        var dLat = Math.abs(s.lat - sampled[i][1]);
        var dLng = Math.abs(s.lng - sampled[i][0]);
        if (dLat < degThreshold && dLng < degThreshold) {
          // Confirm with real haversine
          if (haversineKm(s.lat, s.lng, sampled[i][1], sampled[i][0]) <= corridorKm) {
            return true;
          }
        }
      }
      return false;
    });
  }

  // ============================================================
  // STATION QUALITY SCORING
  // ============================================================
  var PREFERRED_NETWORKS = {
    'Tesla': 5,
    'PETROCAN': 5,
    'Electrify Canada': 5,
    'FLO': 4,
    'SHELL_RECHARGE': 4,
    'ChargePoint Network': 3,
    'COUCHE_TARD': 3,
    'SWTCH': 2,
    'CHARGELAB': 2,
    '7CHARGE': 2,
    'LOOP': 2,
    'EV Connect': 2,
    'Hwisel': 1,
  };

  var DEALERSHIP_KEYWORDS = [
    'ford', 'chevrolet', 'chevy', 'buick', 'gmc', 'cadillac', 'toyota',
    'hyundai', 'kia', 'honda', 'nissan', 'bmw', 'mercedes', 'audi',
    'volkswagen', 'vw', 'mazda', 'subaru', 'dodge', 'chrysler', 'jeep',
    'lincoln', 'corvette', 'dealership', 'motors', 'sales ltd',
  ];

  var DEALERSHIP_NETWORKS = ['FORD_CHARGE', 'GM_CHARGE'];

  // Alberta cities/towns with populations > ~10,000 (amenity proxy)
  var MAJOR_CENTERS = [
    { name: 'Calgary', lat: 51.05, lng: -114.07, pop: 5 },
    { name: 'Edmonton', lat: 53.55, lng: -113.49, pop: 5 },
    { name: 'Red Deer', lat: 52.27, lng: -113.81, pop: 4 },
    { name: 'Lethbridge', lat: 49.70, lng: -112.83, pop: 4 },
    { name: 'Medicine Hat', lat: 50.04, lng: -110.68, pop: 3 },
    { name: 'Grande Prairie', lat: 55.17, lng: -118.80, pop: 3 },
    { name: 'Airdrie', lat: 51.29, lng: -114.01, pop: 3 },
    { name: 'Spruce Grove', lat: 53.54, lng: -113.90, pop: 2 },
    { name: 'Leduc', lat: 53.26, lng: -113.55, pop: 2 },
    { name: 'Fort McMurray', lat: 56.73, lng: -111.38, pop: 3 },
    { name: 'Cochrane', lat: 51.19, lng: -114.47, pop: 2 },
    { name: 'Okotoks', lat: 50.73, lng: -113.97, pop: 2 },
    { name: 'Camrose', lat: 53.02, lng: -112.83, pop: 2 },
    { name: 'Lloydminster', lat: 53.28, lng: -110.01, pop: 2 },
    { name: 'Cold Lake', lat: 54.46, lng: -110.18, pop: 2 },
    { name: 'Canmore', lat: 51.09, lng: -115.36, pop: 2 },
    { name: 'Banff', lat: 51.18, lng: -115.57, pop: 2 },
    { name: 'Jasper', lat: 52.87, lng: -118.08, pop: 2 },
    { name: 'Hinton', lat: 53.40, lng: -117.58, pop: 2 },
    { name: 'Whitecourt', lat: 54.14, lng: -115.68, pop: 2 },
  ];

  function isDealership(station) {
    if (DEALERSHIP_NETWORKS.indexOf(station.network) !== -1) return true;
    var nameLower = station.name.toLowerCase();
    for (var i = 0; i < DEALERSHIP_KEYWORDS.length; i++) {
      if (nameLower.indexOf(DEALERSHIP_KEYWORDS[i]) !== -1) return true;
    }
    return false;
  }

  function nearMajorCenter(station) {
    for (var i = 0; i < MAJOR_CENTERS.length; i++) {
      var c = MAJOR_CENTERS[i];
      // Quick degree check (~25km)
      if (Math.abs(station.lat - c.lat) < 0.25 && Math.abs(station.lng - c.lng) < 0.35) {
        return c.pop; // return population score
      }
    }
    return 0;
  }

  function getStationQuality(station) {
    var score = 0;

    // Dealership penalty
    if (isDealership(station)) {
      score -= 30;
    }

    // Network score (0-5)
    var networkScore = PREFERRED_NETWORKS[station.network] || 0;
    if (station.network === 'Non-Networked') networkScore = -2;
    score += networkScore * 5; // 0-25 points

    // Connector count score
    var count = station.connectorCount || 1;
    if (count >= 8) score += 25;
    else if (count >= 4) score += 20;
    else if (count >= 3) score += 15;
    else if (count >= 2) score += 8;
    else score += 0; // single connector = no bonus

    // Charger level (DCFC preferred)
    if (station.chargerLevel === 'DCFC') score += 10;

    // Near a major center (amenity proxy)
    score += nearMajorCenter(station) * 3; // 0-15 points

    return score;
  }

  // ============================================================
  // ROUTE PROGRESS HELPER
  // ============================================================
  // Build a lookup structure from route geometry: sampled points with cumulative distance
  function buildRouteProgress(routeGeometry) {
    if (!routeGeometry || routeGeometry.length < 2) return null;
    var step = Math.max(1, Math.floor(routeGeometry.length / 200));
    var points = [];
    var cumDist = 0;
    var prev = routeGeometry[0];
    points.push({ lat: prev[1], lng: prev[0], cumDist: 0 });
    for (var i = step; i < routeGeometry.length; i += step) {
      var pt = routeGeometry[i];
      cumDist += haversineKm(prev[1], prev[0], pt[1], pt[0]);
      points.push({ lat: pt[1], lng: pt[0], cumDist: cumDist });
      prev = pt;
    }
    // Always include last point
    var last = routeGeometry[routeGeometry.length - 1];
    if (prev !== last) {
      cumDist += haversineKm(prev[1], prev[0], last[1], last[0]);
      points.push({ lat: last[1], lng: last[0], cumDist: cumDist });
    }
    return { points: points, totalDist: cumDist };
  }

  // Get how far along the route a point is (0 = start, 1 = end) and how far off-route it is
  function getRouteProgress(routeData, lat, lng) {
    if (!routeData) return { progress: 0, offRouteKm: Infinity };
    var bestDist = Infinity;
    var bestCum = 0;
    for (var i = 0; i < routeData.points.length; i++) {
      var p = routeData.points[i];
      var d = haversineKm(lat, lng, p.lat, p.lng);
      if (d < bestDist) {
        bestDist = d;
        bestCum = p.cumDist;
      }
    }
    return {
      progress: routeData.totalDist > 0 ? bestCum / routeData.totalDist : 0,
      offRouteKm: bestDist,
    };
  }

  // ============================================================
  // CHARGER CHAIN ALGORITHM
  // ============================================================
  function findChargerChain(start, end, stations, maxFirstLegKm, maxLegKm, routeGeometry) {
    if (preferMajorStations) {
      return findChargerChainSmart(start, end, stations, maxFirstLegKm, maxLegKm, routeGeometry);
    }
    return findChargerChainGreedy(start, end, stations, maxFirstLegKm, maxLegKm, routeGeometry);
  }

  // Pre-compute route-km position and off-route distance for each station
  function buildStationRouteIndex(stations, routeData) {
    var indexed = [];
    for (var s = 0; s < stations.length; s++) {
      var rp = getRouteProgress(routeData, stations[s].lat, stations[s].lng);
      indexed.push({
        station: stations[s],
        routeKm: rp.progress * routeData.totalDist,
        offRouteKm: rp.offRouteKm,
        quality: getStationQuality(stations[s]),
      });
    }
    // Filter out stations far from the route and sort by route-km
    indexed = indexed.filter(function (s) { return s.offRouteKm < 50; });
    indexed.sort(function (a, b) { return a.routeKm - b.routeKm; });
    return indexed;
  }

  // Segment-based chain builder: walk the route in leg-sized chunks
  // pickerFn(candidates, reachable) selects the best station from candidates
  function buildChainSegmented(start, end, stationIndex, maxFirstLegKm, maxLegKm, routeData, pickerFn) {
    var ROAD_FACTOR = 1.3;
    var chain = [];
    var visited = {};
    var current = { lat: start.lat, lng: start.lng };
    var isFirstLeg = true;
    var maxIterations = 50;

    var startRp = getRouteProgress(routeData, start.lat, start.lng);
    var endRp = getRouteProgress(routeData, end.lat, end.lng);
    var currentKm = startRp.progress * routeData.totalDist;
    var endKm = endRp.progress * routeData.totalDist;

    for (var i = 0; i < maxIterations; i++) {
      var thisLegMax = isFirstLeg ? maxFirstLegKm : maxLegKm;
      var maxHaversine = thisLegMax / ROAD_FACTOR;

      // Can we reach the destination directly?
      var remainingKm = endKm - currentKm;
      var distToEnd = haversineKm(current.lat, current.lng, end.lat, end.lng);
      if (remainingKm <= thisLegMax && distToEnd <= maxHaversine) {
        chain.push({ type: 'destination', dist: distToEnd });
        return { feasible: true, chain: chain };
      }

      // Find stations ahead of us within this leg's range
      var reachable = [];
      for (var s = 0; s < stationIndex.length; s++) {
        var si = stationIndex[s];
        if (visited[si.station.id]) continue;

        var routeDist = si.routeKm - currentKm;
        if (routeDist < 5) continue;           // behind us or too close
        if (routeDist > thisLegMax) continue;   // too far along the road

        // Sanity check: haversine reachability
        var hvDist = haversineKm(current.lat, current.lng, si.station.lat, si.station.lng);
        if (hvDist > maxHaversine) continue;

        reachable.push({
          station: si.station,
          distFromCurrent: hvDist,
          routeKm: si.routeKm,
          routeDist: routeDist,
          offRouteKm: si.offRouteKm,
          quality: si.quality,
        });
      }

      if (reachable.length === 0) {
        chain.push({ type: 'gap', from: current, distToEnd: distToEnd, maxRange: thisLegMax });
        return { feasible: false, chain: chain };
      }

      // Sort by distance along route (furthest first)
      reachable.sort(function (a, b) { return b.routeDist - a.routeDist; });

      // Candidates: stations in the top 50% of reachable route distance
      // So on a 200km leg, we consider stations from 100km–200km ahead
      var maxReachDist = reachable[0].routeDist;
      var minCandidateDist = maxReachDist * 0.5;
      var candidates = reachable.filter(function (r) {
        return r.routeDist >= minCandidateDist;
      });
      if (candidates.length === 0) candidates = [reachable[0]];

      // Let the picker choose (greedy vs smart)
      var best = pickerFn(candidates, reachable);

      visited[best.station.id] = true;
      isFirstLeg = false;
      currentKm = best.routeKm;
      current = { lat: best.station.lat, lng: best.station.lng };

      chain.push({
        type: 'charger',
        station: best.station,
        dist: best.distFromCurrent,
        risk: getRiskLevel(best.station),
      });
    }
    return { feasible: false, chain: chain };
  }

  // Greedy: pick the station furthest along the route (max progress per leg)
  function findChargerChainGreedy(start, end, stations, maxFirstLegKm, maxLegKm, routeGeometry) {
    var ROAD_FACTOR = 1.3;
    var routeData = buildRouteProgress(routeGeometry);

    // Fallback: no route data, use old haversine-to-destination approach
    if (!routeData) {
      return findChargerChainHaversine(start, end, stations, maxFirstLegKm, maxLegKm);
    }

    var stationIndex = buildStationRouteIndex(stations, routeData);

    return buildChainSegmented(start, end, stationIndex, maxFirstLegKm, maxLegKm, routeData,
      function greedyPicker(candidates) {
        // Just pick the furthest along (already sorted desc by routeDist in candidates)
        return candidates[0];
      }
    );
  }

  // Smart: prefer high-quality stations, willing to stop sooner for a better station
  function findChargerChainSmart(start, end, stations, maxFirstLegKm, maxLegKm, routeGeometry) {
    var ROAD_FACTOR = 1.3;
    var routeData = buildRouteProgress(routeGeometry);

    if (!routeData) {
      return findChargerChainHaversine(start, end, stations, maxFirstLegKm, maxLegKm);
    }

    var stationIndex = buildStationRouteIndex(stations, routeData);

    return buildChainSegmented(start, end, stationIndex, maxFirstLegKm, maxLegKm, routeData,
      function smartPicker(candidates, reachable) {
        // Among candidates in the top 50%, pick highest quality (penalize off-route)
        candidates.sort(function (a, b) {
          var aQual = a.quality - Math.max(0, a.offRouteKm - 15) * 0.5;
          var bQual = b.quality - Math.max(0, b.offRouteKm - 15) * 0.5;
          var qualDiff = bQual - aQual;
          if (Math.abs(qualDiff) > 10) return qualDiff; // quality wins
          return b.routeDist - a.routeDist;              // tiebreak: further along
        });

        var best = candidates[0];

        // Early-stop: if the best candidate is low quality, look for a good station
        // sooner along the route (willing to add an extra stop for reliability)
        if (best.quality < 15) {
          var maxReachDist = reachable[0].routeDist;
          var earlyGood = reachable.filter(function (r) {
            return r.routeDist <= maxReachDist * 0.6 && r.quality >= 30 && r.offRouteKm < 30;
          });
          if (earlyGood.length > 0) {
            earlyGood.sort(function (a, b) { return b.quality - a.quality; });
            best = earlyGood[0];
          }
        }

        return best;
      }
    );
  }

  // Haversine fallback when OSRM corridor has no charger coverage
  // Uses straight-line distance to destination — works for finding alternate corridors
  function findChargerChainHaversine(start, end, stations, maxFirstLegKm, maxLegKm) {
    var ROAD_FACTOR = 1.3;
    var DETOUR_TOLERANCE = 30;
    var chain = [];
    var visited = {};
    var current = { lat: start.lat, lng: start.lng };
    var maxIterations = 50;
    var isFirstLeg = true;

    for (var i = 0; i < maxIterations; i++) {
      var thisLegMax = isFirstLeg ? maxFirstLegKm : maxLegKm;
      var maxHaversine = thisLegMax / ROAD_FACTOR;
      var distToEnd = haversineKm(current.lat, current.lng, end.lat, end.lng);

      if (distToEnd <= maxHaversine) {
        chain.push({ type: 'destination', dist: distToEnd });
        return { feasible: true, chain: chain };
      }

      var reachable = [];
      for (var s = 0; s < stations.length; s++) {
        var st = stations[s];
        if (visited[st.id]) continue;
        var distToStation = haversineKm(current.lat, current.lng, st.lat, st.lng);
        if (distToStation <= maxHaversine && distToStation > 1) {
          reachable.push({
            station: st,
            distFromCurrent: distToStation,
            distToEnd: haversineKm(st.lat, st.lng, end.lat, end.lng),
            quality: preferMajorStations ? getStationQuality(st) : 0,
          });
        }
      }

      if (reachable.length === 0) {
        chain.push({ type: 'gap', from: current, distToEnd: distToEnd, maxRange: thisLegMax });
        return { feasible: false, chain: chain };
      }

      // Sort by closest to destination
      reachable.sort(function (a, b) { return a.distToEnd - b.distToEnd; });
      var nearest = reachable[0];
      var best = nearest;

      // If preferring major stations, consider quality among nearby candidates
      if (preferMajorStations) {
        var candidates = reachable.filter(function (r) {
          return r.distToEnd <= nearest.distToEnd + DETOUR_TOLERANCE;
        });
        candidates.sort(function (a, b) {
          var qualDiff = b.quality - a.quality;
          if (Math.abs(qualDiff) > 10) return qualDiff;
          return a.distToEnd - b.distToEnd;
        });
        best = candidates[0];

        // Early-stop: prefer a good station sooner over a bad one further
        if (best.quality < 15) {
          var earlyGood = reachable.filter(function (r) {
            return r.distFromCurrent <= maxHaversine * 0.6 && r.quality >= 30;
          });
          if (earlyGood.length > 0) {
            earlyGood.sort(function (a, b) { return b.quality - a.quality; });
            best = earlyGood[0];
          }
        }
      }

      visited[best.station.id] = true;
      isFirstLeg = false;

      chain.push({
        type: 'charger',
        station: best.station,
        dist: best.distFromCurrent,
        risk: getRiskLevel(best.station),
      });
      current = { lat: best.station.lat, lng: best.station.lng };
    }
    return { feasible: false, chain: chain };
  }

  function formatDuration(seconds) {
    var hrs = Math.floor(seconds / 3600);
    var mins = Math.round((seconds % 3600) / 60);
    if (hrs > 0) return hrs + 'h ' + mins + 'm';
    return mins + ' min';
  }

  // Estimate charging time in minutes given arrival/departure SOC and charger power
  function estimateChargeTimeMin(arrivalSoc, departureSoc, chargerPowerKw) {
    if (!chargerPowerKw || chargerPowerKw <= 0) return null;
    var energyNeeded = batteryKwh * (departureSoc - arrivalSoc);
    if (energyNeeded <= 0) return 0;
    // Simple model: average ~85% efficiency for DC fast, ~90% for L2
    var efficiency = chargerPowerKw >= 50 ? 0.85 : 0.90;
    var hours = energyNeeded / (chargerPowerKw * efficiency);
    return Math.round(hours * 60);
  }

  function formatChargeTime(minutes) {
    if (minutes === null) return '';
    if (minutes < 1) return '< 1 min charge';
    if (minutes >= 60) {
      var h = Math.floor(minutes / 60);
      var m = minutes % 60;
      return h + 'h ' + m + 'm charge';
    }
    return minutes + ' min charge';
  }

  function formatChargerDetails(station, risk, arrivalSoc, departureSoc) {
    var riskLabels = { green: 'Low risk', yellow: 'Moderate risk', red: 'High risk', blue: 'Level 2' };
    var html = '<div class="route-stop-details">';
    html += '<div class="route-detail-line">' + station.network + '</div>';
    html += '<div class="route-detail-line">';
    if (station.chargerLevel === 'DCFC') {
      html += station.dcFastNum + ' DC fast';
    } else {
      html += station.level2Num + ' Level 2';
    }
    if (station.connectorTypes && station.connectorTypes.length > 0) {
      var types = station.connectorTypes.filter(function (t) {
        return showL2 || t !== 'J1772';
      });
      if (types.length > 0) {
        html += ' · ' + types.join(', ');
      }
    }
    html += '</div>';
    if (station.maxPowerKw) {
      html += '<div class="route-detail-line">' + station.maxPowerKw + ' kW';
      var chargeMin = estimateChargeTimeMin(arrivalSoc, departureSoc, station.maxPowerKw);
      if (chargeMin !== null && chargeMin > 0) {
        html += ' · ' + formatChargeTime(chargeMin);
      }
      html += '</div>';
    }
    html += '<div class="route-detail-line route-detail-risk" style="color:' + RISK_COLORS[risk].fillColor + '">' + riskLabels[risk] + '</div>';
    if (station.network === 'Tesla' && (!station.maxPowerKw || station.maxPowerKw < 200)) {
      html += '<div class="route-detail-line" style="color:#e67e22;font-size:0.7rem;">Possible Access Restrictions: Check the Tesla app for third-party access</div>';
    }
    html += '</div>';
    return html;
  }

  function displayRouteResult(result, maxLegKm, osrmResult, osrmGap) {
    var el = document.getElementById('route-result');
    var html = '';

    if (routeLineLayer) { map.removeLayer(routeLineLayer); routeLineLayer = null; }
    if (routeStopMarkers) { map.removeLayer(routeStopMarkers); routeStopMarkers = null; }

    routeLineLayer = L.layerGroup();
    routeStopMarkers = L.layerGroup();

    var stopNum = 0;
    var hasRoadRoute = osrmResult && osrmResult.geometry;
    var legIndex = 0;

    // Show the effective range used for this route
    var maxFirstLeg = getAdjustedRange(baseRangeKm, currentTemp) * (startingSoc - batteryReserve);
    if (Math.round(maxFirstLeg) !== Math.round(maxLegKm)) {
      html += '<div style="color:#aaa;font-size:0.75rem;margin-bottom:0.3rem;">First leg: ' + Math.round(maxFirstLeg) + ' km · After charging: ' + Math.round(maxLegKm) + ' km</div>';
    } else {
      html += '<div style="color:#aaa;font-size:0.75rem;margin-bottom:0.3rem;">Max range per leg: ' + Math.round(maxLegKm) + ' km</div>';
    }

    // Full battery range (100% SOC) adjusted for conditions
    var fullRange = getAdjustedRange(baseRangeKm, currentTemp);
    var currentSoc = startingSoc;

    if (result.feasible) {
      html += '<div class="route-feasible">Route is feasible!</div>';

      // Build stops HTML first to calculate total charge time, then prepend summary
      var stopsHtml = '';
      var totalChargeMin = 0;

      stopsHtml += '<div class="route-stop"><span class="stop-num" style="background:var(--color-green)">A</span> Start</div>';
      stopsHtml += '<div class="route-soc">Depart: ' + Math.round(currentSoc * 100) + '%</div>';

      for (var i = 0; i < result.chain.length; i++) {
        var c = result.chain[i];
        if (c.type === 'charger') {
          stopNum++;
          var riskColor = RISK_COLORS[c.risk].fillColor;
          var legDist = hasRoadRoute && osrmResult.legs[legIndex]
            ? Math.round(osrmResult.legs[legIndex].distM / 1000)
            : Math.round(c.dist);
          var legTime = hasRoadRoute && osrmResult.legs[legIndex]
            ? formatDuration(osrmResult.legs[legIndex].durS)
            : '';
          legIndex++;

          var socUsed = legDist / fullRange;
          var arrivalSoc = currentSoc - socUsed;
          var arrivalPct = Math.max(0, Math.round(arrivalSoc * 100));
          var prevSoc = Math.max(0, arrivalSoc);
          currentSoc = chargeToSoc;

          var stopChargeMin = estimateChargeTimeMin(prevSoc, chargeToSoc, c.station.maxPowerKw);
          if (stopChargeMin) totalChargeMin += stopChargeMin;

          stopsHtml += '<div class="route-leg">↓ ' + legDist + ' km' + (legTime ? ' · ' + legTime : '') + '</div>';
          stopsHtml += '<div class="route-stop"><span class="stop-num" style="background:' + riskColor + '">' + stopNum + '</span> ' + c.station.name + '</div>';
          stopsHtml += formatChargerDetails(c.station, c.risk, prevSoc, chargeToSoc);
          stopsHtml += '<div class="route-soc">';
          stopsHtml += '<span class="' + (arrivalPct <= Math.round(batteryReserve * 100) ? 'soc-warning' : '') + '">Arrive: ' + arrivalPct + '%</span>';
          stopsHtml += ' → Depart: ' + Math.round(currentSoc * 100) + '%';
          stopsHtml += '</div>';

          var stopMarker = L.marker([c.station.lat, c.station.lng], {
            icon: L.divIcon({
              className: 'route-icon route-icon-stop',
              html: String(stopNum),
              iconSize: [22, 22],
              iconAnchor: [11, 11],
            }),
            zIndexOffset: 1000,
          });
          routeStopMarkers.addLayer(stopMarker);
        } else if (c.type === 'destination') {
          var legDist = hasRoadRoute && osrmResult.legs[legIndex]
            ? Math.round(osrmResult.legs[legIndex].distM / 1000)
            : Math.round(c.dist);
          var legTime = hasRoadRoute && osrmResult.legs[legIndex]
            ? formatDuration(osrmResult.legs[legIndex].durS)
            : '';

          var socUsed = legDist / fullRange;
          var arrivalSoc = currentSoc - socUsed;
          var arrivalPct = Math.max(0, Math.round(arrivalSoc * 100));

          stopsHtml += '<div class="route-leg">↓ ' + legDist + ' km' + (legTime ? ' · ' + legTime : '') + '</div>';
          stopsHtml += '<div class="route-stop"><span class="stop-num" style="background:var(--color-btn)">B</span> Destination</div>';
          stopsHtml += '<div class="route-soc"><span class="' + (arrivalPct <= Math.round(batteryReserve * 100) ? 'soc-warning' : '') + '">Arrive: ' + arrivalPct + '%</span></div>';
        }
      }

      // Summary line with distance, drive time, and charge time
      if (hasRoadRoute) {
        var totalKm = Math.round(osrmResult.totalDistM / 1000);
        var driveTime = formatDuration(osrmResult.totalDurS);
        var summary = totalKm + ' km · ' + driveTime + ' drive';
        if (totalChargeMin > 0) {
          summary += ' + ~' + formatChargeTime(totalChargeMin);
        }
        html += '<div style="color:#999;font-size:0.8rem;">' + summary + '</div>';
      }

      html += stopsHtml;

      if (stopNum === 0) {
        html += '<div style="color:#999;font-size:0.8rem;margin-top:0.3rem;">Direct — no charging stops needed</div>';
      } else {
        html += '<div style="color:#999;font-size:0.8rem;margin-top:0.3rem;">' + stopNum + ' charging stop' + (stopNum > 1 ? 's' : '') + '</div>';
      }

      // Draw green road route
      if (hasRoadRoute) {
        var roadPoints = osrmResult.geometry.map(function (c) { return [c[1], c[0]]; });
        L.polyline(roadPoints, { color: '#2ecc40', weight: 4, opacity: 0.8 }).addTo(routeLineLayer);
      } else {
        var points = [[routeStart.lat, routeStart.lng]];
        for (var i = 0; i < result.chain.length; i++) {
          if (result.chain[i].type === 'charger') points.push([result.chain[i].station.lat, result.chain[i].station.lng]);
        }
        points.push([routeEnd.lat, routeEnd.lng]);
        L.polyline(points, { color: '#2ecc40', weight: 3, opacity: 0.8 }).addTo(routeLineLayer);
      }

    } else {
      html += '<div class="route-impossible">Route not feasible</div>';
      html += '<div class="route-infeasible-msg">This route can\'t be completed with your current settings. '
        + 'Try increasing range, raising temperature, lowering speed, or adjusting battery settings.</div>';

      // Show the feasible charger stops before the gap
      html += '<div class="route-stop"><span class="stop-num" style="background:var(--color-green)">A</span> Start</div>';
      html += '<div class="route-soc">Depart: ' + Math.round(currentSoc * 100) + '%</div>';

      var hasFeasibleRoute = osrmResult && osrmResult.geometry;

      for (var i = 0; i < result.chain.length; i++) {
        var c = result.chain[i];
        if (c.type === 'charger') {
          stopNum++;
          var riskColor = RISK_COLORS[c.risk].fillColor;
          var legDist = hasFeasibleRoute && osrmResult.legs[legIndex]
            ? Math.round(osrmResult.legs[legIndex].distM / 1000)
            : Math.round(c.dist);
          var legTime = hasFeasibleRoute && osrmResult.legs[legIndex]
            ? formatDuration(osrmResult.legs[legIndex].durS)
            : '';
          legIndex++;

          var socUsed = legDist / fullRange;
          var arrivalSoc = currentSoc - socUsed;
          var arrivalPct = Math.max(0, Math.round(arrivalSoc * 100));
          var prevSoc = arrivalSoc;
          currentSoc = chargeToSoc;

          html += '<div class="route-leg route-leg-ok">↓ ' + legDist + ' km' + (legTime ? ' · ' + legTime : '') + '</div>';
          html += '<div class="route-stop"><span class="stop-num" style="background:' + riskColor + '">' + stopNum + '</span> ' + c.station.name + '</div>';
          html += formatChargerDetails(c.station, c.risk, Math.max(0, prevSoc), chargeToSoc);
          html += '<div class="route-soc">';
          html += '<span class="' + (arrivalPct <= Math.round(batteryReserve * 100) ? 'soc-warning' : '') + '">Arrive: ' + arrivalPct + '%</span>';
          html += ' → Depart: ' + Math.round(currentSoc * 100) + '%';
          html += '</div>';

          var stopMarker = L.marker([c.station.lat, c.station.lng], {
            icon: L.divIcon({
              className: 'route-icon route-icon-stop',
              html: String(stopNum),
              iconSize: [22, 22],
              iconAnchor: [11, 11],
            }),
            zIndexOffset: 1000,
          });
          routeStopMarkers.addLayer(stopMarker);
        } else if (c.type === 'gap') {
          var gapDist = osrmGap && osrmGap.totalDistM
            ? Math.round(osrmGap.totalDistM / 1000)
            : Math.round(c.distToEnd);
          html += '<div class="route-leg route-leg-gap">⚠ ' + gapDist + ' km gap — no reachable charger (max range: ' + Math.round(c.maxRange) + ' km)</div>';
          html += '<div class="route-stop"><span class="stop-num" style="background:var(--color-btn)">B</span> Destination</div>';
        }
      }

      // Draw feasible portion in green
      if (hasFeasibleRoute) {
        var greenPoints = osrmResult.geometry.map(function (c) { return [c[1], c[0]]; });
        L.polyline(greenPoints, { color: '#2ecc40', weight: 4, opacity: 0.8 }).addTo(routeLineLayer);
      }

      // Draw gap portion in red dashed
      if (osrmGap && osrmGap.geometry) {
        var redPoints = osrmGap.geometry.map(function (c) { return [c[1], c[0]]; });
        L.polyline(redPoints, { color: '#ff4136', weight: 4, opacity: 0.7, dashArray: '10, 8' }).addTo(routeLineLayer);
      } else {
        // Fallback: straight dashed line for the gap
        var lastCharger = null;
        for (var i = result.chain.length - 1; i >= 0; i--) {
          if (result.chain[i].type === 'charger') {
            lastCharger = result.chain[i].station;
            break;
          }
        }
        var gapStart = lastCharger
          ? [lastCharger.lat, lastCharger.lng]
          : [routeStart.lat, routeStart.lng];
        L.polyline([gapStart, [routeEnd.lat, routeEnd.lng]], {
          color: '#ff4136', weight: 3, opacity: 0.5, dashArray: '8, 8'
        }).addTo(routeLineLayer);
      }
    }

    routeLineLayer.addTo(map);
    routeStopMarkers.addTo(map);

    el.innerHTML = html;
    el.classList.remove('hidden');
    document.getElementById('route-clear').classList.remove('hidden');
    exitRouteMode();
  }

  // ============================================================
  // DEFAULTS, RESET & URL STATE
  // ============================================================
  var DEFAULTS = {
    range: 450, speed: 120, temp: 0, soc: 80, reserve: 20, chargeTo: 80, batteryKwh: 85, preferMajor: true,
    mode: 'roundtrip', safe: false, l2: false, opacity: 40
  };

  function applyState(s) {
    baseRangeKm = s.range;
    currentSpeed = s.speed;
    currentTemp = s.temp;
    batteryKwh = s.batteryKwh;
    startingSoc = s.soc / 100;
    batteryReserve = s.reserve / 100;
    chargeToSoc = s.chargeTo / 100;
    preferMajorStations = s.preferMajor;
    rangeMode = s.mode;
    safeRoute = s.safe;
    showL2 = s.l2;
    overlayOpacity = s.opacity / 100;

    // Update UI controls
    document.getElementById('range-input').value = s.range;
    document.getElementById('speed-slider').value = s.speed;
    document.getElementById('temp-slider').value = s.temp;
    document.getElementById('battery-kwh-slider').value = s.batteryKwh;
    document.getElementById('soc-slider').value = s.soc;
    document.getElementById('reserve-slider').value = s.reserve;
    document.getElementById('charge-to-slider').value = s.chargeTo;
    document.getElementById('prefer-major-toggle').checked = s.preferMajor;
    document.getElementById('opacity-slider').value = s.opacity;
    document.querySelector('input[name="range-mode"][value="' + s.mode + '"]').checked = true;
    document.getElementById('safe-route-toggle').checked = s.safe;
    document.getElementById('show-l2-toggle').checked = s.l2;
    document.getElementById('battery-kwh-value').textContent = s.batteryKwh + ' kWh';
    document.getElementById('soc-value').textContent = s.soc + '%';
    document.getElementById('reserve-value').textContent = s.reserve + '%';
    document.getElementById('charge-to-value').textContent = s.chargeTo + '%';
    document.getElementById('opacity-value').textContent = s.opacity + '%';

    updateSpeedDisplay();
    updateTempDisplay();
    updateBatteryInfo();
    refresh();
  }

  function resetDefaults() {
    applyState(DEFAULTS);
    pushURL();
  }

  function pushURL() {
    var p = new URLSearchParams();
    if (baseRangeKm !== DEFAULTS.range) p.set('range', baseRangeKm);
    if (currentSpeed !== DEFAULTS.speed) p.set('speed', currentSpeed);
    if (currentTemp !== DEFAULTS.temp) p.set('temp', currentTemp);
    if (Math.round(startingSoc * 100) !== DEFAULTS.soc) p.set('soc', Math.round(startingSoc * 100));
    if (Math.round(batteryReserve * 100) !== DEFAULTS.reserve) p.set('reserve', Math.round(batteryReserve * 100));
    if (Math.round(chargeToSoc * 100) !== DEFAULTS.chargeTo) p.set('chargeTo', Math.round(chargeToSoc * 100));
    if (batteryKwh !== DEFAULTS.batteryKwh) p.set('batteryKwh', batteryKwh);
    if (preferMajorStations !== DEFAULTS.preferMajor) p.set('preferMajor', '0');
    if (rangeMode !== DEFAULTS.mode) p.set('mode', rangeMode);
    if (safeRoute !== DEFAULTS.safe) p.set('safe', '1');
    if (showL2 !== DEFAULTS.l2) p.set('l2', '1');
    if (Math.round(overlayOpacity * 100) !== DEFAULTS.opacity) p.set('opacity', Math.round(overlayOpacity * 100));
    var qs = p.toString();
    var url = window.location.pathname + (qs ? '?' + qs : '');
    history.replaceState(null, '', url);
  }

  function loadFromURL() {
    var p = new URLSearchParams(window.location.search);
    return {
      range: parseInt(p.get('range')) || DEFAULTS.range,
      speed: parseInt(p.get('speed')) || DEFAULTS.speed,
      temp: p.has('temp') ? parseInt(p.get('temp')) : DEFAULTS.temp,
      soc: parseInt(p.get('soc')) || DEFAULTS.soc,
      reserve: p.has('reserve') ? parseInt(p.get('reserve')) : DEFAULTS.reserve,
      chargeTo: parseInt(p.get('chargeTo')) || DEFAULTS.chargeTo,
      batteryKwh: parseInt(p.get('batteryKwh')) || DEFAULTS.batteryKwh,
      preferMajor: p.has('preferMajor') ? p.get('preferMajor') !== '0' : DEFAULTS.preferMajor,
      mode: p.get('mode') || DEFAULTS.mode,
      safe: p.get('safe') === '1',
      l2: p.get('l2') === '1',
      opacity: parseInt(p.get('opacity')) || DEFAULTS.opacity,
    };
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
      applyState(loadFromURL());
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
