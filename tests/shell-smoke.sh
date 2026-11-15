#!/bin/sh
# Actual GNOME Shell acceptance with disposable fixtures, never the user's notes.
# Dependencies: GNOME Shell 50/51, GJS, dconf, a working headless renderer, Node.
set -eu

if [ "${1:-}" = --inner ]; then
    gsettings set org.gnome.shell enabled-extensions \
        "['notes@redclaw.com.br', 'notes-smoke@redclaw.com.br']"
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.desktop.interface enable-animations false
    gnome-shell --headless --no-x11 --wayland --virtual-monitor 1280x800 \
        >"$NOTES_SMOKE_DIR/shell.log" 2>&1 &
    shell_pid=$!
    trap 'kill "$shell_pid" 2>/dev/null || true; wait "$shell_pid" 2>/dev/null || true' EXIT HUP INT TERM
    attempts=0
    while [ ! -f "$NOTES_SMOKE_DIR/result.json" ]; do
        if ! kill -0 "$shell_pid" 2>/dev/null; then
            echo "Isolated GNOME Shell exited before the probe finished." >&2
            exit 1
        fi
        attempts=$((attempts + 1))
        if [ "$attempts" -gt 45 ]; then
            echo "Timed out waiting for the isolated Shell acceptance probe." >&2
            exit 1
        fi
        sleep 1
    done
    exit 0
fi

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
for command in gnome-shell gjs dbus-run-session gsettings glib-compile-schemas node timeout; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "Missing test dependency: $command" >&2
        exit 77
    fi
done
mkdir -p /tmp/opencode
sandbox=$(mktemp -d /tmp/opencode/notes-shell-smoke.XXXXXX)
extensions="$sandbox/home/.local/share/gnome-shell/extensions"
mkdir -p "$extensions" "$sandbox/run" "$sandbox/config" "$sandbox/cache"
chmod 700 "$sandbox" "$sandbox/run"
cp -R "$repo/extension" "$extensions/notes@redclaw.com.br"
glib-compile-schemas --strict "$extensions/notes@redclaw.com.br/schemas"
mkdir -p "$extensions/notes-smoke@redclaw.com.br"
cp "$repo/tests/shell-probe.js" "$extensions/notes-smoke@redclaw.com.br/extension.js"
printf '%s\n' '{"uuid":"notes-smoke@redclaw.com.br","name":"Notes isolated acceptance","description":"Disposable local fixtures only","shell-version":["50","51"]}' \
    >"$extensions/notes-smoke@redclaw.com.br/metadata.json"

