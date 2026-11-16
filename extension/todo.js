// todo.txt support, following https://todotxt.in/blog/todo-txt-format-complete-guide
//
// Syntax summary:
//   Completed:  x YYYY-MM-DD (optional priority and creation date) description
//   Priority:   (A) ... (Z), at most one, at the very start (after the x prefix)
//   Created:    YYYY-MM-DD after the priority
//   Projects:   +project    Contexts:  @context
//   Tags:       key:value   (due:, t:, rec:, est:, ...)
//
// This module is pure JavaScript with no GNOME imports, so the rules are
// testable with Node.js. The display text used by the editor carries one
// extra ☐/☑ glyph per task line; the file on disk never contains it.
// withTodoGlyphs adds the glyphs when a file is loaded, stripTodoGlyphs
// removes them again when the file is saved.
// Display text uses the legacy checkbox glyph (one per task line) so the
// existing marker helpers recognize task lines. The file never sees them.
const GLYPH_OPEN = '☐\uFE0E ';
const GLYPH_DONE = '☑\uFE0E ';

export function todoGlyph(done) {
    return done ? GLYPH_DONE : GLYPH_OPEN;
}

const D = '[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])';
const DATE_SRC = D;
const COMPLETED_RE = new RegExp(`^x(?: (${D}))? `);
const PRIORITY_RE = /^\(([A-Z])\) /;
const CREATION_RE = new RegExp(`^(${D}) `);
// The FE0E variation selector is mandatory: a raw file line that merely
// starts with a bare glyph stays user content and round-trips untouched.
const GLYPH_RE = /^[☐☑]\uFE0E /;
const TAG_RE = /^([A-Za-z][A-Za-z0-9_-]*):([^\s]+)$/;

function pad2(n) {
    return String(n).padStart(2, '0');
}

