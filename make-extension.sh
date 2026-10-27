#!/bin/sh
# Copies the shared tracker page into the Chrome extension folder.
cd "$(dirname "$0")"
cp parser.js app.js extension/
cp index.html extension/dashboard.html
echo "extension/ is ready to load in chrome://extensions"
