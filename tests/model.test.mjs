import test from 'node:test';
import assert from 'node:assert/strict';

import {parseExpires, formatExpires, expiresToFrontmatter, normalizeHexColor, hexIsDark, normalizeZoom} from '../extension/model.js';

test('parseExpires accepts date-only and datetime forms', () => {
    assert.equal(parseExpires('2026-11-20')?.getDate(), 20);
    const withSpace = parseExpires('2026-11-20 18:30');
    assert.equal(withSpace?.getDate(), 20);
    assert.equal(withSpace?.getHours(), 18);
    assert.equal(withSpace?.getMinutes(), 30);
    const withT = parseExpires('2026-11-20T09:15');
    assert.equal(withT?.getHours(), 9);
    assert.equal(withT?.getMinutes(), 15);
});

test('parseExpires rejects impossible dates and malformed input', () => {
    assert.equal(parseExpires('2026-02-31'), null);
    assert.equal(parseExpires('2026-13-01'), null);
    assert.equal(parseExpires('2026-00-10'), null);
    assert.equal(parseExpires('2026-11-20 25:00'), null);
    assert.equal(parseExpires('not a date'), null);
    assert.equal(parseExpires('20/11/2026'), null);
    assert.equal(parseExpires(''), null);
    assert.equal(parseExpires(null), null);
});

test('formatExpires and expiresToFrontmatter roundtrip a parsed date', () => {
    const parsed = parseExpires('2026-11-20 18:30');
    assert.equal(formatExpires(parsed), '2026-11-20 18:30');
    assert.equal(expiresToFrontmatter(parsed), '2026-11-20T18:30');
    assert.equal(parseExpires(expiresToFrontmatter(parsed))?.getTime(), parsed?.getTime());
});

test('normalizeHexColor accepts #rgb and #rrggbb, rejects the rest', () => {
    assert.equal(normalizeHexColor('#aB3'), '#aabb33');
    assert.equal(normalizeHexColor('#AABB33'), '#aabb33');
    assert.equal(normalizeHexColor('aabb33'), '#aabb33');
    assert.equal(normalizeHexColor('#GGGGGG'), null);
    assert.equal(normalizeHexColor('#12345'), null);
    assert.equal(normalizeHexColor(null), null);
});

test('hexIsDark distinguishes dark and light custom colors', () => {
    assert.equal(hexIsDark('#000000'), true);
    assert.equal(hexIsDark('#123456'), true);
    assert.equal(hexIsDark('#ffffff'), false);
    assert.equal(hexIsDark('#f5e65c'), false);
});

test('normalizeZoom clamps to 5..200 with default 100', () => {
    assert.equal(normalizeZoom(100), 100);
    assert.equal(normalizeZoom(5), 5);
    assert.equal(normalizeZoom(200), 200);
    assert.equal(normalizeZoom(2), 5);
    assert.equal(normalizeZoom(900), 200);
    assert.equal(normalizeZoom('banana'), 100);
    assert.equal(normalizeZoom(null), 100);
});
