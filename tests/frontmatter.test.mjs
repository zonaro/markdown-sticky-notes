import assert from 'node:assert/strict';
import test from 'node:test';

import {parseNoteDocument, writeNoteDocument} from '../notes@redclaw.com.br/frontmatter.js';

const state = {
    x: 42, y: 71, width: 300, height: 200,
    color: '255,100,0', fontSize: 17, bodyVisible: false,
};

test('stores all layout metadata in one Markdown frontmatter', () => {
    const document = writeNoteDocument('# Test\n**text**\n', state);
    assert.match(document, /^---\ngnome-notes-x: 42/m);
    assert.match(document, /gnome-notes-body-visible: false/);
    const parsed = parseNoteDocument(document);
    assert.deepEqual(parsed.metadata, state);
    assert.equal(parsed.body, '# Test\n**text**\n');
});

test('preserves unrelated YAML keys when saving a note', () => {
    const existing = '---\ntitle: Personal title\ntags:\n  - work\n  - music\n' +
        'gnome-notes-x: 4\n---\nOld text';
    const updated = writeNoteDocument('New text', state, existing);
    assert.match(updated, /title: Personal title/);
    assert.match(updated, /tags:\n  - work\n  - music/);
    assert.equal((updated.match(/gnome-notes-x:/g) || []).length, 1);
    assert.equal(parseNoteDocument(updated).metadata.x, 42);
    assert.equal(parseNoteDocument(updated).body, 'New text');
});

test('does not interpret two Markdown horizontal rules as YAML', () => {
    const source = '---\nnormal prose\n---\n# Heading';
    assert.equal(parseNoteDocument(source).body, source);
    assert.equal(parseNoteDocument(source).malformedFrontmatter, true);
});

test('missing or invalid metadata is reported without throwing', () => {
    const plain = parseNoteDocument('# Plain Markdown');
    assert.equal(plain.hasFrontmatter, false);
    assert.equal(plain.malformedFrontmatter, false);
    assert.deepEqual(plain.metadata, {});

    const invalid = parseNoteDocument('---\ngnome-notes-x: oops\n---\nBody');
    assert.equal(invalid.hasFrontmatter, true);
    assert.equal(invalid.metadata.x, undefined);
    assert.equal(invalid.body, 'Body');

    const broken = parseNoteDocument('---\ngnome-notes-x: 3\nNo closing marker');
    assert.equal(broken.malformedFrontmatter, true);
    assert.deepEqual(broken.metadata, {});

    const empty = parseNoteDocument('---\n---\nBody');
    assert.equal(empty.hasFrontmatter, true);
    assert.deepEqual(empty.metadata, {});
    assert.equal(empty.body, 'Body');
});
