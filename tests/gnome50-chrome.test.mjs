import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const layer = readFileSync(new URL('../extension/layer.js', import.meta.url), 'utf8');
const notes = readFileSync(new URL('../extension/notes.js', import.meta.url), 'utf8');

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
