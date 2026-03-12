#!/bin/bash
set -e

echo "[post-merge] Installing dependencies..."
npm install --prefer-offline --no-audit --no-fund < /dev/null 2>&1

echo "[post-merge] Done."
