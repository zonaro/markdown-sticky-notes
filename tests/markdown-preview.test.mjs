import test from 'node:test';
import assert from 'node:assert/strict';

import {renderMarkdown} from '../extension/markdown-preview.js';

test('renders headings, bold, italics and task list markers', () => {
    const out = renderMarkdown('# Title\n**Bold** and *italic*\n- [x] Checked\n- [ ] Open');
    assert.match(out, /weight="bold"/);
    assert.match(out, /<b>Bold<\/b>/);
    assert.match(out, /<i>italic<\/i>/);
    assert.match(out, /☑/);
    assert.match(out, /☐/);
});

test('escapes raw markup and link labels to prevent Pango injection', () => {
    const out = renderMarkdown('**<script>** [<span>](javascript:alert) & "value"');
    assert.doesNotMatch(out, /<script>|<span>/);
    assert.match(out, /&lt;script&gt;/);
    assert.match(out, /&amp;/);
    assert.match(out, /&quot;/);
});

test('preview never renders YAML if given only parsed Markdown body', () => {
    const out = renderMarkdown('# Note\nSome text');
    assert.doesNotMatch(out, /gnome-sticky-/);
    assert.match(out, /Some text/);
});

test('code fences render as monospace while escaping angle brackets', () => {
    const out = renderMarkdown('\`\`\`js\nconst a = "<b>";\n\`\`\`');
    assert.match(out, /<tt>const a/);
    assert.match(out, /&lt;b&gt;/);
});

test('supports Unicode and bullets without changing source', () => {
    const input = '- revisão\n- música';
    const out = renderMarkdown(input);
    assert.match(out, /•  revisão/);
    assert.equal(input, '- revisão\n- música');
});

test('ordered list markers render as numbered items', () => {
    const out = renderMarkdown('1. First\n2. Second\n10. Tenth');
    assert.match(out, /1\.  First/);
    assert.match(out, /2\.  Second/);
    assert.match(out, /10\.  Tenth/);
});

test('inline HTML underline renders and stays balanced', () => {
    assert.match(renderMarkdown('<u>under</u>'), /<u>under<\/u>/);
    // A stray closing tag is escaped, an unclosed one is auto-closed.
    const stray = renderMarkdown('</u>text');
    assert.doesNotMatch(stray, /<u>/);
    assert.match(stray, /&lt;\/u&gt;/);
    const open = renderMarkdown('<u>broken');
    assert.match(open, /<u>broken<\/u>/);
});

test('pipe tables render with borders, bold header and aligned columns', () => {
    const out = renderMarkdown('| Name | Age |\n| --- | ---:|\n| Ana | 30 |\n| Paulo | 4 |');
    assert.match(out, /┌/);
    assert.match(out, /┤/);
    assert.match(out, /└/);
    assert.match(out, /<b>Name/);
    assert.match(out, /<b>Age<\/b>/);
    // Right-aligned numeric column is padded on the left.
    assert.match(out, /│  30 │/);
    assert.match(out, /│   4 │/);
    // Every grid line has the same display width and the same pipe count.
    const grid = out.split('\n').map(line => line.replace(/<\/?(b|tt|span[^>]*)>/g, ''));
    const width = Array.from(grid[0]).length;
    assert.ok(grid.length >= 6);
    for (const line of grid) {
        assert.equal(Array.from(line).length, width);
        assert.equal((line.match(/[│┌┐├┤└┘┬┼┴]/g) ?? []).length, 3);
    }
});

test('table cells escape raw markup', () => {
    const out = renderMarkdown('| A | B |\n| --- | --- |\n| <b>x</b> | & |');
    assert.match(out, /&lt;b&gt;/);
    assert.match(out, /&amp;/);
    assert.doesNotMatch(out, /<b>x<\/b>/);
});

test('a separator with dashes shorter than 3 is not a table', () => {
    const out = renderMarkdown('| a | b |\n| - | - |');
    assert.match(out, /\| a \| b \|/);
    assert.doesNotMatch(out, /┌/);
});

test('a pipe line without a following separator renders as plain text', () => {
    const out = renderMarkdown('a | b');
    assert.doesNotMatch(out, /┌/);
    assert.match(out, /a \| b/);
});
