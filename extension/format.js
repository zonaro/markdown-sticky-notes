// Character styles and list markers. Offsets are Unicode scalars, matching notes.json.

// Markdown list markers. Bullet, checkbox and numbered markers are emitted
// as Markdown syntax; the glyph markers stay readable for notes written by
// earlier versions of the extension.
export const STYLE_BOLD = 1;
export const STYLE_ITALIC = 2;
export const STYLE_UNDERLINE = 4;
export const STYLE_STRIKE = 8;

export const MARKERS = {
    [STYLE_BOLD]: {open: '**', close: '**'},
    [STYLE_ITALIC]: {open: '*', close: '*'},
    [STYLE_STRIKE]: {open: '~~', close: '~~'},
    [STYLE_UNDERLINE]: {open: '<u>', close: '</u>'},
};

const BOX_OPEN = '\u2610';
const BOX_DONE = '\u2611';
const TEXT_STYLE = '\ufe0e';
const BULLET = '\u2022';

// Display glyph prefix kept for the to-do display helpers; never emitted to
// Markdown files. Markdown emission uses markdownCheckboxPrefix.
export function checkboxPrefix(done) {
    return `${done ? BOX_DONE : BOX_OPEN}${TEXT_STYLE} `;
}

export function markdownCheckboxPrefix(done) {
    return `- [${done ? 'x' : ' '}] `;
}

export function bulletPrefix() {
    return '- ';
}

export function numberedPrefix(number) {
    return `${number}. `;
}

const NUMBERED_RE = /^(\d{1,9})\. /;

export function lineMark(line) {
    const chars = Array.from(line);
    if (!chars.length)
        return null;
    const first = chars[0];
    // Legacy glyph markers, kept for reading old files. They are rewritten
    // as Markdown markers as soon as the user edits the line.
    if (first === BOX_OPEN || first === BOX_DONE) {
        let n = 1;
        if (chars[1] === TEXT_STYLE)
            n += 1;
        if (chars[n] === ' ')
            n += 1;
        return {kind: 'check', done: first === BOX_DONE, chars: n, legacy: true, toggle: 0};
    }
    if (first === BULLET)
        return {kind: 'bullet', chars: chars[1] === ' ' ? 2 : 1};
    // Markdown markers at the very start of the line.
    if (first === '-' && chars[1] === ' ') {
        if (chars[2] === '[' &&
            (chars[3] === ' ' || chars[3] === 'x' || chars[3] === 'X') &&
            chars[4] === ']' && chars[5] === ' ')
            return {kind: 'check', done: chars[3] !== ' ', chars: 6, toggle: 3};
        return {kind: 'bullet', chars: 2};
    }
    const numbered = NUMBERED_RE.exec(line);
    if (numbered)
        return {kind: 'number', num: parseInt(numbered[1], 10), chars: Array.from(numbered[0]).length};
    return null;
}

export function editRange(before, after) {
    const older = Array.from(before);
    const newer = Array.from(after);
    let start = 0;
    const limit = Math.min(older.length, newer.length);
    while (start < limit && older[start] === newer[start])
        start += 1;
    let oldEnd = older.length;
    let newEnd = newer.length;
    while (oldEnd > start && newEnd > start && older[oldEnd - 1] === newer[newEnd - 1]) {
        oldEnd -= 1;
        newEnd -= 1;
    }
    return {start, removed: oldEnd - start, inserted: newEnd - start};
}

function expand(spans, length) {
    const bits = new Uint8Array(length);
    for (const span of spans) {
        const style = span.style & 15;
        if (!style)
            continue;
        const from = Math.max(0, Math.min(length, span.start));
        const to = Math.max(from, Math.min(length, span.end));
        for (let i = from; i < to; i++)
            bits[i] |= style;
    }
    return bits;
}

function compact(values, key = 'style') {
    const runs = [];
    let i = 0;
    while (i < values.length) {
        const value = values[i];
        let j = i + 1;
        while (j < values.length && values[j] === value)
            j += 1;
        if (value)
            runs.push({start: i, end: j, [key]: value});
        i = j;
    }
    return runs;
}

