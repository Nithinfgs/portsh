#!/usr/bin/env bash
# Works on the author's Linux laptop. What happens on a teammate's Mac?
set -euo pipefail

JOBS=$(nproc)
VERSION=$(grep -oP 'version = "\K[^"]+' Cargo.toml)
sed -i "s/__VERSION__/$VERSION/" config/app.conf
find dist -name '*.tgz' -printf '%f\n' > manifest.txt
