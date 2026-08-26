#!/usr/bin/env bash
# =====================================================================
#  OpenPOS one-click launcher (macOS / Linux)
#  Double-click (or run) this file. It installs components on first run,
#  starts the server and opens your browser. Keep the terminal open while
#  you trade; Ctrl+C stops the server.
# =====================================================================
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install the LTS from https://nodejs.org, then run this again."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run - installing components, one time only..."
  npm install --no-audit --no-fund || { echo "Install failed. Check your connection."; exit 1; }
  echo "Components installed."
fi

# Open the default browser shortly after the server starts.
(
  sleep 3
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:3000"
  elif command -v open >/dev/null 2>&1; then open "http://localhost:3000"
  fi
) &

echo "Starting the POS server - keep this terminal open. Ctrl+C stops it."
node server.js
