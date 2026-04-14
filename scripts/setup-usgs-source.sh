#!/bin/bash
# Setup USGS Earthquake data source in Uplink Connect
# This is a convenience wrapper around setup-public-sources.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$CORE_INTERNAL_KEY" ]; then
  echo "Error: CORE_INTERNAL_KEY environment variable is required"
  exit 1
fi

echo "Setting up USGS Earthquake source (via setup-public-sources.sh)..."

# Run the full setup script, which is idempotent
CORE_INTERNAL_KEY="$CORE_INTERNAL_KEY" "$SCRIPT_DIR/setup-public-sources.sh"
