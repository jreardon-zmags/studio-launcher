#!/bin/bash
# Double-click this file in Finder to start Studio Launcher.
# On first run, installs dependencies automatically.
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
  echo "First run — installing dependencies..."
  npm install
fi
./node_modules/.bin/electron . &
