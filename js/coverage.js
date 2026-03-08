// Grid-sampling coverage calculator for Alberta

// Simplified Alberta boundary polygon (~20 vertices)
const ALBERTA_POLYGON = [
  [49.0, -120.0], [49.0, -110.0],  // south border
  [52.0, -110.0], [54.0, -110.0],  // east border
  [56.0, -110.0], [58.0, -110.0],
  [60.0, -110.0],                   // NE corner
  [60.0, -120.0],                   // NW corner
  [58.0, -120.0], [56.0, -120.0],  // west border
  [54.0, -120.0], [52.0, -120.0],
];

const LAT_MIN = 49.0;
const LAT_MAX = 60.0;
const LNG_MIN = -120.0;
const LNG_MAX = -110.0;

// Generate grid points (pre-computed)
const GRID_STEP = 0.08; // ~8.9 km lat, ~5-6 km lng → ~20k points in Alberta
let albertaPoints = null;

function generateAlbertaGrid() {
  if (albertaPoints) return albertaPoints;

  albertaPoints = [];
  for (let lat = LAT_MIN; lat <= LAT_MAX; lat += GRID_STEP) {
    for (let lng = LNG_MIN; lng <= LNG_MAX; lng += GRID_STEP) {
      if (pointInPolygon(lat, lng, ALBERTA_POLYGON)) {
        albertaPoints.push([lat, lng]);
      }
    }
  }
  return albertaPoints;
}

function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i][0], xi = polygon[i][1];
    const yj = polygon[j][0], xj = polygon[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// Haversine distance in km
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Calculate the percentage of Alberta grid points covered by charger circles.
 * @param {Array} stations - Charger stations
 * @param {number} radiusKm - Circle radius in km
 * @param {boolean} safeRoute - Exclude single-charger stations
 * @returns {number} Coverage percentage (0-100)
 */
export function calculateCoverage(stations, radiusKm, safeRoute = false) {
  const points = generateAlbertaGrid();
  const activeStations = safeRoute
    ? stations.filter(s => s.connectorCount >= 2)
    : stations;

  if (activeStations.length === 0) return 0;

  let covered = 0;

  for (const [pLat, pLng] of points) {
    for (const s of activeStations) {
      if (haversineKm(pLat, pLng, s.lat, s.lng) <= radiusKm) {
        covered++;
        break;
      }
    }
  }

  return (covered / points.length) * 100;
}
