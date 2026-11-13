import test from 'node:test';
import assert from 'node:assert/strict';

import {parseDocument, writeDocument} from '../extension/document.js';

const note = {
    id: 7,
    filename: 'ideas.md',
    x: 10, y: 20, w: 250, h: 180, expanded_h: 180,
    color: 4, size: 13, workspace: 0,
    pinned: true, locked: false, spans: [], sizes: [],
    text: '# Idea\nA **Markdown** note\n',
};

test('a plain Markdown file becomes a note with its body intact', () => {
    const result = parseDocument('# Hello\n- Item\n');
    assert.equal(result.hasFrontmatter, false);
    assert.equal(result.body, '# Hello\n- Item\n');
    assert.deepEqual(result.metadata, {});
});

test('roundtrip persists the pin flag and note geometry', () => {
    const encoded = writeDocument(note);
    const decoded = parseDocument(encoded);
    assert.equal(decoded.body, note.text);
    assert.equal(decoded.metadata.pinned, true);
    assert.equal(decoded.metadata.id, 7);
    assert.equal(decoded.metadata.w, 250);
    assert.equal(decoded.metadata.locked, false);
});

test('unpinning updates the same file without duplicating owned metadata', () => {
    const first = writeDocument(note);
    const second = writeDocument({...note, pinned: false}, first);
    const decoded = parseDocument(second);
    assert.equal(decoded.metadata.pinned, false);
    assert.equal(second.match(/gnome-sticky-pinned:/g)?.length, 1);
});

test('unrelated user frontmatter survives extension saves', () => {
    const input = '---\ntitle: My task\ntags: [work, todo]\n---\n- [ ] Done?\n';
    const output = writeDocument({...note, text: '- [ ] Done?\n'}, input);
    assert.match(output, /^---\ntitle: My task\ntags: \[work, todo\]/);
    assert.equal(parseDocument(output).body, '- [ ] Done?\n');
});

test('reads old namespaced position keys without needing state files', () => {
    const legacy = '---\ngnome-notes-x: 110\ngnome-notes-y: 70\ngnome-notes-width: 270\n---\nNotes';
    const decoded = parseDocument(legacy);
    assert.equal(decoded.metadata.x, 110);
    assert.equal(decoded.metadata.y, 70);
    assert.equal(decoded.metadata.w, 270);
});

test('a Markdown horizontal rule is not mistaken for frontmatter', () => {
    const input = '---\nJust a paragraph\n---\nAnother paragraph';
    assert.equal(parseDocument(input).body, input);
});

test('rich text ranges remain serializable as YAML-compatible JSON', () => {
    const decorated = {...note, spans: [{start: 0, end: 5, style: 1}]};
    const decoded = parseDocument(writeDocument(decorated));
    assert.deepEqual(decoded.metadata.spans, decorated.spans);
});


test('invalid numeric metadata uses the default while preserving other fields', () => {
    const input = '---\ngnome-notes-x: abc\ngnome-sticky-height: 180\n---\n# Content';
    const parsed = parseDocument(input);
    assert.equal(parsed.metadata.x, undefined);
    assert.equal(parsed.metadata.h, 180);
    assert.equal(parsed.body, '# Content');
});

test('unterminated YAML is treated as content and not silently removed', () => {
    const broken = '---\ntitle: My task\n- important text\n';
    assert.deepEqual(parseDocument(broken).metadata, {});
    assert.equal(parseDocument(broken).body, broken);
    const parsed = parseDocument(broken);
    const result = writeDocument({...note, text: parsed.body}, broken);
    assert.equal(parseDocument(result).body, broken);
});

test('user frontmatter is preserved even when it contains comments', () => {
    const previous = '---\n# personal comment\ntitle: My title\ntags: [notes]\ngnome-sticky-id: 1\n---\nhello';
    const encoded = writeDocument(note, previous);
    assert.match(encoded, /# personal comment/);
    assert.match(encoded, /title: My title/);
    assert.match(encoded, /tags: \[notes\]/);
    assert.equal((encoded.match(/gnome-sticky-id:/g) ?? []).length, 1);
});

test('supports CRLF frontmatter without changing the Markdown content', () => {
    const input = '---\r\ngnome-sticky-x: 11\r\n---\r\n# Title\r\n';
    const parsed = parseDocument(input);
    assert.equal(parsed.metadata.x, 11);
    assert.equal(parsed.body, '# Title\r\n');
});

test('expiration is persisted as a string and survives other saves', () => {
    const withExpiry = writeDocument({...note, expires: '2026-11-20T18:30'});
    const decoded = parseDocument(withExpiry);
    assert.equal(decoded.metadata.expires, '2026-11-20T18:30');
    const untouched = writeDocument({...note});
    assert.equal(parseDocument(untouched).metadata.expires, undefined);
});
