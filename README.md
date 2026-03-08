# EV Charger Coverage Map — Alberta

Interactive web app that visualizes EV charger coverage across Alberta. Select your EV and adjust temperature to see how far you can reach from each charging station, with risk-coloring based on charger redundancy.

## Quick Start

No build step required. Serve the files with any static HTTP server:

```bash
# Python
python -m http.server 8000

# Node.js
npx serve .

# VS Code Live Server extension also works
```

Then open `http://localhost:8000` in your browser.

> **Note:** Opening `index.html` directly via `file://` won't work due to ES module and fetch restrictions. You need a local HTTP server.

## Features

- **Vehicle selection** — cascading Make → Year → Model dropdowns with ~15 popular EVs
- **Temperature adjustment** — slider from -40°C to +35°C with real-world range degradation
- **Risk coloring** — green (3+ chargers), yellow (2), red (1 charger)
- **Coverage calculator** — grid-sampling algorithm shows % of Alberta covered
- **Range mode toggle** — round-trip safe (default, half range) vs one-way (full range)
- **Safe Route mode** — hides single-charger stations from coverage calculation
- **Responsive** — sidebar collapses to bottom sheet on mobile

## Data

- `data/chargers.json` — 25 sample Alberta charging stations (replace with real data)
- `data/vehicles.json` — 15 popular EV models with rated range and battery capacity

## Tech Stack

Leaflet.js + OpenStreetMap tiles, vanilla HTML/CSS/JS, no framework, no bundler.