export function validDate(value) {
    if (typeof value !== 'string')
        return false;
    const match = value.match(new RegExp(`^${D}$`));
    if (!match)
        return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

export function formatDate(date) {
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function shiftDate(value, {days = 0, months = 0} = {}) {
    const [year, month, day] = value.split('-').map(Number);
    let total = month - 1 + months;
    const targetYear = year + Math.floor(total / 12);
    const targetMonth = ((total % 12) + 12) % 12;
    const daysInMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const targetDay = Math.min(day, daysInMonth);
    const date = new Date(Date.UTC(targetYear, targetMonth, targetDay));
    date.setUTCDate(date.getUTCDate() + days);
    return formatDate(date);
}

export function toDateString(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// Parse one raw line (no display glyph). Returns null for blank lines.
export function parseTodoLine(line) {
    if (typeof line !== 'string')
        return null;
    const raw = line;
    let rest = line.replace(/\s+$/, '');
    if (!rest.trim())
        return null;
    let completed = false;
    let completionDate = null;
    const done = rest.match(COMPLETED_RE);
    if (done) {
        completed = true;
        completionDate = done[1] ?? null;
        rest = rest.slice(done[0].length);
    }
    let priority = null;
    const prio = rest.match(PRIORITY_RE);
    if (prio) {
        priority = prio[1];
        rest = rest.slice(prio[0].length);
    }
    let creationDate = null;
    const created = rest.match(CREATION_RE);
    if (created) {
        creationDate = created[1];
        rest = rest.slice(created[0].length);
    }
    const description = rest;
    const projects = [];
    const contexts = [];
    const tags = {};
    for (const token of description.split(/\s+/)) {
        if (!token)
            continue;
        if (token.startsWith('+') && token.length > 1) {
            projects.push(token.slice(1));
        } else if (token.startsWith('@') && token.length > 1) {
            contexts.push(token.slice(1));
        } else {
            const tag = token.match(TAG_RE);
            if (tag)
                tags[tag[1].toLowerCase()] = tag[2];
        }
    }
    return {raw, completed, completionDate, priority, creationDate,
        description, projects, contexts, tags};
}

export function isTaskLine(line) {
    const parsed = parseTodoLine(line);
    if (!parsed)
        return false;
    // A line is only a task when it is structurally well-formed todo.txt.
    // Malformed prefixes, dates and tags are rejected so they are never
    // toggled, sorted or scaffolded as tasks.
    return validateTodoLine(line).ok;
}

// Structural validation of one raw todo.txt line. A line is a valid task when
// its leading prefix is structurally well-formed: priority must be a single
// (A)-(Z) pair, every date must be a real calendar date, and every project,
// context and key:value tag must be non-empty. A bare description is always
// valid — priority is optional in the todo.txt format.
export function validateTodoLine(line) {
    const parsed = parseTodoLine(line);
    if (!parsed)
        return {ok: true, line: null};
    const errors = [];
    if (parsed.priority && !/^[A-Z]$/.test(parsed.priority))
        errors.push('priority must be a single letter A-Z');
    if (parsed.completionDate && !validDate(parsed.completionDate))
        errors.push('invalid completion date');
    if (parsed.creationDate && !validDate(parsed.creationDate))
        errors.push('invalid creation date');
    for (const project of parsed.projects) {
        if (!project)
            errors.push('empty project token');
    }
    for (const context of parsed.contexts) {
        if (!context)
            errors.push('empty context token');
    }
    for (const [key, value] of Object.entries(parsed.tags)) {
        if (!key || !value)
            errors.push(`empty tag ${key || 'value'}`);
        else if (key === 'due' || key === 't') {
            if (!validDate(value))
                errors.push(`invalid date in tag ${key}`);
        } else if (key === 'rec' && !RECURRENCE[value])
            errors.push(`unknown recurrence ${value}`);
    }
    return errors.length ? {ok: false, line: parsed.raw, errors} : {ok: true, line: parsed.raw};
}

// Validate every line of a raw todo.txt text. Blank lines are always ok.
export function validateTodoText(text) {
    const lines = text.split('\n');
    const problems = [];
    for (let i = 0; i < lines.length; i++) {
        const result = validateTodoLine(lines[i]);
        if (!result.ok)
            problems.push({index: i, ...result});
    }
    return problems;
}

// Insert a new task line at the given line index, scaffolding it with today's
// creation date and an unchecked glyph. Returns the new display text and the
// caret position just after the inserted line, or null when the index is out
// of range. The inserted line is always a structurally valid task.
export function insertTaskLine(text, index, {today = toDateString(new Date()),
    priority = null, description = ''} = {}) {
    const lines = text.split('\n');
    if (index < 0 || index > lines.length)
        return null;
    const prefix = priority ? `(${priority}) ` : '';
    const raw = `${prefix}${today} ${description}`.trim();
    const display = displayLine(raw, false);
    lines.splice(index, 0, display);
    let cursor = 0;
    for (let i = 0; i < index; i++)
        cursor += Array.from(lines[i]).length + 1;
    cursor += Array.from(display).length + 1;
    return {text: lines.join('\n'), cursor};
}

// Remove one task line at the given index. Returns the new display text and the
// caret position at the start of the removed slot, or null when the index is
// out of range or the line is not a task.
export function removeTaskLine(text, index) {
    const lines = text.split('\n');
    if (index < 0 || index >= lines.length)
        return null;
    const {raw} = splitDisplayLine(lines[index]);
    if (!parseTodoLine(raw))
        return null;
    lines.splice(index, 1);
    let cursor = 0;
    for (let i = 0; i < index; i++)
        cursor += Array.from(lines[i]).length + 1;
    return {text: lines.join('\n'), cursor};
}

// Line index of the task whose glyph/first character sits at the given
// character offset in the display text, or -1 when the offset is not inside a
// task line.
export function taskLineIndexAt(text, offset) {
    let index = 0;
    let seen = 0;
    for (const line of text.split('\n')) {
        const length = Array.from(line).length;
        if (seen <= offset && offset <= seen + length) {
            const {raw} = splitDisplayLine(line);
            return parseTodoLine(raw) ? index : -1;
        }
        seen += length + 1;
        index += 1;
    }
    return -1;
}

// Toggle completion on a raw line: prefix `x <today>` or strip the x prefix.
// Returns the new line, or null when the line holds no task.
export function toggleTodoLine(line, today) {
    const parsed = parseTodoLine(line);
    if (!parsed)
        return null;
    if (parsed.completed)
        return line.replace(COMPLETED_RE, '');
    return `x ${today} ${line}`;
}

const RECURRENCE = {daily: {days: 1}, weekly: {days: 7}, monthly: {months: 1}};

function validOrNull(value) {
    return validDate(value) ? value : null;
}

function shiftTag(body, tag, original, shifted) {
    const pattern = new RegExp(`(^|\\s)${tag}:${original}(?=\\s|$)`);
    return body.replace(pattern, `$1${tag}:${shifted}`);
}

// Build the follow-up task for a recurrence, or null when the recurrence is
// missing, unknown, or already handled. due: is shifted first, else t:, else
// the creation date seeds only the new creation date.
export function recurrenceNextLine(parsed, today) {
    const rec = parsed.tags.rec?.toLowerCase();
    const interval = rec ? RECURRENCE[rec] : null;
    if (!interval)
        return null;
    const due = validOrNull(parsed.tags.due);
    const start = validOrNull(parsed.tags.t);
    const base = due ?? start ?? validOrNull(parsed.creationDate) ?? today;
    const next = shiftDate(base, interval);
    let body = parsed.description;
    if (due)
        body = shiftTag(body, 'due', due, next);
    else if (start)
        body = shiftTag(body, 't', start, next);
    const priority = parsed.priority ? `(${parsed.priority}) ` : '';
    return `${priority}${today} ${body}`;
}

// overdue | today | future | null (missing or invalid due date).
export function dueStatus(due, today) {
    if (!validOrNull(due) || !validOrNull(today))
        return null;
    if (due < today)
        return 'overdue';
    if (due === today)
        return 'today';
    return 'future';
}

function priorityRank(priority) {
    if (!priority)
        return 26;
    return priority.charCodeAt(0) - 'A'.charCodeAt(0);
}

// Stable sort of the task lines only, in file order: active tasks first by
// priority (A..Z, then none), then by creation date (none last); completed
// tasks at the end in their original order. Non-task lines keep their slots.
export function sortTodoLines(lines) {
    const result = lines.slice();
    const taskAt = [];
    const tasks = [];
    for (let index = 0; index < result.length; index++) {
        const parsed = parseTodoLine(result[index]);
        if (parsed) {
            taskAt.push(index);
            tasks.push({line: result[index], parsed, index});
        }
    }
    const ordered = tasks.slice().sort((a, b) => {
        const doneA = a.parsed.completed ? 1 : 0;
        const doneB = b.parsed.completed ? 1 : 0;
        if (doneA !== doneB)
            return doneA - doneB;
        const prio = priorityRank(a.parsed.priority) - priorityRank(b.parsed.priority);
        if (prio !== 0)
            return prio;
        const createdA = a.parsed.creationDate ?? '9999-12-31';
        const createdB = b.parsed.creationDate ?? '9999-12-31';
        if (createdA !== createdB)
            return createdA < createdB ? -1 : 1;
        return a.index - b.index;
    });
    for (let i = 0; i < taskAt.length; i++)
        result[taskAt[i]] = ordered[i].line;
    return result;
}

export function sortTodoText(text) {
    const lines = text.split('\n');
    return sortTodoLines(lines).join('\n');
}

// ---- Display helpers (editor text carries one glyph per task line) ----

export function splitDisplayLine(line) {
    const match = line.match(GLYPH_RE);
    if (!match)
        return {glyph: '', raw: line};
    return {glyph: match[0], raw: line.slice(match[0].length)};
}

export function displayLine(raw, completed = false) {
    return todoGlyph(completed) + raw;
}

export function stripTodoGlyphs(text) {
    return text.split('\n')
        .map(line => line.replace(GLYPH_RE, ''))
        .join('\n');
}

// Add a glyph in front of every task line. Idempotent and safe to run on
// any text: lines that are not tasks (blank or whitespace-only) are
// returned unchanged.
export function withTodoGlyphs(text) {
    return text.split('\n')
        .map(line => {
            const {raw} = splitDisplayLine(line);
            const parsed = parseTodoLine(raw);
            if (!parsed)
                return raw;
            return displayLine(raw, parsed.completed);
        })
        .join('\n');
}

// Two-part toggle used by both the inline glyph and the preview: flip the
// glyph and the x/date prefix together. Returns the new display line.
export function toggleTodoDisplayLine(line, today) {
    const {raw} = splitDisplayLine(line);
    const nextRaw = toggleTodoLine(raw, today);
    if (nextRaw === null)
        return null;
    const parsed = parseTodoLine(nextRaw);
    return displayLine(nextRaw, parsed?.completed ?? false);
}

// Enter on a task line scaffolds a fresh task on the new line: an unchecked
// glyph plus today's creation date. Returns the prefix to insert, or null
// when the previous line is not a task.
export function todoContinuation(text, newlineAt, today) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(newlineAt, chars.length));
    // The previous line ends at at - 1 (the '\n' sits at at - 1).
    const prevEnd = at - 1;
    if (prevEnd < 0)
        return null;
    let prevStart = 0;
    for (let i = prevEnd - 1; i >= 0; i--) {
        if (chars[i] === '\n') {
            prevStart = i + 1;
            break;
        }
    }
    const prevLine = chars.slice(prevStart, prevEnd).join('');
    const {raw} = splitDisplayLine(prevLine);
    if (!parseTodoLine(raw))
        return null;
    return `${todoGlyph(false)}${today} `;
}

// Backspace at the very end of a scaffold line (glyph, or glyph plus a bare
// creation date) removes only the trailing part: first the date, then the
// glyph itself. Anywhere else, normal editing applies.
export function todoBackspace(text, cursor) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(cursor, chars.length));
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
    if (at !== end)
        return null;
    const {glyph, raw} = splitDisplayLine(chars.slice(start, end).join(''));
    if (!glyph)
        return null;
    const date = raw.match(new RegExp(`^${DATE_SRC} $`));
    if (date) {
        const drop = Array.from(date[0]).length;
        return {
            text: chars.slice(0, end - drop).concat(chars.slice(end)).join(''),
            cursor: end - drop,
        };
    }
    if (raw === '') {
        const drop = Array.from(glyph).length;
        return {
            text: chars.slice(0, start).concat(chars.slice(end)).join(''),
            cursor: start,
        };
    }
    return null;
}

// Enter on a line that holds nothing but the scaffold (glyph and optional
// creation date) turns it into a plain empty line, ending the task list.
export function todoEndOfLine(text, cursor) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(cursor, chars.length));
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
    const line = chars.slice(start, end).join('');
    const {glyph, raw} = splitDisplayLine(line);
    if (!glyph)
        return null;
    const rest = raw.replace(new RegExp(`^${DATE_SRC} $`), '');
    if (rest !== '')
        return null;
    const next = chars.slice(0, start).concat(chars.slice(end));
    return {text: next.join(''), cursor: start};
}
