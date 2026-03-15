# EV Charger Coverage Map — Alberta

Interactive web app that visualizes EV charger coverage across Alberta, with a route planner that estimates charging stops, charge times, and state of charge along the way.

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

> **Note:** Opening `index.html` directly via `file://` won't work due to fetch restrictions. You need a local HTTP server.

## Features

### Coverage Map
- **Temperature adjustment** — slider from -40°C to +35°C with real-world range degradation
- **Speed adjustment** — accounts for highway speed energy consumption
- **Risk coloring** — green (3+ chargers), yellow (2), red (1 charger)
- **Coverage calculator** — grid-sampling algorithm shows % of Alberta covered
- **Range mode toggle** — round-trip safe (default) vs one-way
- **Safe Route mode** — hides single-charger stations from coverage
- **L2 charger toggle** — show or hide Level 2 stations

### Route Planner
- **Road-following routes** via OSRM (Open Source Routing Machine) demo server
- **Segment-based charger selection** — walks the route in leg-sized chunks, picking the best station for each segment (like a human would plan)
- **Smart station preference** — prefers major networks (Tesla, Petro-Canada, Electrify Canada), penalizes dealership chargers, considers connector count and proximity to amenities
- **SOC tracking** — shows arrival and departure state of charge at each stop
- **Charging time estimates** — based on battery size, SOC delta, and charger power rating
- **Separate starting SOC vs charge-to SOC** — accounts for leaving home at 100% but only charging to 80% at public stations
- **Battery size slider** — adjustable 30–200 kWh for accurate charge time estimates
- **Corridor fallback** — if the direct OSRM route has no charger coverage (e.g., Hwy 16 via Jasper), falls back to haversine routing to find alternate corridors with chargers
- **Feasibility display** — green/red route segments showing where coverage fails
- **Tesla access warnings** — flags older Tesla stations (<200 kW) that may have third-party access restrictions

### Charger Data
- **883 stations** from NREL AFDC (Alternative Fuels Station Locator)
- **Power ratings** (kW) for 77% of stations
- **Connector types** — CCS, NACS, CHAdeMO, J1772
- **Refreshable** — run `node scripts/fetch-chargers.js [API_KEY]` to pull latest data

## Data

- `data/chargers.json` — 883 Alberta charging stations from NREL AFDC
- `data/vehicles.json` — popular EV models with rated range and battery capacity
- `scripts/fetch-chargers.js` — data refresh script (requires free NREL API key from https://developer.nrel.gov/signup/)

## Tech Stack

- **Leaflet.js** + OpenStreetMap tiles for mapping
- **OSRM demo server** for road-following route geometry (free, no API key, rate-limited)
- **NREL AFDC API** for charger data
- Vanilla HTML/CSS/JS — no framework, no bundler, no backend