node --input-type=module - "$sandbox" <<'JS'
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
const home = join(process.argv[2], 'home');
const fixtures = [
    ['root.md', 1, 40, 80, '# Root note\n- [ ] acceptance task\n'],
    ['projects/2026/note.md', 2, 370, 80, '# Nested note\nEditable text\n'],
];
for (const [name, id, x, y, body] of fixtures) {
    const path = join(home, 'notes', name);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, `---\ngnome-sticky-id: ${id}\ngnome-sticky-x: ${x}\ngnome-sticky-y: ${y}\ngnome-sticky-width: 300\ngnome-sticky-height: 220\ngnome-sticky-pinned: true\n---\n${body}`);
}
const imageFixtures = [
    ['stickers/alpha.png', 5, 370, 360, 260, 180],
    ['stickers/photo.jpg', 6, 650, 360, 260, 180],
];
for (const [name, id, x, y, width, height] of imageFixtures) {
    const path = join(home, 'notes', name);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, ''); // placeholder, overwritten by gjs call below
}
const plainPath = join(home, 'notes', 'Long category with accents ações/Another long folder/idea.txt');
mkdirSync(dirname(plainPath), {recursive: true});
writeFileSync(plainPath, '# Literal TXT\n*stars stay literal*\n[link](javascript:alert(1))\n- [ ] plain checkbox\n');
const htmlPath = join(home, 'notes', 'web/safe.html');
mkdirSync(dirname(htmlPath), {recursive: true});
writeFileSync(htmlPath, '<h1>Safe HTML</h1><p onclick="alert(1)">Visible <strong>content</strong>.</p><script>globalThis.PWNED=true</script><iframe src="https://evil.example"></iframe><a href="javascript:alert(2)">Text link</a>\n');
mkdirSync(join(home, 'notes', 'stickers'), {recursive: true});
writeFileSync(join(home, 'notes', 'stickers/corrupt.jpg'), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
const sidecar = (name, id, x, y, width = 300, height = 220) => {
    const source = join(home, 'notes', name);
    const metadata = join(dirname(source), `.${source.split('/').pop()}.sticky-note.json`);
    writeFileSync(metadata, `${JSON.stringify({version: 1, metadata: {
        id, x, y, w: width, h: height, expanded_h: height, color: id % 16,
        size: 13, workspace: 0, pinned: true, locked: false, zoom: 100,
        spans: [], sizes: [],
    }}, null, 2)}\n`);
};
sidecar('Long category with accents ações/Another long folder/idea.txt', 3, 700, 80);
sidecar('web/safe.html', 4, 40, 360);
sidecar('stickers/alpha.png', 5, 370, 360, 260, 180);
sidecar('stickers/photo.jpg', 6, 650, 360, 260, 180);
sidecar('stickers/corrupt.jpg', 7, 930, 360, 220, 180);
writeFileSync(join(home, 'notes', 'projects/2026/.board.md'), '# Inert legacy metadata\n');
writeFileSync(join(home, 'notes', 'projects/2026/unrelated.json'), '{"keep":true}\n');
mkdirSync(join(home, 'notes', '.hidden'));
writeFileSync(join(home, 'notes', '.hidden/ignored.md'), 'Not a visible note\n');
writeFileSync(join(home, 'todo.txt'), '2026-11-13 Smoke task +checks\n');
JS
gjs -c 'const GdkPixbuf=imports.gi.GdkPixbuf; const root=ARGV[0]; let png=GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,true,8,2,1); png.fill(0xff000080); png.savev(root+"/alpha.png","png",[],[]); let jpg=GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,false,8,3,2); jpg.fill(0x336699ff); jpg.savev(root+"/photo.jpg","jpeg",["quality"],["90"]);' \
    "$sandbox/home/notes/stickers"

echo "Shell acceptance artifacts: $sandbox"
status=0
env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY -u SESSION_MANAGER \
    HOME="$sandbox/home" XDG_DATA_HOME="$sandbox/home/.local/share" \
    XDG_CONFIG_HOME="$sandbox/config" XDG_CACHE_HOME="$sandbox/cache" \
    XDG_RUNTIME_DIR="$sandbox/run" XDG_DATA_DIRS=/usr/local/share:/usr/share \
    XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME \
    LC_ALL=C LANG=C.UTF-8 LANGUAGE=en \
    GVFS_DISABLE_FUSE=1 NO_AT_BRIDGE=1 GTK_A11Y=none \
    NOTES_SMOKE_DIR="$sandbox" \
    timeout 65 dbus-run-session -- sh "$repo/tests/shell-smoke.sh" --inner \
    >"$sandbox/session.log" 2>&1 || status=$?
node --input-type=module - "$sandbox" "$status" <<'JS'
import {readFileSync, existsSync} from 'node:fs';
const path = process.argv[2];
const report = `${path}/result.json`;
if (!existsSync(report)) {
    console.error('FAIL: no acceptance report; inspect session.log and shell.log');
    process.exit(1);
}
const result = JSON.parse(readFileSync(report, 'utf8'));
for (const check of result.checks) console.log(`PASS: ${check}`);
if (result.error) console.error(result.error);
const log = readFileSync(`${path}/shell.log`, 'utf8');
const errors = log.split('\n').filter(line =>
    /JS ERROR|Exception in callback|Theme parsing error|Sticky Notes: (?:could not|cannot)/.test(line));
for (const error of errors) console.error(error);
console.log(`Assertions: ${result.checks.length}; Shell/extension errors: ${errors.length}`);
process.exit(result.ok && errors.length === 0 && process.argv[3] === '0' ? 0 : 1);
JS
