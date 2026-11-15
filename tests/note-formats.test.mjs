import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isImageNoteFormat,
    isNoteFilename,
    isTextNoteFormat,
    noteFormatForFilename,
} from '../extension/note-format.js';
import {renderPlainText, renderSafeHtml} from '../extension/safe-preview.js';

test('supported note extensions map to explicit formats', () => {
    assert.equal(noteFormatForFilename('note.md'), 'markdown');
    assert.equal(noteFormatForFilename('NOTE.MARKDOWN'), 'markdown');
    assert.equal(noteFormatForFilename('plain.txt'), 'text');
    assert.equal(noteFormatForFilename('page.HTML'), 'html');
    assert.equal(noteFormatForFilename('page.htm'), 'html');
    assert.equal(noteFormatForFilename('sticker.png'), 'image');
    assert.equal(noteFormatForFilename('photo.JPG'), 'image');
    assert.equal(noteFormatForFilename('photo.jpeg'), 'image');
    assert.equal(noteFormatForFilename('archive.png.exe'), null);
    assert.equal(isNoteFilename('unknown.bin'), false);
    assert.equal(isTextNoteFormat('html'), true);
    assert.equal(isImageNoteFormat('image'), true);
});

test('plain text preview never interprets Markdown syntax', () => {
    const source = '# Heading\n*not italic*\n[link](javascript:alert(1))\n- [ ] task';
    const render = renderPlainText(source);
    assert.deepEqual(render.rows.map(row => row.plain), source.split('\n'));
    assert.equal(render.rows[0].pango, '# Heading');
    assert.equal(render.rows[1].pango, '*not italic*');
    assert.equal(render.rows[2].links.length, 0);
    assert.doesNotMatch(render.rows.map(row => row.pango).join('\n'), /<b>|<i>/);
});

test('safe HTML keeps predictable text formatting only', () => {
    const render = renderSafeHtml(
        '<h1>Hello &amp; welcome</h1><p>A <strong>safe</strong> <em>note</em>.</p>' +
        '<ul><li>One</li><li>Two</li></ul>');
    assert.deepEqual(render.rows.map(row => row.plain), [
        'Hello & welcome',
        'A safe note.',
        '• One',
        '• Two',
    ]);
    const pango = render.rows.map(row => row.pango).join('\n');
    assert.match(pango, /<b><big>Hello &amp; welcome<\/big><\/b>/);
    assert.match(pango, /<b>safe<\/b>/);
    assert.match(pango, /<i>note<\/i>/);
});

test('active HTML, handlers, styles and URLs are discarded', () => {
    const malicious = [
        '<script>globalThis.PWNED = true</script>',
        '<style>@import "https://evil.example/x.css"; body{display:none}</style>',
        '<iframe src="https://evil.example/frame"></iframe>',
        '<object data="data:text/html,pwn"></object>',
        '<svg onload="alert(1)"><script>alert(2)</script></svg>',
        '<p onclick="alert(3)">Visible</p>',
        '<a href="javascript:alert(4)" onmouseover="alert(5)">Link text</a>',
        '<img src="https://evil.example/tracker.png" onerror="alert(6)" alt="Photo">',
    ].join('');
    const render = renderSafeHtml(malicious);
    const output = JSON.stringify(render);
    assert.match(output, /Visible/);
    assert.match(output, /Link text/);
    assert.match(output, /\[Photo\]/);
    assert.doesNotMatch(output, /PWNED|evil\.example|javascript:|alert\(|onerror|onclick|onmouseover|@import/);
    assert.ok(render.rows.every(row => row.links.length === 0));
});

test('malformed or unclosed active HTML fails closed', () => {
    const render = renderSafeHtml('<p>Before</p><script><b>Never shown</b>');
    assert.deepEqual(render.rows.map(row => row.plain), ['Before']);
    assert.doesNotThrow(() => renderSafeHtml('<div><b>Unbalanced'));
});
