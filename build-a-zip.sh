#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UUID='notes@maestroschan.fr'

if ! command -v zip >/dev/null 2>&1 || ! command -v glib-compile-schemas >/dev/null 2>&1; then
    echo 'zip and glib-compile-schemas are required.' >&2
    exit 1
fi

glib-compile-schemas "$ROOT/$UUID/schemas"

(
    cd "$ROOT/$UUID"
    zip -q -r -FS "$ROOT/$UUID.zip" \
        extension.js noteBox.js menus.js dialog.js markdown.js prefs.js \
        stylesheet.css metadata.json schemas locale screenshots \
        -x '*.po' '*.pot'
)
echo "Created: $ROOT/$UUID.zip"
