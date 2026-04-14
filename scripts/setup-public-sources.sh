#!/bin/bash
# Setup multiple public data sources in Uplink Connect
# This script configures real public API sources and triggers initial collections

set -e

CORE_URL="https://uplink-core.codyboring.workers.dev"

if [ -z "$CORE_INTERNAL_KEY" ]; then
  echo "Error: CORE_INTERNAL_KEY environment variable is required"
  exit 1
fi

echo "Setting up public data sources..."

# 1. USGS Earthquakes (hourly)
echo "Creating USGS Earthquakes source..."
curl -s -X POST "$CORE_URL/internal/sources" \
  -H "Content-Type: application/json" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -d '{
    "sourceId": "usgs-earthquakes-hourly",
    "name": "USGS Earthquakes (Past Hour)",
    "type": "api",
    "adapterType": "api",
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

# 2. GitHub Public Events (every 5 min)
echo "Creating GitHub Public Events source..."
curl -s -X POST "$CORE_URL/internal/sources" \
  -H "Content-Type: application/json" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -d '{
    "sourceId": "github-public-events",
    "name": "GitHub Public Events",
    "type": "api",
    "adapterType": "api",
    "endpointUrl": "https://api.github.com/events?per_page=30",
    "requestMethod": "GET",
    "requestHeaders": {
      "Accept": "application/vnd.github+json"
    },
    "policy": {
      "minIntervalSeconds": 300,
      "leaseTtlSeconds": 300,
      "maxRecordsPerRun": 100,
      "retryLimit": 3
    }
  }' | jq .

# 3. Exchange Rates (daily)
echo "Creating Exchange Rates source..."
curl -s -X POST "$CORE_URL/internal/sources" \
  -H "Content-Type: application/json" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -d '{
    "sourceId": "exchange-rates-daily",
    "name": "Exchange Rates (USD Base)",
    "type": "api",
    "adapterType": "api",
    "endpointUrl": "https://api.exchangerate-api.com/v4/latest/USD",
    "requestMethod": "GET",
    "requestHeaders": {
      "Accept": "application/json"
    },
    "policy": {
      "minIntervalSeconds": 3600,
      "leaseTtlSeconds": 300,
      "maxRecordsPerRun": 10,
      "retryLimit": 3
    }
  }' | jq .

# 4. Hacker News Top Stories (every 15 min)
echo "Creating Hacker News Top Stories source..."
curl -s -X POST "$CORE_URL/internal/sources" \
  -H "Content-Type: application/json" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -d '{
    "sourceId": "hackernews-top-stories",
    "name": "Hacker News Top Stories",
    "type": "api",
    "adapterType": "api",
    "endpointUrl": "https://hacker-news.firebaseio.com/v0/topstories.json",
    "requestMethod": "GET",
    "requestHeaders": {
      "Accept": "application/json"
    },
    "policy": {
      "minIntervalSeconds": 900,
      "leaseTtlSeconds": 300,
      "maxRecordsPerRun": 50,
      "retryLimit": 3
    }
  }' | jq .

# 5. NWS Tennessee Weather (hourly)
echo "Creating NWS Tennessee Weather source..."
curl -s -X POST "$CORE_URL/internal/sources" \
  -H "Content-Type: application/json" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -d '{
    "sourceId": "nws-weather-tn",
    "name": "NWS Tennessee Weather",
    "type": "nws",
    "adapterType": "nws",
    "requestMethod": "GET",
    "requestHeaders": {
      "Accept": "application/geo+json"
    },
    "policy": {
      "minIntervalSeconds": 3600,
      "leaseTtlSeconds": 600,
      "maxRecordsPerRun": 200,
      "retryLimit": 3,
      "timeoutSeconds": 180
    },
    "metadata": {
      "stateCode": "TN",
      "delayMs": 200,
      "locations": [
        {"name":"Sullivan","lat":36.5122,"lon":-82.3047},
        {"name":"Carter","lat":36.2917,"lon":-82.1264},
        {"name":"Washington","lat":36.2933,"lon":-82.4972}
      ]
    }
  }' | jq .

echo ""
echo "Triggering initial collections..."

for source in usgs-earthquakes-hourly github-public-events exchange-rates-daily hackernews-top-stories nws-weather-tn; do
  echo "Triggering $source..."
  curl -s -X POST "$CORE_URL/internal/sources/$source/trigger" \
    -H "Content-Type: application/json" \
    -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
    -d '{
      "triggeredBy": "setup-script",
      "reason": "Initial setup and test"
    }' | jq .
  echo ""
done

echo "All sources configured. Check dashboard at: $CORE_URL/dashboard"
