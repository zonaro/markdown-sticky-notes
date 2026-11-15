import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const layer = readFileSync(new URL('../extension/layer.js', import.meta.url), 'utf8');
const notes = readFileSync(new URL('../extension/notes.js', import.meta.url), 'utf8');
const extension = readFileSync(new URL('../extension/extension.js', import.meta.url), 'utf8');

test('pinned notes use only GNOME Shell 50/51 supported LayoutManager options', () => {
    for (const source of [layer, notes]) {
        assert.doesNotMatch(source, /affectsInputRegion/,
            'GNOME 50/51 removed affectsInputRegion from addChrome/trackChrome');
    }
    assert.match(layer, /addChrome\(this\.actor,\s*\{\s*affectsStruts:\s*false,\s*trackFullscreen:\s*true,/);
    assert.match(layer, /name:\s*'sticky-notes-pinned',[\s\S]*?reactive:\s*false/);
});

test('pinned note actors remain interactive and are reparented on pin changes', () => {
    assert.match(notes, /_layerFor\(note\)/);
    assert.match(notes, /note\.pinned\s*\?\s*this\._pinnedLayer\.actor\s*:\s*this\._layer/);
    assert.match(notes, /_moveToLayer\(view\)/);
    assert.match(notes, /frame\s*=\s*new St\.Widget\(\{\s*layout_manager:[\s\S]*?reactive:\s*true/);
});

test('category pill created for notes in subdirectories', () => {
    // One pill per folder level, derived from the note's relative file path.
    assert.match(notes, /categoryPartsFromRelpath/);
    assert.match(notes, /categoryPill/);
    assert.match(notes, /clutter_text\.ellipsize\s*=\s*Pango\.EllipsizeMode\.END/);
    assert.match(notes, /pill\.clutter_text\.line_wrap\s*=\s*false/);
    // Accessible name exposes the full category when pills are ellipsized
    assert.match(notes, /accessible_name\s*=\s*parts\.map/);
});

test('labels use St properties and pass required Clutter sizing arguments', () => {
    const constructors = [...notes.matchAll(/new St\.Label\(\{([\s\S]*?)\n\s*\}\)/g)];
    assert.ok(constructors.length > 0);
    for (const [, properties] of constructors) {
        assert.doesNotMatch(properties, /\b(?:line_wrap|ellipsize)\s*:/,
            'line_wrap and ellipsize belong to label.clutter_text, not St.Label');
    }
    assert.doesNotMatch(notes, /\.get_preferred_width\(\s*\)/,
        'Clutter.Actor.get_preferred_width requires a for_height argument');
});

test('Shell menus use only St/Clutter actors and CSS spacing', () => {
    // Only check the _openMenu function and menu-related code for GTK/GDK usage.
    // The extension legitimately uses Gdk.Texture/GdkPixbuf for image rendering
    // in note content (not menus), which is GDK 4 paintable API, not GTK widgets.
    const openMenu = notes.slice(notes.indexOf('    _openMenu(view) {'),
        notes.indexOf('    // Shared menu tail:', notes.indexOf('    _openMenu(view) {')));
    assert.doesNotMatch(openMenu, /gi:\/\/(?:Gtk|Gdk)['"]/,
        'GTK/GDK widgets cannot be embedded in the GNOME Shell actor tree');
    assert.doesNotMatch(openMenu, /\b(?:Gtk|Gdk)\./,
        'note menus must not construct GTK/GDK objects');
    const constructors = [...notes.matchAll(/new St\.BoxLayout\(\{([\s\S]*?)\n\s*\}\)/g)];
    for (const [, properties] of constructors) {
        assert.doesNotMatch(properties, /\bspacing\s*:/,
            'St.BoxLayout spacing belongs in the stylesheet, not constructor properties');
    }
});

test('compact note-menu buttons execute actions without waiting for menu closure', () => {
    const openMenu = notes.slice(notes.indexOf('    _openMenu(view) {'),
        notes.indexOf('    // Shared menu tail:', notes.indexOf('    _openMenu(view) {')));
    assert.match(openMenu, /const run = fn => \{/);
    assert.doesNotMatch(openMenu, /\blater\(/,
        'St.Button does not auto-close PopupMenu, so deferred handlers never run');
});

test('expiry changes and resizing share header layout', () => {
    assert.ok((notes.match(/this\._layoutHeader\(view\)/g) ?? []).length >= 2);
    // Pixel bounds and resize recovery are asserted in the real Shell smoke test.
});

test('KeyController callback uses get_key/get_state API (Shell 51)', () => {
    // _addClipboardKeyController reads keyval via get_key() and state via get_state()
    assert.match(notes, /controller\.get_key\(\)/);
    assert.match(notes, /controller\.get_state\(\)/);
    // No deprecated (controller, keyval, keycode, state) signature
    assert.doesNotMatch(notes, /_addClipboardKeyController[\s\S]*?connectObject\(['"]key-press['"],\s*\(_c,\s*keyval,\s*keycode,\s*state\)/);
    // Does not intercept Ctrl+Shift+C (code) or Ctrl+Shift+X (strikethrough) - lets format shortcuts handle them
    assert.match(notes, /if \(shift\)\s*return Clutter\.EVENT_PROPAGATE/);
});

test('editing clipboard uses GNOME Shell St.Clipboard APIs', () => {
    assert.match(notes, /St\.Clipboard\.get_default\(\)\.get_text\(St\.ClipboardType\.CLIPBOARD,/);
    assert.match(notes, /St\.Clipboard\.get_default\(\)\.set_text\(St\.ClipboardType\.CLIPBOARD,/);
    assert.doesNotMatch(notes, /\.(?:copy|cut|paste)_clipboard\(/,
        'Clutter.Text does not expose GTK clipboard helper methods');
    assert.doesNotMatch(notes, /\.select_region\(/,
        'Clutter.Text selects with set_selection, not GTK select_region');
});

test('removed size-limit settings are not observed at runtime', () => {
    assert.doesNotMatch(extension, /['"]max-(?:width|height)['"]/);
});
test('key controllers never set a propagation phase (removed in mutter 51)', () => {
    // Clutter.PropagationPhase is gone: the enum is Clutter.EventPhase and
    // Clutter.Action exposes no public propagation setter.
    for (const source of [layer, notes, extension]) {
        assert.doesNotMatch(source, /Clutter\.PropagationPhase\b/,
            'Clutter.PropagationPhase does not exist in GNOME Shell 50/51');
        assert.doesNotMatch(source, /\.set_propagation_phase\(/,
            'Clutter.Action has no phase setter in GNOME Shell 50/51');
    }
});
