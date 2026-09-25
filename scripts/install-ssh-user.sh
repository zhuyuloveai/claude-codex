#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL_DIR="${CHRYS_CODEX_INSTALL_DIR:-$HOME/.local/share/chrys-codex-adapter}"
BIN_DIR="${CHRYS_CODEX_BIN_DIR:-$HOME/bin}"

command -v node >/dev/null || { echo "Node.js 24+ is required" >&2; exit 1; }
command -v chrys >/dev/null || { echo "Chrys is not available on PATH" >&2; exit 1; }
node -e 'const major=Number(process.versions.node.split(".")[0]); if(major<24) process.exit(1)' || {
  echo "Node.js 24+ is required" >&2
  exit 1
}

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules"
cp -R "$ROOT/dist" "$INSTALL_DIR/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$INSTALL_DIR/"
for file in LICENSE NOTICE; do
  [ ! -f "$ROOT/$file" ] || cp "$ROOT/$file" "$INSTALL_DIR/$file"
done
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$INSTALL_DIR"
install -m 0755 "$ROOT/scripts/codex-shim" "$BIN_DIR/codex"

cat <<EOF
Installed Chrys Codex adapter:
  adapter: $INSTALL_DIR/dist/src/adapter.mjs
  shim:    $BIN_DIR/codex

Ensure the SSH login environment contains:
  export PATH="$BIN_DIR:\$PATH"
  export CHRYS_CODEX_ADAPTER="$INSTALL_DIR/dist/src/adapter.mjs"

Then verify from the account used by Codex Remote:
  command -v codex
  codex --version
  command -v chrys
EOF
