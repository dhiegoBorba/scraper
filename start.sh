#!/bin/sh
set -e

echo "=== Starting ... ==="

# Forçar flush imediato de logs
export NODE_OPTIONS="--enable-source-maps"

# Rodar o script com xvfb
xvfb-run -a -s "-screen 0 1920x1080x24" node /app/test/toxicologicalTest.js
