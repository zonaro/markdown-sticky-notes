import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NAME_TO_COLOR_SOURCE_REF,
    resolveNameToColor,
} from '../extension/name-to-color.js';

test('NameToColor source is pinned for reproducible vendoring', () => {
    assert.equal(NAME_TO_COLOR_SOURCE_REF, '24433eef070b99891a1d0546c2c755d69e5e2f2b');
});

test('hexadecimal and named colors match NameToColor vectors', () => {
    assert.equal(resolveNameToColor('#abc'), '#aabbcc');
    assert.equal(resolveNameToColor('#AABBCC'), '#aabbcc');
    assert.equal(resolveNameToColor('red'), '#ff0000');
    assert.equal(resolveNameToColor('vermelho'), '#ff0000');
    assert.equal(resolveNameToColor('Dark Blue'), '#0000c8');
});

test('moods and arbitrary strings match NameToColor vectors', () => {
    assert.equal(resolveNameToColor('calm'), '#f3ffd8');
    assert.equal(resolveNameToColor('calma'), '#f3ffd8');
    assert.equal(resolveNameToColor('energia'), '#e91c4f');
    assert.equal(resolveNameToColor('focus mode'), '#a4a070');
    assert.equal(resolveNameToColor('😀'), '#4c4f56');
});

test('arbitrary input is deterministic and unsafe color forms are rejected', () => {
    const first = resolveNameToColor('uma tarde chuvosa');
    assert.match(first, /^#[0-9a-f]{6}$/);
    assert.equal(resolveNameToColor('uma tarde chuvosa'), first);
    assert.equal(resolveNameToColor(''), null);
    assert.equal(resolveNameToColor('transparent'), null);
});