function shiftValues(values, start, removed, inserted, fill) {
    const length = values.length;
    const from = Math.max(0, Math.min(start, length));
    const drop = Math.max(0, Math.min(removed, length - from));
    const added = Math.max(0, inserted);
    const next = new Uint8Array(length - drop + added);
    next.set(values.subarray(0, from), 0);
    next.fill(fill, from, from + added);
    const tail = values.subarray(from + drop);
    const dest = from + added;
    if (tail.length && dest < next.length)
        next.set(tail.subarray(0, next.length - dest), dest);
    return next;
}

export function shiftSpans(spans, length, start, removed, inserted) {
    return compact(shiftValues(expand(spans, length), start, removed, inserted, 0));
}

export function retargetSpans(spans, before, after) {
    const edit = editRange(before, after);
    return shiftSpans(spans, Array.from(before).length, edit.start, edit.removed, edit.inserted);
}

export function paintStyle(spans, length, start, end, style) {
    const bits = expand(spans, Math.max(length, end, 0));
    const mask = style & 15;
    const from = Math.max(0, start);
    const to = Math.min(bits.length, end);
    for (let i = from; i < to; i++)
        bits[i] = mask;
    return compact(bits);
}

export function styleAt(spans, length, index) {
    if (index < 0 || index >= length)
        return 0;
    let bits = 0;
    for (const span of spans) {
        if (index >= span.start && index < span.end)
            bits |= span.style & 15;
    }
    return bits;
}

export function listContinuation(text, newlineAt) {
    const chars = Array.from(text);
    if (chars[newlineAt] !== '\n')
        return null;
    let lineStart = 0;
    for (let i = newlineAt - 1; i >= 0; i--) {
        if (chars[i] === '\n') {
            lineStart = i + 1;
            break;
        }
    }
    const mark = lineMark(chars.slice(lineStart, newlineAt).join(''));
    if (!mark)
        return null;
    if (mark.kind === 'bullet')
        return bulletPrefix();
    if (mark.kind === 'check')
        return markdownCheckboxPrefix(false);
    if (mark.kind === 'number')
        return numberedPrefix(mark.num + 1);
    return null;
}

function lineBounds(chars, index) {
    const at = Math.max(0, Math.min(index, chars.length));
    let start = 0;
    for (let i = at - 1; i >= 0; i--) {
        if (chars[i] === '\n') {
            start = i + 1;
            break;
        }
    }
    let end = chars.length;
    for (let i = at; i < chars.length; i++) {
        if (chars[i] === '\n') {
            end = i;
            break;
        }
    }
    return {start, end};
}

// The number the next item in a numbered list should carry. Numbering
// continues from the item right above the cursor, if any.
function previousNumber(chars, start) {
    if (start <= 0)
        return 1;
    // lineBounds always starts the line at a '\n' + 1 (or 0).
    let lineEnd = start - 1;
    if (chars[lineEnd] === '\n')
        lineEnd -= 1;
    let lineStart = 0;
    for (let i = lineEnd; i >= 0; i--) {
        if (chars[i] === '\n') {
            lineStart = i + 1;
            break;
        }
    }
    const mark = lineMark(chars.slice(lineStart, lineEnd + 1).join(''));
    return mark && mark.kind === 'number' ? mark.num + 1 : 1;
}

export function ensureMarker(text, cursor, kind) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(cursor, chars.length));
    const {start, end} = lineBounds(chars, at);
    const mark = lineMark(chars.slice(start, end).join(''));
    if (mark && mark.kind === kind) {
        const next = chars.slice(0, start).concat(chars.slice(start + mark.chars));
        const nextCursor = at < start + mark.chars ? start : Math.max(start, at - mark.chars);
        return {text: next.join(''), cursor: nextCursor};
    }
    const old = mark ? mark.chars : 0;
    let prefix;
    if (kind === 'bullet')
        prefix = Array.from(bulletPrefix());
    else if (kind === 'check')
        prefix = Array.from(markdownCheckboxPrefix(false));
    else
        prefix = Array.from(numberedPrefix(previousNumber(chars, start)));
    const next = chars.slice(0, start).concat(prefix, chars.slice(start + old));
    const nextCursor = at < start + old ? start + prefix.length : at + prefix.length - old;
    return {text: next.join(''), cursor: nextCursor};
}

