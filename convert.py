"""
Convert NREL AFDC JSON export to chargers.json for the EV Coverage Map.

Usage:
  python convert.py "C:\Users\Desktop\Downloads\Charger List Alberta.txt"
"""

import json
import sys

INPUT = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\Desktop\Downloads\Charger List Alberta.txt"
OUTPUT = r"C:\code\EVRangeCoverage\data\chargers.json"

# Connector type normalization — exclude CHAdeMO
CONNECTOR_MAP = {
    "CCS": "CCS",
    "TESLA": "Tesla",
    "J1772": "J1772",
    "J1772COMBO": "CCS",
    "NEMA_5_15": None,     # L1, skip
    "NEMA_5_20": None,     # L1, skip
    "NEMA_14_50": None,    # L1/L2 outlet, skip
    "CHADEMO": None,       # Excluded per user request
}

STATUS_MAP = {
    "E": "operational",
    "T": "temporary_outage",
    "P": "planned",
}

with open(INPUT, "r", encoding="utf-8") as f:
    raw = json.load(f)

fuel_stations = raw.get("fuel_stations", [])
print(f"Total stations in file: {len(fuel_stations)}")

output = []
skipped_private = 0
skipped_l1_only = 0
idx = 0

for s in fuel_stations:
    # Filter: public only
    if s.get("access_code", "").lower() != "public":
        skipped_private += 1
        continue

    # Filter: must be electric
    if s.get("fuel_type_code") != "ELEC":
        continue

    # Determine charger level
    dc_fast = s.get("ev_dc_fast_num") or 0
    level2 = s.get("ev_level2_evse_num") or 0
    level1 = s.get("ev_level1_evse_num") or 0

    # Exclude L1-only stations
    if dc_fast == 0 and level2 == 0:
        skipped_l1_only += 1
        continue

    if dc_fast > 0:
        charger_level = "DCFC"
    else:
        charger_level = "L2"

    # Connector count: DC fast ports only (excluding CHAdeMO connectors)
    # For L2 stations, use level2 count for risk coloring
    if charger_level == "DCFC":
        connector_count = dc_fast
    else:
        connector_count = level2

    # Normalize connector types — exclude CHAdeMO and L1
    raw_types = s.get("ev_connector_types") or []
    connector_types = []
    for ct in raw_types:
        mapped = CONNECTOR_MAP.get(ct, ct)
        if mapped and mapped not in connector_types:
            connector_types.append(mapped)

    # Build address
    parts = [s.get("street_address", ""), s.get("city", ""), s.get("state", "")]
    address = ", ".join(p for p in parts if p)

    # Status
    status_code = s.get("status_code", "E")
    status = STATUS_MAP.get(status_code, "operational")

    idx += 1
    entry = {
        "id": f"ab-{idx:04d}",
        "name": s.get("station_name", "Unknown"),
        "lat": s.get("latitude"),
        "lng": s.get("longitude"),
        "address": address,
        "network": s.get("ev_network", "Unknown"),
        "connectorCount": connector_count,
        "connectorTypes": connector_types,
        "chargerLevel": charger_level,
        "dcFastNum": dc_fast,
        "level2Num": level2,
        "status": status,
    }
    output.append(entry)

with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(output, f, indent=2)

# Stats
dcfc_count = sum(1 for s in output if s["chargerLevel"] == "DCFC")
l2_count = sum(1 for s in output if s["chargerLevel"] == "L2")
print(f"Exported: {len(output)} stations ({dcfc_count} DCFC, {l2_count} L2)")
print(f"Skipped: {skipped_private} private, {skipped_l1_only} L1-only")
print(f"Written to: {OUTPUT}")
