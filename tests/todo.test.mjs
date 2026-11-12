import test from 'node:test';
import assert from 'node:assert/strict';
import {
    dueStatus,
    parseTodoLine,
    recurrenceNextLine,
    shiftDate,
    sortTodoLines,
    sortTodoText,
    stripTodoGlyphs,
    toDateString,
    toggleTodoDisplayLine,
    toggleTodoLine,
    todoBackspace,
    todoContinuation,
    todoEndOfLine,
    validDate,
    withTodoGlyphs,
} from '../extension/todo.js';

test('parses a minimal task line', () => {
    const parsed = parseTodoLine('Buy milk');
    assert.equal(parsed.completed, false);
    assert.equal(parsed.priority, null);
    assert.equal(parsed.creationDate, null);
    assert.equal(parsed.description, 'Buy milk');
});

test('parses priority after an x completion prefix', () => {
    const parsed = parseTodoLine('x 2026-11-12 (A) 2026-11-01 Submit proposal');
    assert.equal(parsed.completed, true);
    assert.equal(parsed.completionDate, '2026-11-12');
    assert.equal(parsed.priority, 'A');
    assert.equal(parsed.creationDate, '2026-11-01');
    assert.equal(parsed.description, 'Submit proposal');
});

test('parses projects, contexts and key/value tags', () => {
    const parsed = parseTodoLine('(B) 2026-11-12 Review contract +legal +work @phone @desk due:2026-12-01 est:2h');
    assert.equal(parsed.priority, 'B');
    assert.deepEqual(parsed.projects, ['legal', 'work']);
    assert.deepEqual(parsed.contexts, ['phone', 'desk']);
    assert.equal(parsed.tags.due, '2026-12-01');
    assert.equal(parsed.tags.est, '2h');
});

test('blank and whitespace-only lines are not tasks', () => {
    assert.equal(parseTodoLine(''), null);
    assert.equal(parseTodoLine('   '), null);
});

test('invalid calendar dates are not accepted as dates', () => {
    assert.equal(validDate('2026-02-30'), false);
    assert.equal(validDate('2026-13-01'), false);
    assert.equal(validDate('2026-11-12'), true);
    const parsed = parseTodoLine('x 2026-13-99 whatever');
    assert.equal(parsed.completionDate, null);
});

test('validates dates by roundtrip, not just ranges', () => {
    assert.equal(validDate('2026-02-29'), false); // 2026 is not a leap year
    assert.equal(validDate('2028-02-29'), true);
    assert.equal(validDate('2026-04-31'), false);
});

test('toggleTodoLine prefixes x and the completion date', () => {
    assert.equal(toggleTodoLine('(A) 2026-11-01 Call mom', '2026-11-12'),
        'x 2026-11-12 (A) 2026-11-01 Call mom');
});

test('toggleTodoLine removes x and the completion date', () => {
    assert.equal(toggleTodoLine('x 2026-11-12 (A) 2026-11-01 Call mom', '2026-11-12'),
        '(A) 2026-11-01 Call mom');
});

test('toggleTodoLine accepts x without a date', () => {
    assert.equal(toggleTodoLine('x (A) Call mom', '2026-11-12'), '(A) Call mom');
});

test('toggleTodoLine returns null for non-task lines', () => {
    assert.equal(toggleTodoLine('', '2026-11-12'), null);
    assert.equal(toggleTodoLine('   ', '2026-11-12'), null);
});

test('display roundtrip preserves the raw file byte for byte', () => {
    const raw = [
        '(A) 2026-11-01 Call mom',
        'x 2026-11-10 Buy milk +store @corner due:2026-11-12',
        '',
        'Review code rec:weekly',
        '☐ literal glyph in text',
    ].join('\n');
    const display = withTodoGlyphs(raw);
    assert.notEqual(display, raw);
    assert.equal(stripTodoGlyphs(display), raw);
});

test('display glyphs mirror the completion state', () => {
    const display = withTodoGlyphs('(A) Task one\nx 2026-11-10 Task two');
    const lines = display.split('\n');
    assert.ok(lines[0].startsWith('☐'));
    assert.ok(lines[1].startsWith('☑'));
});

test('toggleTodoDisplayLine flips glyph and x date together', () => {
    const display = withTodoGlyphs('(A) 2026-11-01 Call mom');
    const toggled = toggleTodoDisplayLine(display, '2026-11-12');
    assert.ok(toggled.startsWith('☑'));
    assert.equal(stripTodoGlyphs(toggled), 'x 2026-11-12 (A) 2026-11-01 Call mom');
    const restored = toggleTodoDisplayLine(toggled, '2026-11-12');
    assert.ok(restored.startsWith('☐'));
    assert.equal(stripTodoGlyphs(restored), '(A) 2026-11-01 Call mom');
});

test('recurrence generates the next daily occurrence from due', () => {
    const parsed = parseTodoLine('(A) 2026-11-01 Water plants rec:daily due:2026-11-10');
    const next = recurrenceNextLine(parsed, '2026-11-12');
    assert.equal(next, '(A) 2026-11-12 Water plants rec:daily due:2026-11-11');
});

test('recurrence shifts weekly and monthly dues', () => {
    const weekly = parseTodoLine('Write report rec:weekly due:2026-11-10');
    assert.equal(recurrenceNextLine(weekly, '2026-11-12'),
        '2026-11-12 Write report rec:weekly due:2026-11-17');
    const monthly = parseTodoLine('Pay rent rec:monthly due:2026-01-31');
    assert.equal(recurrenceNextLine(monthly, '2026-02-10'),
        '2026-02-10 Pay rent rec:monthly due:2026-02-28');
});

