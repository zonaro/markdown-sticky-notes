#!/usr/bin/env bash
# Install GNOME sticky notes for the current user, preserving a rollback copy.
set -euo pipefail
cd "$(dirname "$0")"

uuid="$(python3 -c 'import json; print(json.load(open("extension/metadata.json"))["uuid"])')"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
ext="$data_home/gnome-shell/extensions/$uuid"
backup_dir="$data_home/gnome-notes-extension-backups"
if [[ -d "$ext" ]]; then
    mkdir -p "$backup_dir"
    backup="$backup_dir/$uuid-$(date +%Y%m%d-%H%M%S)"
    cp -a "$ext" "$backup"
    echo "Previous installation backed up to: $backup"
fi

# Explicitly remove old extension code, but NEVER change ~/notes.
rm -rf "$ext"
mkdir -p "$ext/schemas"
cp extension/metadata.json extension/*.js extension/stylesheet.css "$ext/"
cp LICENSE "$ext/LICENSE"
cp -a extension/icons "$ext/"
cp extension/schemas/org.gnome.shell.extensions.sticky-notes.gschema.xml "$ext/schemas/"
glib-compile-schemas "$ext/schemas"

if gnome-extensions info "$uuid" >/dev/null 2>&1; then
    gnome-extensions disable "$uuid" >/dev/null 2>&1 || true
    gnome-extensions enable "$uuid" || echo "Log out and back in to activate the updated extension."
else
    echo "Log out and back in, then run: gnome-extensions enable $uuid"
fi

echo "Installed: $ext"
echo "Your Markdown files remain in: $HOME/notes/"
