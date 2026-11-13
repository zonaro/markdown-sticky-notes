import test from 'node:test';
import assert from 'node:assert/strict';

import {renderMarkdown, renderTodo} from '../extension/markdown-preview.js';

test('renders headings, bold, italics and task list markers', () => {
    const out = renderMarkdown('# Title\n**Bold** and *italic*\n- [x] Checked\n- [ ] Open').markup;
    assert.match(out, /weight="bold"/);
    assert.match(out, /<b>Bold<\/b>/);
    assert.match(out, /<i>italic<\/i>/);
    assert.match(out, /☑/);
    assert.match(out, /☐/);
});

test('escapes raw markup and link labels to prevent Pango injection', () => {
    const out = renderMarkdown('**<script>** [<span>](javascript:alert) & "value"').markup;
    assert.doesNotMatch(out, /<script>|<span>/);
    assert.match(out, /&lt;script&gt;/);
    assert.match(out, /&amp;/);
    assert.match(out, /&quot;/);
});

test('preview never renders YAML if given only parsed Markdown body', () => {
    const out = renderMarkdown('# Note\nSome text').markup;
    assert.doesNotMatch(out, /gnome-sticky-/);
    assert.match(out, /Some text/);
});

test('code fences render as monospace while escaping angle brackets', () => {
    const out = renderMarkdown('\`\`\`js\nconst a = "<b>";\n\`\`\`').markup;
    assert.match(out, /<tt>const a/);
    assert.match(out, /&lt;b&gt;/);
});

test('supports Unicode and bullets without changing source', () => {
    const input = '- revisão\n- música';
    const out = renderMarkdown(input).markup;
    assert.match(out, /•  revisão/);
    assert.equal(input, '- revisão\n- música');
});

test('ordered list markers render as numbered items', () => {
    const out = renderMarkdown('1. First\n2. Second\n10. Tenth').markup;
    assert.match(out, /1\.  First/);
    assert.match(out, /2\.  Second/);
    assert.match(out, /10\.  Tenth/);
});

test('inline HTML underline renders and stays balanced', () => {
    assert.match(renderMarkdown('<u>under</u>').markup, /<u>under<\/u>/);
    // A stray closing tag is escaped, an unclosed one is auto-closed.
    const stray = renderMarkdown('</u>text').markup;
    assert.doesNotMatch(stray, /<u>/);
    assert.match(stray, /&lt;\/u&gt;/);
    const open = renderMarkdown('<u>broken').markup;
    assert.match(open, /<u>broken<\/u>/);
});

test('pipe tables render with borders, bold header and aligned columns', () => {
    const out = renderMarkdown('| Name | Age |\n| --- | ---:|\n| Ana | 30 |\n| Paulo | 4 |').markup;
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
    const out = renderMarkdown('| A | B |\n| --- | --- |\n| <b>x</b> | & |').markup;
    assert.match(out, /&lt;b&gt;/);
    assert.match(out, /&amp;/);
    assert.doesNotMatch(out, /<b>x<\/b>/);
});

test('a separator with dashes shorter than 3 is not a table', () => {
    const out = renderMarkdown('| a | b |\n| - | - |').markup;
    assert.match(out, /\| a \| b \|/);
    assert.doesNotMatch(out, /┌/);
});

test('a pipe line without a following separator renders as plain text', () => {
    const out = renderMarkdown('a | b').markup;
    assert.doesNotMatch(out, /┌/);
    assert.match(out, /a \| b/);
});

test('todo preview renders glyph, priority badge and escaped description', () => {
    const {markup} = renderTodo('(A) 2026-11-01 Call <Mom> +family @phone', '2026-11-12');
    assert.match(markup, /☐/);
    assert.match(markup, /A/);
    assert.match(markup, /&lt;Mom&gt;/);
    assert.match(markup, /\+family/);
    assert.match(markup, /@phone/);
});

test('todo preview strikes completed tasks and shows a checked box', () => {
    const {markup} = renderTodo('x 2026-11-12 (A) 2026-11-01 Call mom', '2026-11-12');
    assert.match(markup, /☑/);
    assert.match(markup, /<s>/);
});

test('todo preview colors an overdue due date red', () => {
    const {markup} = renderTodo('Pay taxes due:2026-11-01', '2026-11-12');
    assert.match(markup, /#c01c28/);
    const future = renderTodo('Pay taxes due:2026-12-01', '2026-11-12').markup;
    assert.doesNotMatch(future, /#c01c28/);
});

test('todo preview renders one row per source line with stable source indexes', () => {
    const source = 'First task\n\nx 2026-11-12 Second task\n(C) Third due:2026-11-20';
    const {rows, markup} = renderTodo(source, '2026-11-12');
    assert.equal(rows.length, 4);
    for (let i = 0; i < rows.length; i += 1)
        assert.equal(rows[i].source, i);
    assert.equal(markup.split('\n').length, rows.length);
    assert.equal(rows[0].todo, true);
});

test('todo preview accepts display glyph prefixes and ignores them', () => {
    const withGlyphs = renderTodo('☐\uFE0E 2026-11-12 Buy milk', '2026-11-12').markup;
    const without = renderTodo('2026-11-12 Buy milk', '2026-11-12').markup;
    assert.equal(withGlyphs, without);
});

test('markdown checkbox lines flag box rows with the source line index', () => {
    const {rows} = renderMarkdown('- [ ] Buy\n- [x] Done\nplain - [ ] inline-no');
    assert.equal(rows[0].box, true);
    assert.equal(rows[1].box, true);
    assert.notEqual(rows[2].box, true);
    assert.equal(rows[0].source, 0);
    assert.match(rows[2].pango, /\[ \]/);
});

test('links are reported with byte ranges into the row plain text', () => {
    const {rows} = renderMarkdown('See [docs](https://example.com) now');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].links.length, 1);
    assert.equal(Buffer.from(rows[0].plain).subarray(rows[0].links[0].from, rows[0].links[0].to).toString(), 'docs');
    assert.equal(rows[0].links[0].url, 'https://example.com');
});

test('link byte ranges stay accurate with multibyte characters', () => {
    const {rows} = renderMarkdown('revisão [café](https://x.example) fim');
    const {plain, links} = rows[0];
    assert.equal(Buffer.from(plain).subarray(links[0].from, links[0].to).toString(), 'café');
});

test('unsafe or schemeless-but-strange URLs are not reported as links', () => {
    const {rows} = renderMarkdown('[x](javascript:alert(1))');
    assert.equal(rows[0].links.length, 0);
});

test('own-line markdown images become image rows', () => {
    const {rows} = renderMarkdown('![a cat](~/cat.png)');
    assert.equal(rows[0].kind, 'image');
    assert.equal(rows[0].src, '~/cat.png');
    assert.equal(rows[0].alt, 'a cat');
});

test('dot and mermaid fences become diagram rows', () => {
    const dot = renderMarkdown('```dot\ndigraph G { a -> b }\n```').rows;
    assert.equal(dot[0].kind, 'diagram');
    assert.equal(dot[0].lang, 'dot');
    assert.equal(dot[0].code, 'digraph G { a -> b }');
    const mermaid = renderMarkdown('```mermaid\ngraph TD; A-->B\n```').rows;
    assert.equal(mermaid[0].kind, 'diagram');
    assert.equal(mermaid[0].lang, 'mermaid');
    const plain = renderMarkdown('```\ncode <b>\n```').rows;
    assert.equal(plain[0].kind, 'block');
});
