// Map initialization and view presets

const ALBERTA_CENTER = [53.93, -116.58];
const ALBERTA_ZOOM = 6;
const CANADA_CENTER = [56.13, -106.35];
const CANADA_ZOOM = 4;

let map;

export function initMap() {
  map = L.map('map', {
    center: ALBERTA_CENTER,
    zoom: ALBERTA_ZOOM,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(map);

  return map;
}

export function viewAlberta() {
  map.setView(ALBERTA_CENTER, ALBERTA_ZOOM);
}

export function viewCanada() {
  map.setView(CANADA_CENTER, CANADA_ZOOM);
}

export function getMap() {
  return map;
}
