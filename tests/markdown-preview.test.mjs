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
