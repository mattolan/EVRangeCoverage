// Charger station loading, circle drawing, risk coloring, popups

let stations = [];
let circleLayer = null;
let markerLayer = null;

const RISK_COLORS = {
  red:    { color: '#ff4136', fillColor: '#ff4136' },
  yellow: { color: '#ffdc00', fillColor: '#ffdc00' },
  green:  { color: '#2ecc40', fillColor: '#2ecc40' },
};

function getRiskLevel(connectorCount) {
  if (connectorCount >= 3) return 'green';
  if (connectorCount === 2) return 'yellow';
  return 'red';
}

export async function loadChargers() {
  const resp = await fetch('data/chargers.json');
  if (!resp.ok) throw new Error(`Failed to load chargers: ${resp.status}`);
  stations = await resp.json();
  return stations;
}

export function getStations() {
  return stations;
}

/**
 * Draw coverage circles and markers on the map.
 * @param {L.Map} map - Leaflet map instance
 * @param {number} radiusKm - Circle radius in km
 * @param {boolean} safeRoute - If true, dim single-charger stations
 */
export function drawCircles(map, radiusKm, safeRoute = false) {
  // Clear existing layers
  if (circleLayer) map.removeLayer(circleLayer);
  if (markerLayer) map.removeLayer(markerLayer);

  circleLayer = L.layerGroup();
  markerLayer = L.layerGroup();

  stations.forEach(station => {
    const risk = getRiskLevel(station.connectorCount);
    const colors = RISK_COLORS[risk];
    const isSingleCharger = risk === 'red';
    const dimmed = safeRoute && isSingleCharger;

    // Coverage circle
    const circle = L.circle([station.lat, station.lng], {
      radius: radiusKm * 1000, // Leaflet uses meters
      color: colors.color,
      fillColor: colors.fillColor,
      fillOpacity: dimmed ? 0.02 : 0.12,
      weight: dimmed ? 0.5 : 1.5,
      opacity: dimmed ? 0.1 : 0.6,
    });
    circleLayer.addLayer(circle);

    // Station marker (small circle marker)
    const marker = L.circleMarker([station.lat, station.lng], {
      radius: 6,
      color: '#fff',
      weight: 2,
      fillColor: colors.fillColor,
      fillOpacity: dimmed ? 0.2 : 1,
      opacity: dimmed ? 0.3 : 1,
    });

    // Popup
    marker.bindPopup(buildPopup(station, risk));
    markerLayer.addLayer(marker);
  });

  circleLayer.addTo(map);
  markerLayer.addTo(map);
}

function buildPopup(station, risk) {
  const warning = risk === 'red'
    ? `<div class="popup-warning">⚠ Single charger — have a backup plan</div>`
    : '';

  return `
    <div class="popup-station">
      <h3>${station.name}</h3>
      <div class="popup-detail">
        <strong>Address:</strong> ${station.address}<br>
        <strong>Network:</strong> ${station.network}<br>
        <strong>Connectors:</strong> ${station.connectorCount} (${station.connectorTypes.join(', ')})<br>
        <strong>Power:</strong> ${station.powerKw} kW<br>
        <strong>Status:</strong> ${station.status}
      </div>
      ${warning}
    </div>
  `;
}
