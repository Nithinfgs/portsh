#!/usr/bin/env bash
# Install helper, the kind of script that works on the author's laptop.
set -euo pipefail

VERSION=$(grep -oP 'version = "\K[^"]+' Cargo.toml)
JOBS=$(nproc)
STAMP=$(date -d "yesterday" +%Y-%m-%d)

sed -i 's/__VERSION__/'"$VERSION"'/' config/app.conf
size=$(stat -c %s dist/app.tar.gz)
find dist -name '*.tgz' -printf '%f\n' | sort > manifest.txt
mapfile -t targets < manifest.txt

if [[ "$OSTYPE" == "darwin"* ]]; then
  pbcopy < manifest.txt
else
  xclip -selection clipboard < manifest.txt
fi

echo "built ${#targets[@]} artifacts for v${VERSION^^} in ${JOBS} jobs ($size bytes, $STAMP)"