// Backspace inside a marker removes only the marker. The line stays, now
// plain, so Enter on it no longer continues the list.
export function backspaceMarker(text, cursor) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(cursor, chars.length));
    const {start, end} = lineBounds(chars, at);
    const mark = lineMark(chars.slice(start, end).join(''));
    if (!mark || at - start > mark.chars)
        return null;
    return {
        text: chars.slice(0, start).concat(chars.slice(start + mark.chars)).join(''),
        cursor: start,
    };
}

// Enter on an item that holds nothing but its marker ends the list there.
export function endList(text, cursor) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(cursor, chars.length));
    const {start, end} = lineBounds(chars, at);
    const mark = lineMark(chars.slice(start, end).join(''));
    if (!mark || end !== start + mark.chars || at !== end)
        return null;
    return {
        text: chars.slice(0, start).concat(chars.slice(end)).join(''),
        cursor: start,
    };
}

export function markAt(text, cursor) {
    const chars = Array.from(text);
    const {start, end} = lineBounds(chars, cursor);
    const mark = lineMark(chars.slice(start, end).join(''));
    return mark ? mark.kind : null;
}

export function toggleBoxAt(text, index) {
    const chars = Array.from(text);
    if (index < 0 || index >= chars.length)
        return null;
    const {start, end} = lineBounds(chars, index);
    const mark = lineMark(chars.slice(start, end).join(''));
    if (!mark || mark.kind !== 'check' || index - start >= mark.chars)
        return null;
    if (mark.legacy)
        chars[start] = mark.done ? BOX_OPEN : BOX_DONE;
    else
        chars[start + mark.toggle] = mark.done ? ' ' : 'x';
    return chars.join('');
}

function utf8Size(ch) {
    const code = ch.codePointAt(0);
    if (code < 0x80)
        return 1;
    if (code < 0x800)
        return 2;
    if (code < 0x10000)
        return 3;
    return 4;
}

export function utf8Length(text) {
    let bytes = 0;
    for (const ch of text)
        bytes += utf8Size(ch);
    return bytes;
}

// Character offset of a Pango byte index.
export function charOffset(text, bytes) {
    let used = 0;
    let chars = 0;
    for (const ch of text) {
        if (used >= bytes)
            break;
        used += utf8Size(ch);
        chars += 1;
    }
    return chars;
}

// Point sizes the text size buttons step through. A size run stores one of
// these; 0 means the note's own size.
const SIZE_STEPS = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32];

export function stepSize(size, delta) {
    if (delta > 0)
        return SIZE_STEPS.find(step => step > size) ?? SIZE_STEPS[SIZE_STEPS.length - 1];
    return SIZE_STEPS.findLast(step => step < size) ?? SIZE_STEPS[0];
}

function expandSizes(sizes, length) {
    const values = new Uint8Array(length);
    for (const run of sizes) {
        const from = Math.max(0, Math.min(length, run.start));
        const to = Math.max(from, Math.min(length, run.end));
        values.fill(run.size, from, to);
    }
    return values;
}

// Text typed at the start of a line takes the size of that line. Anywhere
// else it takes the size of the character before it.
function insertSize(chars, values, at, removed) {
    if (removed > 0)
        return values[at];
    if (at > 0 && chars[at - 1] !== '\n')
        return values[at - 1];
    if (at < chars.length && chars[at] !== '\n')
        return values[at];
    return at > 0 ? values[at - 1] : 0;
}

// Inserted characters take `size`, or the size of the text around them when it is null.
export function editSizes(sizes, before, start, removed, inserted, size = null) {
    const chars = Array.from(before);
    const values = expandSizes(sizes, chars.length);
    const fill = size ?? insertSize(chars, values, start, removed);
    return compact(shiftValues(values, start, removed, inserted, fill), 'size');
}

export function retargetSizes(sizes, before, after) {
    const edit = editRange(before, after);
    return editSizes(sizes, before, edit.start, edit.removed, edit.inserted);
}

