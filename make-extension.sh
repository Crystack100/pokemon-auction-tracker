#!/bin/sh
# Copies the shared tracker page into the Chrome extension folder.
cd "$(dirname "$0")"
cp parser.js app.js bridge.js extension/
cp index.html extension/dashboard.html
mkdir -p extension/assets && cp assets/logo.svg assets/icon-16.png assets/icon-32.png assets/icon-48.png assets/icon-128.png extension/assets/
echo "extension/ is ready to load in chrome://extensions"
