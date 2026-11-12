// A deliberately small, safe Pango-markup preview for common Markdown.
// All user content is escaped; markup is generated only by our own renderer.
// The editable source remains the original Markdown string.
import {utf8Length} from './format.js';
import {parseTodoLine, dueStatus, splitDisplayLine, toDateString} from './todo.js';

function escapePango(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function displayWidth(text) {
    return Array.from(text).length;
}

// Text with the inline markers removed, for measuring column widths.
const INLINE_TOKENS = /(\`[^\`\n]+\`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^\)\n]*\)|<u>|<\/u>)/g;

function stripInline(source) {
    return source.replace(INLINE_TOKENS, token => {
        if (token === '<u>' || token === '</u>')
            return '';
        if (token.startsWith('**') || token.startsWith('__'))
            return token.slice(2, -2);
        if (token.startsWith('~~'))
            return token.slice(2, -2);
        if (token.startsWith('\`'))
            return token.slice(1, -1);
        if (token.startsWith('['))
            return token.slice(1, token.indexOf(']'));
        return token.slice(1, -1);
    });
}

function inline(source) {
    // Non-nested Markdown spans; unmatched delimiters remain literal.
    const tokens = /(\`[^\`\n]+\`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^\)\n]*\)|<u>|<\/u>)/g;
    let result = '';
    let previous = 0;
    // Inline HTML underline. It is balanced inside this one line; a stray
    // close tag is escaped, a missing one is closed at the end of the line.
    let underline = 0;
    for (const match of source.matchAll(tokens)) {
        result += escapePango(source.slice(previous, match.index));
        const token = match[0];
        if (token === '<u>') {
            result += '<u>';
            underline += 1;
        } else if (token === '</u>') {
            if (underline > 0) {
                result += '</u>';
                underline -= 1;
            } else {
                result += '&lt;/u&gt;';
            }
        } else if (token.startsWith('**') || token.startsWith('__'))
            result += `<b>${inline(token.slice(2, -2))}</b>`;
        else if (token.startsWith('~~'))
            result += `<s>${inline(token.slice(2, -2))}</s>`;
        else if (token.startsWith('\`'))
            result += `<tt>${escapePango(token.slice(1, -1))}</tt>`;
        else if (token.startsWith('['))
            result += `<u>${inline(token.slice(1, token.indexOf(']')))}</u>`;
        else
            result += `<i>${inline(token.slice(1, -1))}</i>`;
        previous = match.index + token.length;
    }
    return result + escapePango(source.slice(previous)) + '</u>'.repeat(underline);
}

// Splits a table row into its cells, or returns null when the line is not
// a table row. Leading/trailing pipes are optional.
function parseTableRow(line) {
    const trimmed = line.trim();
    if (!trimmed.includes('|'))
        return null;
    let cells = trimmed.split('|');
    if (cells.length && cells[0].trim() === '')
        cells = cells.slice(1);
    if (cells.length && cells[cells.length - 1].trim() === '')
        cells = cells.slice(0, -1);
    if (!cells.length)
        return null;
    return cells.map(cell => cell.trim());
}

// The separator line under the header: dashes with optional colons.
// Returns per-column alignment, or null when the line is not a separator.
function parseTableSeparator(line) {
    const cells = parseTableRow(line);
    if (!cells)
        return null;
    const aligns = [];
    for (const cell of cells) {
        const match = /^(:?)-{3,}(:?)$/.exec(cell);
        if (!match)
            return null;
        aligns.push(match[1] && match[2] ? 'center' : match[2] ? 'right' : 'left');
    }
    return aligns;
}

function tableAt(lines, index) {
    const header = parseTableRow(lines[index]);
    if (!header || header.length < 2)
        return null;
    const aligns = parseTableSeparator(lines[index + 1] ?? '');
    if (!aligns || aligns.length !== header.length)
        return null;
    const rows = [];
    let end = index + 2;
    for (; end < lines.length; end++) {
        const row = parseTableRow(lines[end]);
        if (!row)
            break;
        rows.push(row);
    }
    return {header, aligns, rows, end};
}

function renderTable(table) {
    const columns = table.header.length;
    // Pad short rows with empty cells; drop cells beyond the header width.
    const matrix = [table.header, ...table.rows].map(row => {
        const out = row.slice(0, columns);
        while (out.length < columns)
            out.push('');
        return out;
    });
    const widths = [];
    for (let column = 0; column < columns; column++) {
        let width = 3;
        for (const row of matrix)
            width = Math.max(width, displayWidth(stripInline(row[column])));
        widths.push(width);
    }
    // Pango tags are invisible, so cells are laid out by display width of
    // their marker-free text and the markup is emitted around that padding.
    const padCell = (cell, width, align) => {
        const padding = width - displayWidth(stripInline(cell));
        if (align === 'right')
            return ' '.repeat(padding) + cell;
        if (align === 'center') {
            const left = Math.floor(padding / 2);
            return ' '.repeat(left) + cell + ' '.repeat(padding - left);
        }
        return cell + ' '.repeat(padding);
    };
    const border = (left, junction, right) =>
        `${left}${widths.map(width => '─'.repeat(width + 2)).join(junction)}${right}`;
    const renderRow = (cells, bold) => '│ ' + cells.map((cell, column) => {
        const align = table.aligns[column] ?? 'left';
        const rendered = inline(padCell(cell, widths[column], align));
        return bold ? `<b>${rendered}</b>` : rendered;
    }).join(' │ ') + ' │';
    const lines = [
        `<tt>${escapePango(border('┌', '┬', '┐'))}</tt>`,
        `<tt>${renderRow(matrix[0], true)}</tt>`,
        `<tt>${escapePango(border('├', '┼', '┤'))}</tt>`,
    ];
    for (let row = 1; row < matrix.length; row++)
        lines.push(`<tt>${renderRow(matrix[row], false)}</tt>`);
    lines.push(`<tt>${escapePango(border('└', '┴', '┘'))}</tt>`);
    return lines.join('\n');
}

function renderLine(line) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
        const size = heading[1].length <= 2 ? 'x-large' : 'large';
        return `<span weight="bold" size="${size}">${inline(heading[2])}</span>`;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line))
        return '────────────────';
    const box = line.match(/^(\s*)(?:-|\*|\+)\s+\[([xX ])\]\s+(.*)$/);
    if (box)
        return `${escapePango(box[1])}${box[2] === ' ' ? '☐' : '☑'}  ${inline(box[3])}`;
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet)
        return `${escapePango(bullet[1])}•  ${inline(bullet[2])}`;
    const ordered = line.match(/^(\s*)(\d{1,9})\.\s+(.*)$/);
    if (ordered)
        return `${escapePango(ordered[1])}${ordered[2]}.  ${inline(ordered[3])}`;
    return inline(line);
}

// ---- todo.txt preview ----
const TAG_COLOR = '#5e5c64';
const DUE_COLORS = {overdue: '#c01c28', today: '#e5a50a', future: '#3584e4'};

function priorityColor(priority) {
    if (priority === 'A')
        return '#e01b24';
    if (priority === 'B')
        return '#ff7800';
    if (priority === 'C')
        return '#e5a50a';
    if (priority <= 'F')
        return '#3584e4';
    return '#5e5c64';
}

function todoToken(token, done, today) {
    const escaped = escapePango(token);
    if (done)
        return `<s>${escaped}</s>`;
    if (token.startsWith('+') && token.length > 1)
        return `<span foreground="#26a269"><b>${escaped}</b></span>`;
    if (token.startsWith('@') && token.length > 1)
        return `<span foreground="#1c71d8"><b>${escaped}</b></span>`;
    const tag = token.match(/^([A-Za-z][A-Za-z0-9_-]*):([^\s]+)$/);
    if (tag) {
        const key = tag[1].toLowerCase();
        if (key === 'due') {
            const status = dueStatus(tag[2], today);
            const color = DUE_COLORS[status] ?? TAG_COLOR;
            return `<span foreground="${color}"><b>${escaped}</b></span>`;
        }
        if (key === 'rec')
            return `<span foreground="#9141ac">${escaped}</span>`;
        return `<span foreground="${TAG_COLOR}">${escaped}</span>`;
    }
    return escaped;
}

function renderTodoLine(line, today) {
    const {raw} = splitDisplayLine(line);
    const trimmed = raw.trim();
    if (!trimmed)
        return '';
    const parsed = parseTodoLine(raw);
    if (!parsed)
        return escapePango(raw);
    const parts = [];
    parts.push(parsed.completed ? '<span foreground="#2ec27e">☑</span>' : '☐');
    if (parsed.priority)
        parts.push(`<span background="${priorityColor(parsed.priority)}" foreground="#ffffff" weight="bold"> ${parsed.priority} </span>`);
    if (parsed.creationDate)
        parts.push(`<span foreground="${TAG_COLOR}">${escapePango(parsed.creationDate)}</span>`);
    const description = parsed.description.split(/\s+/).filter(Boolean)
        .map(token => todoToken(token, parsed.completed, today))
        .join(' ');
    parts.push(description);
    return parts.join(' ');
}

// One output line per source line, plus the byte offset of each output line
// inside the markup. The caller uses the offsets to map a pointer position
// back to a source line.
export function renderTodo(source, today = toDateString(new Date())) {
    const out = [];
    const offsets = [];
    let bytes = 0;
    for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
        offsets.push(bytes);
        const rendered = renderTodoLine(line, today);
        out.push(rendered);
        bytes += utf8Length(rendered) + 1;
    }
    return {markup: out.join('\n'), offsets, end: bytes};
}

export function renderMarkdown(source) {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let fenced = false;
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (/^\s*\`\`\`/.test(line)) {
            fenced = !fenced;
            index += 1;
            continue;
        }
        if (fenced) {
            out.push(`<tt>${escapePango(line)}</tt>`);
            index += 1;
            continue;
        }
        const table = tableAt(lines, index);
        if (table) {
            out.push(renderTable(table));
            index = table.end;
            continue;
        }
        out.push(renderLine(line));
        index += 1;
    }
    return out.join('\n');
}