export function typingSize(sizes, text, cursor) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(cursor, chars.length));
    return insertSize(chars, expandSizes(sizes, chars.length), at, 0);
}

// The size shared by every selected character, or null when they differ.
export function selectionSize(sizes, length, start, end, base) {
    const values = expandSizes(sizes, length);
    const to = Math.min(end, length);
    let size = null;
    for (let i = Math.max(0, start); i < to; i++) {
        const value = values[i] || base;
        if (size !== null && value !== size)
            return null;
        size = value;
    }
    return size ?? base;
}

export function stepSizes(sizes, length, start, end, base, delta) {
    const values = expandSizes(sizes, length);
    const to = Math.min(end, length);
    for (let i = Math.max(0, start); i < to; i++) {
        const next = stepSize(values[i] || base, delta);
        values[i] = next === base ? 0 : next;
    }
    return compact(values, 'size');
}

export function attributeRuns(text, spans, sizes = []) {
    const chars = Array.from(text);
    const length = chars.length;
    const bits = expand(spans, length);
    const points = expandSizes(sizes, length);
    const done = new Uint8Array(length);
    let lineStart = 0;
    for (let i = 0; i <= length; i++) {
        if (i !== length && chars[i] !== '\n')
            continue;
        const mark = lineMark(chars.slice(lineStart, i).join(''));
        if (mark && mark.kind === 'check' && mark.done) {
            for (let n = lineStart + mark.chars; n < i; n++)
                done[n] = 1;
        }
        lineStart = i + 1;
    }
    const offset = new Array(length + 1);
    offset[0] = 0;
    for (let i = 0; i < length; i++)
        offset[i + 1] = offset[i] + utf8Size(chars[i]);
    const runs = [];
    let i = 0;
    while (i < length) {
        let j = i + 1;
        while (j < length && bits[j] === bits[i] && done[j] === done[i] && points[j] === points[i])
            j += 1;
        if (bits[i] || done[i] || points[i]) {
            runs.push({
                start: offset[i],
                end: offset[j],
                style: bits[i],
                done: done[i] === 1,
                size: points[i],
            });
        }
        i = j;
    }
    return runs;
}

// ---------- Markdown inline markers (toolbar) ----------

function clampOffset(value, length) {
    return Math.max(0, Math.min(value, length));
}

function charsMatchAt(chars, at, sequence) {
    for (let i = 0; i < sequence.length; i++) {
        if (chars[at + i] !== sequence[i])
            return false;
    }
    return true;
}

// Non-nesting pairs of `open`/`close` found in [from, to). Used to detect a
// caret or selection wrapped by a marker on its line.
function linePairs(chars, from, to, open, close) {
    const pairs = [];
    let openAt = -1;
    for (let i = from; i < to; i++) {
        if (openAt < 0) {
            if (charsMatchAt(chars, i, open)) {
                openAt = i;
                i += open.length - 1;
            }
        } else if (charsMatchAt(chars, i, close)) {
            pairs.push({open: openAt, close: i});
            openAt = -1;
            i += close.length - 1;
        }
    }
    return pairs;
}

function lineBoundsAt(chars, index) {
    let from = 0;
    for (let i = index - 1; i >= 0; i--) {
        if (chars[i] === '\n') {
            from = i + 1;
            break;
        }
    }
    let to = chars.length;
    for (let i = index; i < chars.length; i++) {
        if (chars[i] === '\n') {
            to = i;
            break;
        }
    }
    return {from, to};
}

function normalizedRange(chars, start, end) {
    const length = chars.length;
    let from = clampOffset(start, length);
    let to = clampOffset(end, length);
    if (from > to)
        [from, to] = [to, from];
    return [from, to];
}

function selectionWrappedOutside(chars, start, end, open, close) {
    return start >= open.length &&
        end + close.length <= chars.length &&
        charsMatchAt(chars, start - open.length, open) &&
        charsMatchAt(chars, end, close);
}

function selectionWrappedInside(chars, start, end, open, close) {
    return end - start >= open.length + close.length &&
        charsMatchAt(chars, start, open) &&
        charsMatchAt(chars, end - close.length, close);
}

