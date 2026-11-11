#!/usr/bin/env bash
# Test installation twice in an isolated HOME. It must preserve ~/notes.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
export XDG_DATA_HOME="$HOME/.local/share"
mkdir -p "$HOME/notes" "$tmp/bin"
printf '%s\n' 'Keep my Markdown intact.' > "$HOME/notes/keep.md"
# The shell CLI is not available in CI; this isolates only installation logic.
cat > "$tmp/bin/gnome-extensions" <<'EOF'
#!/bin/sh
case "$1" in
  info) exit 0 ;;
  disable|enable) exit 0 ;;
esac
EOF
chmod +x "$tmp/bin/gnome-extensions"
export PATH="$tmp/bin:$PATH"
bash install.sh >/dev/null
installed="$XDG_DATA_HOME/gnome-shell/extensions/notes@redclaw.com.br"
test -f "$installed/extension.js"
test -f "$installed/schemas/gschemas.compiled"
printf '%s\n' 'installed before second run' > "$installed/old-marker"
bash install.sh >/dev/null
backup="$(find "$XDG_DATA_HOME/gnome-notes-extension-backups" -type f -name old-marker -print -quit)"
test -n "$backup"
test "$(cat "$HOME/notes/keep.md")" = "Keep my Markdown intact."
test "$(find "$HOME/notes" -type f | wc -l)" -eq 1
printf '%s\n' 'PASS: install/update backup and Markdown preservation'
