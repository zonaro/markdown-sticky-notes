// A deliberately small, safe Pango-markup preview for common Markdown.
// All user content is escaped; markup is generated only by our own renderer.
// The editable source remains the original Markdown string.
//
// The renderer emits a list of ROWS, one per rendered line group. The
// notes lay each row out as its own actor, which is what makes pointer
// hit-testing exact: no byte-offset mapping between Pango and the
// source is ever needed.
import {utf8Length} from './format.js';
import {parseTodoLine, dueStatus, splitDisplayLine, toDateString} from './todo.js';

function escapePango(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function displayWidth(text) {
    return Array.from(text).length;
}

// Remove the Pango tags our renderer emits. User content never carries a
// raw '<', so stripping tags is exact for our own markup.
function stripTags(text) {
    return text.replace(/<[^>]+>/g, '');
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
            return token.slice(1, token.indexOf(']('));
        return token.slice(1, -1);
    });
}

// Render inline markup into both Pango markup and the visible plain text,
// collecting the byte range of every [label](url) in the plain text.
// `ctx` carries {pango, plain, links}; nested markup calls itself and
// translates its links into the surrounding byte coordinates.
function inlineMeasured(source, ctx) {
    ctx ??= {pango: '', plain: '', links: []};
    let underline = 0;
    let previous = 0;
    for (const match of source.matchAll(INLINE_TOKENS)) {
        ctx.pango += escapePango(source.slice(previous, match.index));
        ctx.plain += source.slice(previous, match.index);
        const token = match[0];
        if (token === '<u>') {
            ctx.pango += '<u>';
            underline += 1;
        } else if (token === '</u>') {
            if (underline > 0) {
                ctx.pango += '</u>';
                underline -= 1;
            } else {
                ctx.pango += '&lt;/u&gt;';
            }
        } else if (token.startsWith('**') || token.startsWith('__')) {
            const inner = inlineMeasured(token.slice(2, -2));
            appendMeasured(ctx, inner, `<b>${inner.pango}</b>`);
        } else if (token.startsWith('~~')) {
            const inner = inlineMeasured(token.slice(2, -2));
            appendMeasured(ctx, inner, `<s>${inner.pango}</s>`);
        } else if (token.startsWith('\`')) {
            const inner = source.slice(1, -1);
            ctx.pango += `<tt>${escapePango(inner)}</tt>`;
            ctx.plain += inner;
        } else if (token.startsWith('[')) {
            const split = token.slice(1, -1).split('](');
            const label = split[0];
            const url = split.slice(1).join('](').trim();
            const inner = inlineMeasured(label);
            const base = utf8Length(ctx.plain);
            ctx.links.push(...inner.links.map(link =>
                ({...link, from: link.from + base, to: link.to + base})));
            ctx.pango += `<u>${inner.pango}</u>`;
            ctx.plain += inner.plain;
            if (safeUrl(url))
                ctx.links.push({from: base, to: utf8Length(ctx.plain), url});
        } else {
            const inner = inlineMeasured(token.slice(1, -1));
            appendMeasured(ctx, inner, `<i>${inner.pango}</i>`);
        }
        previous = match.index + token.length;
    }
    ctx.pango += escapePango(source.slice(previous));
    ctx.plain += source.slice(previous);
    ctx.pango += '</u>'.repeat(underline);
    return ctx;
}

function appendMeasured(ctx, inner, wrapped) {
    const base = utf8Length(ctx.plain);
    ctx.links.push(...inner.links.map(link =>
        ({...link, from: link.from + base, to: link.to + base})));
    ctx.pango += wrapped;
    ctx.plain += inner.plain;
}

// URLs we are willing to open or pass to the launcher. Everything else
// renders as inert text (no link span is reported).
export function safeUrl(url) {
    const trimmed = String(url ?? '').trim();
    if (!trimmed)
        return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
        if (/^(https?|mailto|file):/i.test(trimmed))
            return trimmed;
        return null;
    }
    // No scheme: a relative path or bare domain is treated as relative.
    return trimmed;
}

