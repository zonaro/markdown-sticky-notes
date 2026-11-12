import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MARKERS,
    STYLE_BOLD,
    STYLE_ITALIC,
    STYLE_STRIKE,
    STYLE_UNDERLINE,
    attributeRuns,
    backspaceMarker,
    bulletPrefix,
    checkboxPrefix,
    ensureMarker,
    endList,
    insertTable,
    lineMark,
    listContinuation,
    markerStatesAt,
    markAt,
    markdownCheckboxPrefix,
    numberedPrefix,
    tableSkeleton,
    toggleBoxAt,
    toggleMarker,
} from '../extension/format.js';

test('markers are emitted as Markdown syntax', () => {
    assert.equal(bulletPrefix(), '- ');
    assert.equal(markdownCheckboxPrefix(false), '- [ ] ');
    assert.equal(markdownCheckboxPrefix(true), '- [x] ');
    assert.equal(numberedPrefix(3), '3. ');
});

test('checkboxPrefix keeps the legacy glyph display contract', () => {
    assert.equal(checkboxPrefix(false), '☐︎ ');
    assert.equal(checkboxPrefix(true), '☑︎ ');
});

test('lineMark recognizes Markdown bullets, tasks and numbers', () => {
    assert.deepEqual(lineMark('- item'), {kind: 'bullet', chars: 2});
    assert.deepEqual(lineMark('- [ ] open'), {kind: 'check', done: false, chars: 6, toggle: 3});
    assert.deepEqual(lineMark('- [x] done'), {kind: 'check', done: true, chars: 6, toggle: 3});
    assert.deepEqual(lineMark('- [X] done'), {kind: 'check', done: true, chars: 6, toggle: 3});
    assert.deepEqual(lineMark('1. item'), {kind: 'number', num: 1, chars: 3});
    assert.deepEqual(lineMark('12. item'), {kind: 'number', num: 12, chars: 4});
    assert.equal(lineMark('---'), null);
    assert.equal(lineMark('-'), null);
    assert.equal(lineMark('1.'), null);
    assert.equal(lineMark(''), null);
});

test('lineMark keeps reading the legacy glyph markers', () => {
    assert.deepEqual(lineMark('• item'), {kind: 'bullet', chars: 2});
    assert.deepEqual(lineMark('☐︎ item'), {kind: 'check', done: false, chars: 3, legacy: true, toggle: 0});
    assert.equal(lineMark('☑︎ item').done, true);
});

test('listContinuation continues numbered lists with the next number', () => {
    assert.equal(listContinuation('1. one\n', 6), '2. ');
    assert.equal(listContinuation('1. one\n2. two\n', 13), '3. ');
    assert.equal(listContinuation('- a\nb', 3), '- ');
    assert.equal(listContinuation('- [ ] a\nb', 7), '- [ ] ');
    assert.equal(listContinuation('plain\nb', 5), null);
});

test('ensureMarker emits Markdown markers and toggles them off', () => {
    assert.deepEqual(ensureMarker('hello', 0, 'bullet'), {text: '- hello', cursor: 2});
    assert.deepEqual(ensureMarker('hello', 0, 'check'), {text: '- [ ] hello', cursor: 6});
    assert.deepEqual(ensureMarker('hello', 0, 'number'), {text: '1. hello', cursor: 3});
    // Toggle off with the same kind removes the marker.
    assert.deepEqual(ensureMarker('- hello', 4, 'bullet'), {text: 'hello', cursor: 2});
    assert.deepEqual(ensureMarker('- [ ] hello', 8, 'check'), {text: 'hello', cursor: 2});
    assert.deepEqual(ensureMarker('3. hello', 5, 'number'), {text: 'hello', cursor: 2});
});

test('ensureMarker numbered continues from the item above', () => {
    assert.deepEqual(ensureMarker('7. seven\nnext', 9, 'number'), {text: '7. seven\n8. next', cursor: 12});
    assert.deepEqual(ensureMarker('7. seven\n', 9, 'number'), {text: '7. seven\n8. ', cursor: 12});
    assert.deepEqual(ensureMarker('plain\n', 6, 'number'), {text: 'plain\n1. ', cursor: 9});
});

test('ensureMarker replaces a different marker kind in place', () => {
    assert.deepEqual(ensureMarker('- [ ] hello', 3, 'number'), {text: '1. hello', cursor: 3});
    assert.deepEqual(ensureMarker('- hello', 3, 'check'), {text: '- [ ] hello', cursor: 7});
});

test('backspaceMarker removes only the marker', () => {
    assert.deepEqual(backspaceMarker('- [ ] hello', 4), {text: 'hello', cursor: 0});
    assert.deepEqual(backspaceMarker('2. hello', 2), {text: 'hello', cursor: 0});
    assert.deepEqual(backspaceMarker('plain', 2), null);
});

test('endList removes an empty item to leave the list', () => {
    assert.deepEqual(endList('1. a\n2. ', 8), {text: '1. a\n', cursor: 5});
    assert.deepEqual(endList('- [ ] ', 6), {text: '', cursor: 0});
    assert.equal(endList('- [ ] a', 6), null);
});

