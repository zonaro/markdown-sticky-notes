import assert from 'node:assert/strict';
import test from 'node:test';

import {renderMarkdown} from '../notes@maestroschan.fr/markdown.js';

test('renders basic Markdown without changing source text', () => {
    const source = '# A title\n- first\n**bold** and *italic*\n`code`';
    assert.match(renderMarkdown(source), /<span size="x-large" weight="bold">A title<\/span>/);
    assert.match(renderMarkdown(source), /• first/);
    assert.match(renderMarkdown(source), /<b>bold<\/b> and <i>italic<\/i>/);
    assert.match(renderMarkdown(source), /<tt>code<\/tt>/);
    assert.equal(source, '# A title\n- first\n**bold** and *italic*\n`code`');
});

test('escapes text that might otherwise be interpreted as Pango markup', () => {
    const result = renderMarkdown('<script>x & y</script>');
    assert.equal(result, '&lt;script&gt;x &amp; y&lt;/script&gt;');
});

test('keeps fenced code as escaped literal content', () => {
    const result = renderMarkdown('```js\n**not bold** <tag>\n```');
    assert.equal(result, '\n<tt>**not bold** &lt;tag&gt;</tt>\n');
});