const CHECKBOX_LINE = /^(\s*)(?:-|\*|\+)\s+\[([xX ])\]/;
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const FENCE_MARKER = /^\s*```(\S*)\s*$/;

function imageLine(line) {
    const match = line.match(IMAGE_LINE);
    if (!match)
        return null;
    return {alt: match[1], src: match[2]};
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

// Shared table layout: per-column widths and padded cells. Both the Pango
// markup and the plain text derive from this so they never disagree.
function tableMatrix(table) {
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
    const aligns = table.aligns;
    return {matrix, widths, aligns, padCell};
}

function tableBorder(widths, left, junctions, right, position) {
    return `${left}${widths.map(width => '─'.repeat(width + 2)).join(junctions[position])}${right}`;
}

function renderTable(table) {
    const {matrix, widths, aligns, padCell} = tableMatrix(table);
    // Pango tags are invisible, so cells are laid out by display width of
    // their marker-free text and the markup is emitted around that padding.
    const renderRow = (cells, bold) => '│ ' + cells.map((cell, column) => {
        const align = aligns[column] ?? 'left';
        const rendered = inlineMeasured(padCell(cell, widths[column], align)).pango;
        return bold ? `<b>${rendered}</b>` : rendered;
    }).join(' │ ') + ' │';
    const junctions = ['┬', '┼', '┴'];
    const lines = [
        `<tt>${escapePango(tableBorder(widths, '┌', junctions, '┐', 0))}</tt>`,
        `<tt>${renderRow(matrix[0], true)}</tt>`,
        `<tt>${escapePango(tableBorder(widths, '├', junctions, '┤', 1))}</tt>`,
    ];
    for (let row = 1; row < matrix.length; row++)
        lines.push(`<tt>${renderRow(matrix[row], false)}</tt>`);
    lines.push(`<tt>${escapePango(tableBorder(widths, '└', junctions, '┘', 2))}</tt>`);
    return lines.join('\n');
}

function renderTablePlain(table) {
    const {matrix, widths, aligns, padCell} = tableMatrix(table);
    const renderRow = cells => '│ ' + cells.map((cell, column) =>
        padCell(stripInline(cell), widths[column], aligns[column] ?? 'left')).join(' │ ') + ' │';
    const junctions = ['┬', '┼', '┴'];
    const lines = [
        tableBorder(widths, '┌', junctions, '┐', 0),
        renderRow(matrix[0]),
        tableBorder(widths, '├', junctions, '┤', 1),
    ];
    for (let row = 1; row < matrix.length; row++)
        lines.push(renderRow(matrix[row]));
    lines.push(tableBorder(widths, '└', junctions, '┘', 2));
    return lines.join('\n');
}

function renderTextRow(line, index) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
        const size = heading[1].length <= 2 ? 'x-large' : 'large';
        const inner = inlineMeasured(heading[2]);
        return {kind: 'text', pango: `<span weight="bold" size="${size}">${inner.pango}</span>`,
            plain: inner.plain, links: inner.links, source: index};
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line))
        return {kind: 'text', pango: '────────────────', plain: '────────────────', source: index};
    const box = line.match(/^(\s*)(?:-|\*|\+)\s+\[([xX ])\]\s+(.*)$/);
    if (box) {
        const prefix = `${escapePango(box[1])}${box[2] === ' ' ? '☐' : '☑'}  `;
        const plainPrefix = `${box[1]}${box[2] === ' ' ? '☐' : '☑'}  `;
        const inner = inlineMeasured(box[3]);
        return {kind: 'text', pango: prefix + inner.pango, plain: plainPrefix + inner.plain,
            links: shiftLinks(inner.links, utf8Length(plainPrefix)),
            box: true, source: index};
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
        const prefix = `${escapePango(bullet[1])}•  `;
        const plainPrefix = `${bullet[1]}•  `;
        const inner = inlineMeasured(bullet[2]);
        return {kind: 'text', pango: prefix + inner.pango, plain: plainPrefix + inner.plain,
            links: shiftLinks(inner.links, utf8Length(plainPrefix)), source: index};
    }
    const ordered = line.match(/^(\s*)(\d{1,9})\.\s+(.*)$/);
    if (ordered) {
        const prefix = `${escapePango(ordered[1])}${ordered[2]}.  `;
        const plainPrefix = `${ordered[1]}${ordered[2]}.  `;
        const inner = inlineMeasured(ordered[3]);
        return {kind: 'text', pango: prefix + inner.pango, plain: plainPrefix + inner.plain,
            links: shiftLinks(inner.links, utf8Length(plainPrefix)), source: index};
    }
    const inner = inlineMeasured(line);
    return {kind: 'text', pango: inner.pango, plain: inner.plain, links: inner.links, source: index};
}

function shiftLinks(links, by) {
    if (!by)
        return links;
    return links.map(link => ({...link, from: link.from + by, to: link.to + by}));
}

function makeFenceRow(fence) {
    const lang = fence.info.toLowerCase();
    if (lang === 'dot' || lang === 'graphviz' || lang === 'graph')
        return {kind: 'diagram', lang: 'dot', code: fence.lines.join('\n'), source: fence.source};
    if (lang === 'mermaid')
        return {kind: 'diagram', lang: 'mermaid', code: fence.lines.join('\n'), source: fence.source};
    return {kind: 'block', pango: fence.lines.map(l => `<tt>${escapePango(l)}</tt>`).join('\n'),
        plain: fence.lines.join('\n'), source: fence.source};
}

export function renderRows(source) {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const rows = [];
    let fence = null;
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        const marker = FENCE_MARKER.exec(line);
        if (marker) {
            if (fence) {
                rows.push(makeFenceRow(fence));
                fence = null;
            } else {
                fence = {info: marker[1] ?? '', lines: [], source: index};
            }
            index += 1;
            continue;
        }
        if (fence) {
            fence.lines.push(line);
            index += 1;
            continue;
        }
        const image = imageLine(line);
        if (image) {
            rows.push({kind: 'image', ...image, source: index});
            index += 1;
            continue;
        }
        const table = tableAt(lines, index);
        if (table) {
            rows.push({kind: 'block', pango: renderTable(table),
                plain: renderTablePlain(table), source: index});
            index = table.end;
            continue;
        }
        rows.push(renderTextRow(line, index));
        index += 1;
    }
    if (fence)
        rows.push(makeFenceRow(fence));
    return rows;
}

function rowMarkup(row) {
    switch (row.kind) {
        case 'text':
        case 'block':
            return row.pango;
        case 'image':
            return escapePango(`![${row.alt}](${row.src})`);
        case 'diagram':
            return row.code.split('\n').map(line => `<tt>${escapePango(line)}</tt>`).join('\n');
        default:
            return '';
    }
}

// Full multi-line markup, joined with newlines. Kept for tests and as a
// last-resort fallback when actors cannot be built.
export function renderMarkdown(source) {
    const rows = renderRows(source);
    return {markup: rows.map(rowMarkup).join('\n'), rows};
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

// One row per source line. Clicking a row toggles its task; no links or
// other hit targets exist here.
export function renderTodo(source, today = toDateString(new Date())) {
    const rows = [];
    let index = 0;
    for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
        const pango = renderTodoLine(line, today);
        rows.push({kind: 'text', pango, plain: stripTags(pango), todo: true, source: index});
        index += 1;
    }
    return {rows, markup: rows.map(row => row.pango).join('\n')};
}