test('toggleBoxAt flips Markdown and legacy task markers', () => {
    assert.equal(toggleBoxAt('- [ ] a', 3), '- [x] a');
    assert.equal(toggleBoxAt('- [x] a', 3), '- [ ] a');
    assert.equal(toggleBoxAt('- [X] a', 3), '- [ ] a');
    assert.equal(toggleBoxAt('☐︎ a', 0), '☑︎ a');
    assert.equal(toggleBoxAt('☑︎ a', 0), '☐︎ a');
    assert.equal(toggleBoxAt('plain', 0), null);
    assert.equal(toggleBoxAt('- a', 0), null);
});

test('markAt reports the marker kind of the line', () => {
    assert.equal(markAt('- a\n1. b', 0), 'bullet');
    assert.equal(markAt('- a\n1. b', 7), 'number');
    assert.equal(markAt('plain', 0), null);
});

test('toggleMarker wraps a selection in Markdown and unwraps it again', () => {
    const wrapped = toggleMarker('hello', 0, 5, MARKERS[STYLE_BOLD]);
    assert.equal(wrapped.text, '**hello**');
    assert.deepEqual([wrapped.start, wrapped.end], [2, 7]);
    const unwrapped = toggleMarker(wrapped.text, wrapped.start, wrapped.end, MARKERS[STYLE_BOLD]);
    assert.equal(unwrapped.text, 'hello');
    assert.deepEqual([unwrapped.start, unwrapped.end], [0, 5]);
});

test('toggleMarker unwraps markers included in the selection', () => {
    const out = toggleMarker('a **bold** b', 2, 10, MARKERS[STYLE_BOLD]);
    assert.equal(out.text, 'a bold b');
    assert.deepEqual([out.start, out.end], [2, 6]);
});

test('toggleMarker with no selection inserts an empty pair and unwraps it', () => {
    const inserted = toggleMarker('text', 2, 2, MARKERS[STYLE_BOLD]);
    assert.equal(inserted.text, 'te****xt');
    assert.deepEqual([inserted.start, inserted.end], [4, 4]);
    const removed = toggleMarker(inserted.text, 4, 4, MARKERS[STYLE_BOLD]);
    assert.equal(removed.text, 'text');
});

test('toggleMarker unwraps a pair enclosing the caret on the line', () => {
    const out = toggleMarker('**bold**', 3, 3, MARKERS[STYLE_BOLD]);
    assert.equal(out.text, 'bold');
    assert.deepEqual([out.start, out.end], [0, 0]);
});

test('toggleMarker handles underline HTML and strikethrough', () => {
    const struck = toggleMarker('abc', 0, 3, MARKERS[STYLE_STRIKE]);
    assert.equal(struck.text, '~~abc~~');
    const under = toggleMarker('abc', 0, 3, MARKERS[STYLE_UNDERLINE]);
    assert.equal(under.text, '<u>abc</u>');
    const undone = toggleMarker('<u>abc</u>', 0, 10, MARKERS[STYLE_UNDERLINE]);
    assert.equal(undone.text, 'abc');
});

test('markerStatesAt lights the buttons for wrapped text and caret context', () => {
    // **x** is both a bold pair and two italic asterisks; the toggle for
    // italic would unwrap single asterisks the same way.
    assert.equal(markerStatesAt('**bold**', 2, 6), STYLE_BOLD | STYLE_ITALIC);
    assert.equal(markerStatesAt('**bold**', 0, 8), STYLE_BOLD | STYLE_ITALIC);
    assert.equal(markerStatesAt('**bold**', 3, 3), STYLE_BOLD);
    assert.equal(markerStatesAt('<u>under</u>', 3, 8), STYLE_UNDERLINE);
    assert.equal(markerStatesAt('plain', 0, 5), 0);
    assert.equal(markerStatesAt('*a*', 1, 2), STYLE_ITALIC);
});

test('attributeRuns strikes the text of a checked Markdown task', () => {
    const runs = attributeRuns('- [x] done', [], []);
    assert.equal(runs.some(run => run.done), true);
    assert.equal(attributeRuns('- [ ] open', [], []).some(run => run.done), false);
});

test('tableSkeleton is a valid 3x2 Markdown table', () => {
    const lines = tableSkeleton();
    assert.equal(lines.length, 4);
    assert.equal(lines[0], '| Col 1 | Col 2 | Col 3 |');
    assert.match(lines[1], /^\| --- \| --- \| --- \|$/);
});

test('insertTable drops a skeleton on its own line with the caret in the first cell', () => {
    const out = insertTable('hello', 5, 5);
    assert.equal(out.text, 'hello\n| Col 1 | Col 2 | Col 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n');
    assert.equal(out.text.slice(out.cursor), 'Col 1 | Col 2 | Col 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n');
});

test('insertTable replaces the selection and starts after content', () => {
    const out = insertTable('ab\nxy', 3, 5);
    assert.equal(out.text, 'ab\n| Col 1 | Col 2 | Col 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n');
    assert.equal(out.text.slice(out.cursor, out.cursor + 5), 'Col 1');
});
