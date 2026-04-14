#!/bin/bash
# Setup USGS Earthquake data source in Uplink Connect
# This script configures a real public API source and triggers an initial collection

set -e

CORE_URL="https://uplink-core.codyboring.workers.dev"

if [ -z "$CORE_INTERNAL_KEY" ]; then
  echo "Error: CORE_INTERNAL_KEY environment variable is required"
  exit 1
fi

echo "Creating USGS Earthquake source..."

curl -s -X POST "$CORE_URL/internal/sources" \
  -H "Content-Type: application/json" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -d '{
    "sourceId": "usgs-earthquakes-hourly",
    "name": "USGS Earthquakes (Past Hour)",
    "type": "api",
    "endpointUrl": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
    "requestMethod": "GET",
    "requestHeaders": {
      "Accept": "application/json"
    },
    "policy": {
      "minIntervalSeconds": 300,
      "leaseTtlSeconds": 300,
      "maxRecordsPerRun": 500,
      "retryLimit": 3
    }
  }' | jq .

echo ""
echo "Triggering initial collection..."

curl -s -X POST "$CORE_URL/internal/sources/usgs-earthquakes-hourly/trigger" \
  -H "Content-Type: application/json" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -d '{
    "triggeredBy": "setup-script",
    "reason": "Initial setup and test"
  }' | jq .

echo ""
echo "Source configured. Check dashboard at: $CORE_URL/dashboard"
