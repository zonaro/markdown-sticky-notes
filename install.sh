#!/usr/bin/env bash
# Install Notes for GNOME 50/51 for the current user, without sudo.
set -euo pipefail

UUID='notes@maestroschan.fr'
REPO='https://github.com/zonaro/notes-extension-gnome'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf -- "$WORK_DIR"' EXIT

if [[ "${1:-}" == '--github' ]]; then
    if command -v curl >/dev/null 2>&1; then
        curl -fLsS "$REPO/archive/refs/heads/master.tar.gz" -o "$WORK_DIR/source.tar.gz"
        tar -xzf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR"
        SOURCE_DIR="$WORK_DIR/notes-extension-gnome-master/$UUID"
    elif command -v git >/dev/null 2>&1; then
        git clone --quiet --depth 1 "$REPO.git" "$WORK_DIR/source"
        SOURCE_DIR="$WORK_DIR/source/$UUID"
    else
        echo 'Error: curl or git is required for --github.' >&2
        exit 1
    fi
else
    SOURCE_DIR="$SCRIPT_DIR/$UUID"
fi

if [[ ! -f "$SOURCE_DIR/metadata.json" ]]; then
    echo "Error: extension source not found: $SOURCE_DIR" >&2
    exit 1
fi

for required in glib-compile-schemas; do
    if ! command -v "$required" >/dev/null 2>&1; then
        echo "Error: $required is missing (install glib2-devel/glib2-tools)." >&2
        exit 1
    fi
done

if command -v gnome-shell >/dev/null 2>&1; then
    shell_version="$(gnome-shell --version | sed -nE 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/p')"
    if [[ -n "$shell_version" && "$shell_version" != 50 && "$shell_version" != 51 ]]; then
        echo "Error: this version supports GNOME Shell 50 and 51, found ${shell_version}." >&2
        exit 1
    fi
fi

XDG_USER_DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
EXTENSIONS_DIR="$XDG_USER_DATA/gnome-shell/extensions"
BACKUPS_DIR="$XDG_USER_DATA/gnome-notes-extension-backups"
DESTINATION="$EXTENSIONS_DIR/$UUID"

mkdir -p "$EXTENSIONS_DIR" "$BACKUPS_DIR"
cp -a -- "$SOURCE_DIR" "$WORK_DIR/$UUID"
glib-compile-schemas "$WORK_DIR/$UUID/schemas"

if [[ -e "$DESTINATION" ]]; then
    backup="$BACKUPS_DIR/${UUID}.$(date +%Y%m%d-%H%M%S)"
    if [[ -e "$backup" ]]; then
        backup="$backup.$$"
    fi
    mv -- "$DESTINATION" "$backup"
    echo "Previous extension backed up to: $backup"
fi

mv -- "$WORK_DIR/$UUID" "$DESTINATION"
echo "Installed to: $DESTINATION"
echo 'Your notes will be stored in ~/notes/ as Markdown files.'
echo 'Legacy notes are copied on first enable; the original files are preserved.'
echo "Log out and log in again, then enable with: gnome-extensions enable '$UUID'"