// Style bits set when the range matches a wrapped pair: either the markers
// sit just outside the selection, or inside it. An empty selection reports
// the markers enclosing the caret on its line.
export function markerStatesAt(text, start, end) {
    const chars = Array.from(text);
    const [from, to] = normalizedRange(chars, start, end);
    let bits = 0;
    for (const [bit, marker] of Object.entries(MARKERS)) {
        const open = Array.from(marker.open);
        const close = Array.from(marker.close);
        let on = false;
        if (from === to) {
            const {from: lineFrom, to: lineTo} = lineBoundsAt(chars, from);
            on = linePairs(chars, lineFrom, lineTo, open, close)
                .some(pair => pair.open < from && from < pair.close + close.length);
        } else {
            on = selectionWrappedOutside(chars, from, to, open, close) ||
                selectionWrappedInside(chars, from, to, open, close);
        }
        if (on)
            bits |= Number(bit);
    }
    return bits;
}

// Wraps [start, end) with `marker`, or unwraps it when it is already wrapped
// (markers just outside the selection or inside it). With no selection, a
// pair enclosing the caret is removed; otherwise an empty pair is inserted
// with the caret between the markers. Returns the new selection, so a
// selected range stays selected after the toggle.
export function toggleMarker(text, start, end, marker) {
    const chars = Array.from(text);
    const [from, to] = normalizedRange(chars, start, end);
    const open = Array.from(marker.open);
    const close = Array.from(marker.close);
    if (from === to) {
        const {from: lineFrom, to: lineTo} = lineBoundsAt(chars, from);
        const pair = linePairs(chars, lineFrom, lineTo, open, close)
            .find(candidate => candidate.open < from && from < candidate.close + close.length);
        if (pair) {
            const next = chars.slice(0, pair.open).concat(
                chars.slice(pair.open + open.length, pair.close),
                chars.slice(pair.close + close.length));
            return {text: next.join(''), start: pair.open, end: pair.open};
        }
        const next = chars.slice(0, from).concat(open, close, chars.slice(from));
        return {text: next.join(''), start: from + open.length, end: from + open.length};
    }
    if (selectionWrappedOutside(chars, from, to, open, close)) {
        const next = chars.slice(0, from - open.length).concat(chars.slice(from, to))
            .concat(chars.slice(to + close.length));
        return {text: next.join(''), start: from - open.length, end: to - open.length};
    }
    if (selectionWrappedInside(chars, from, to, open, close)) {
        const next = chars.slice(0, from).concat(chars.slice(from + open.length, to - close.length))
            .concat(chars.slice(to));
        return {text: next.join(''), start: from, end: to - open.length - close.length};
    }
    const next = chars.slice(0, from).concat(open, chars.slice(from, to), close, chars.slice(to));
    return {text: next.join(''), start: from + open.length, end: to + open.length};
}

// ---------- Markdown tables ----------

// A small 3x2 skeleton for the Insert table button: three columns, two
// empty data rows, caret in the first header cell.
export function tableSkeleton() {
    return [
        '| Col 1 | Col 2 | Col 3 |',
        '| --- | --- | --- |',
        '|  |  |  |',
        '|  |  |  |',
    ];
}

export function insertTable(text, start, end) {
    const chars = Array.from(text);
    const [from, to] = normalizedRange(chars, start, end);
    const before = chars.slice(0, from);
    const after = chars.slice(to);
    // The table starts on its own line.
    let prefix = '';
    for (let i = before.length - 1; i >= 0; i--) {
        if (before[i] === '\n')
            break;
        if (before[i] !== ' ' && before[i] !== '\t') {
            prefix = '\n';
            break;
        }
    }
    const block = prefix + tableSkeleton().join('\n');
    // Whatever follows the selection lands on the next line, or on a new one.
    const tail = after.length ? (after[0] === '\n' ? after.join('') : `\n${after.join('')}`) : '\n';
    const next = before.join('') + block + tail;
    const cursor = from + Array.from(prefix).length + Array.from('| ').length;
    return {text: next, cursor};
}