test('recurrence falls back to t:, then creation date, then today', () => {
    const threshold = parseTodoLine('Start project rec:weekly t:2026-11-10');
    assert.equal(recurrenceNextLine(threshold, '2026-11-12'),
        '2026-11-12 Start project rec:weekly t:2026-11-17');
    const created = parseTodoLine('2026-11-05 Stretch rec:daily');
    assert.equal(recurrenceNextLine(created, '2026-11-12'),
        '2026-11-12 Stretch rec:daily');
    const bare = parseTodoLine('Stretch rec:daily');
    assert.ok(recurrenceNextLine(bare, '2026-11-12').startsWith('2026-11-12 Stretch'));
});

test('recurrence ignores unknown or missing rec tags', () => {
    assert.equal(recurrenceNextLine(parseTodoLine('No rec here'), '2026-11-12'), null);
    assert.equal(recurrenceNextLine(parseTodoLine('rec:fortnightly Task'), '2026-11-12'), null);
});

test('dueStatus reports overdue, today and future', () => {
    assert.equal(dueStatus('2026-11-11', '2026-11-12'), 'overdue');
    assert.equal(dueStatus('2026-11-12', '2026-11-12'), 'today');
    assert.equal(dueStatus('2026-11-13', '2026-11-12'), 'future');
    assert.equal(dueStatus('bad', '2026-11-12'), null);
    assert.equal(dueStatus(undefined, '2026-11-12'), null);
});

test('shiftDate adds days and clamps missing month days', () => {
    assert.equal(shiftDate('2026-11-12', {days: 7}), '2026-11-19');
    assert.equal(shiftDate('2026-01-31', {months: 1}), '2026-02-28');
    assert.equal(shiftDate('2028-01-31', {months: 1}), '2028-02-29');
    assert.equal(shiftDate('2026-12-15', {months: 2}), '2027-02-15');
});

test('sortTodos keeps active tasks first by priority then creation date', () => {
    const input = [
        'x 2026-11-01 (B) 2026-10-01 Old done',
        '(C) 2026-10-05 Third',
        '(A) 2026-10-07 First B',
        '(A) 2026-10-03 First A',
        '2026-10-02 No prio B',
        '2026-10-01 No prio A',
    ];
    assert.deepEqual(sortTodoLines(input), [
        '(A) 2026-10-03 First A',
        '(A) 2026-10-07 First B',
        '(C) 2026-10-05 Third',
        '2026-10-01 No prio A',
        '2026-10-02 No prio B',
        'x 2026-11-01 (B) 2026-10-01 Old done',
    ]);
});

test('sortTodos is stable and leaves blank lines in place', () => {
    const input = [
        '',
        '(B) 2026-10-02 Second',
        '   ',
        '(A) 2026-10-03 First',
        'plain note',
    ];
    const sorted = sortTodoLines(input);
    assert.deepEqual(sorted, [
        '',
        '(A) 2026-10-03 First',
        '   ',
        '(B) 2026-10-02 Second',
        'plain note',
    ]);
    assert.equal(sortTodoText(input.join('\n')), sorted.join('\n'));
});

test('todoContinuation scaffolds a new dated task after a task line', () => {
    const display = withTodoGlyphs('(A) 2026-11-01 Call mom');
    const next = `${display}\n`;
    assert.equal(todoContinuation(next, next.length, '2026-11-12'),
        '☐\uFE0E 2026-11-12 ');
});

test('todoContinuation leaves a blank line alone', () => {
    const text = '\n';
    assert.equal(todoContinuation(text, text.length, '2026-11-12'), null);
    const blankAfterTask = withTodoGlyphs('Task one') + '\n\n';
    assert.equal(todoContinuation(blankAfterTask, blankAfterTask.length, '2026-11-12'), null);
});

test('todoEndOfLine drops a scaffold-only line', () => {
    const text = 'Task one\n☐\uFE0E 2026-11-12 ';
    const result = todoEndOfLine(text, text.length);
    assert.equal(result.text, 'Task one\n');
    assert.equal(result.cursor, 'Task one\n'.length);
});

test('todoEndOfLine ignores lines with a description', () => {
    const text = '☐\uFE0E 2026-11-12 Real task';
    assert.equal(todoEndOfLine(text, text.length), null);
});

test('todoBackspace peels the date before the glyph on a scaffold line', () => {
    const text = '(A) 2026-11-01 Call mom\n☐\uFE0E 2026-11-12 ';
    const stripped = todoBackspace(text, text.length);
    assert.equal(stripped.text, '(A) 2026-11-01 Call mom\n☐\uFE0E ');
    assert.equal(stripped.cursor, '(A) 2026-11-01 Call mom\n☐\uFE0E '.length);
    const glyphOnly = todoBackspace(stripped.text, stripped.cursor);
    assert.equal(glyphOnly.text, '(A) 2026-11-01 Call mom\n');
});

test('todoBackspace ignores lines with a description or no scaffold', () => {
    const filled = '☐\uFE0E 2026-11-12 Real task';
    assert.equal(todoBackspace(filled, filled.length), null);
    const midLine = '☐\uFE0E 2026-11-12 ';
    assert.equal(todoBackspace(midLine, 2), null);
    assert.equal(todoBackspace('No glyph', 8), null);
});

test('toDateString formats a local date as YYYY-MM-DD', () => {
    assert.match(toDateString(), /^\d{4}-\d{2}-\d{2}$/);
});
