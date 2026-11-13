// Note documents and placement. No Shell or GI imports, so the rules can be
// checked outside a session. Note text and layout live in Markdown frontmatter.

import {lineMark} from './format.js';

export const PALETTE = [
    'sand', 'blossom', 'mint', 'sky', 'lilac', 'peach', 'lemon', 'cream',
    'apricot', 'coral', 'rose', 'mauve', 'iris', 'mist', 'sage', 'aqua',
];

export const COLOR_LABELS = {
    sand: 'Sand',
    blossom: 'Blossom',
    mint: 'Mint',
    sky: 'Sky',
    lilac: 'Lilac',
    peach: 'Peach',
    lemon: 'Lemon',
    cream: 'Cream',
    apricot: 'Apricot',
    coral: 'Coral',
    rose: 'Rose',
    mauve: 'Mauve',
    iris: 'Iris',
    mist: 'Mist',
    sage: 'Sage',
    aqua: 'Aqua',
};

// Hue order for the swatch grid. Values are palette indexes, so a note
// saved before the extra colors keeps the swatch it already used.
export const SWATCH_ORDER = [0, 6, 7, 5, 8, 9, 1, 10, 11, 4, 12, 3, 13, 2, 14, 15];

export const MIN_W = 168;
export const MIN_H = 112;
export const NOTE_GAP = 16;

export const WELCOME_TEXT = [
    'Drag the top edge to move.',
    'Drag the corner to resize.',
    'Right-click to pick a color.',
    'Click the text for bold, italic, and lists.',
    '',
    'The note icon on the top bar opens the note menu.',
    '',
    'Ctrl+Super+N    new note',
    'Ctrl+Super+H    hide notes',
    '',
].join('\n');

export function emptyStore() {
    return {hidden: false, next_id: 1, notes: []};
}

// Fixed identity of the TODO note. It is not parsed from frontmatter; the
// raw todo.txt file and GSettings own its state.
export const TODO_ID = -1;

export function normalizeSize(size) {
    const value = Number(size);
    if (value === 0)
        return 11;
    if (value === 1)
        return 13;
    if (value === 2)
        return 16;
    if (Number.isInteger(value) && value >= 11 && value <= 16)
        return value;
    return 13;
}

// Normalize a user-supplied hex color: '#rgb' becomes '#rrggbb'; returns null
// when invalid.
export function normalizeHexColor(value) {
    if (typeof value !== 'string')
        return null;
    let hex = value.trim().toLowerCase();
    if (!hex.startsWith('#'))
        hex = `#${hex}`;
    if (/^#[0-9a-f]{3}$/.test(hex)) {
        const [r, g, b] = hex.slice(1);
        hex = `#${r}${r}${g}${g}${b}${b}`;
    }
    return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

// Relative luminance check; true when light text should be used.
export function hexIsDark(hex) {
    const value = normalizeHexColor(hex);
    if (!value)
        return false;
    const [r, g, b] = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}

// Parse an expiration timestamp: 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM'/'T'.
// Local time, no timezone. Returns null on any invalid input (including
// impossible dates such as February 31st).
export function parseExpires(value) {
    if (typeof value !== 'string')
        return null;
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?(?::(\d{2}))?$/);
    if (!match)
        return null;
    const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = match;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(hh);
    const minute = Number(mm);
    const second = Number(ss);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
        return null;
    const date = new Date(year, month - 1, day, hour, minute, second);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
        || date.getHours() !== hour || date.getMinutes() !== minute)
        return null;
    return date;
}

// Human-readable expiration for UI and frontmatter suggestions.
export function formatExpires(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Frontmatter-friendly timestamp (compact, no seconds when not needed).
export function expiresToFrontmatter(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T`
        + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Zoom percentage of a note or board: 5 to 200, default 100. Everything
// in the view scales by this factor, not just the font.
export function normalizeZoom(zoom) {
    if (zoom === null || zoom === undefined)
        return 100;
    const value = Number(zoom);
    if (!Number.isFinite(value))
        return 100;
    return Math.min(200, Math.max(5, Math.round(value)));
}

// Display font size in points for a zoom factor.
export function zoomFont(zoom, base = 13) {
    return Math.max(6, Math.round(base * normalizeZoom(zoom) / 100));
}

function clampInt(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function clamp(x, y, w, h, areas, minW, minH, maxW, maxH) {
    maxW = Math.max(maxW, minW);
    maxH = Math.max(maxH, minH);
    w = clampInt(w, minW, maxW);
    h = clampInt(h, minH, maxH);
    if (!areas.length)
        return [x, y, w, h];

    const cx = x + Math.trunc(w / 2);
    const cy = y + Math.trunc(h / 2);
    let best = areas[0];
    let bestD = Infinity;
    let inside = null;
    for (const area of areas) {
        if (cx >= area.x && cx < area.x + area.w && cy >= area.y && cy < area.y + area.h) {
            inside = area;
            break;
        }
        const dx = cx - (area.x + Math.trunc(area.w / 2));
        const dy = cy - (area.y + Math.trunc(area.h / 2));
        const d = dx * dx + dy * dy;
        if (d < bestD) {
            bestD = d;
            best = area;
        }
    }
    const area = inside ?? best;
    const margin = 8;
    w = Math.min(w, Math.max(area.w - margin * 2, minW));
    h = Math.min(h, Math.max(area.h - margin * 2, minH));
    const minX = area.x + margin;
    const minY = area.y + margin;
    const maxX = Math.max(area.x + area.w - margin - w, minX);
    const maxY = Math.max(area.y + area.h - margin - h, minY);
    return [clampInt(x, minX, maxX), clampInt(y, minY, maxY), w, h];
}

export function overlaps(x, y, w, h, gap, obstacles) {
    return obstacles.some(([ox, oy, ow, oh]) =>
        x < ox + ow + gap &&
        x + w + gap > ox &&
        y < oy + oh + gap &&
        y + h + gap > oy);
}

export function freeOrigin(obstacles, areas, w, h, prefer) {
    const gap = NOTE_GAP;
    const step = 24;
    const ordered = areas.length
        ? areas.map(area => ({...area}))
        : [{x: 48, y: 48, w: 1280, h: 800}];
    if (prefer) {
        const [px, py] = prefer;
        const index = ordered.findIndex(area =>
            px >= area.x && px < area.x + area.w && py >= area.y && py < area.y + area.h);
        if (index > 0) {
            const [preferred] = ordered.splice(index, 1);
            ordered.unshift(preferred);
        }
    }
    if (!obstacles.length && !prefer) {
        const area = ordered[0];
        return [
            area.x + Math.trunc((area.w - w) / 2),
            area.y + Math.trunc((area.h - h) / 2),
        ];
    }
    const [px, py] = prefer ?? [ordered[0].x + 8, ordered[0].y + 8];
    let best = null;
    for (const area of ordered) {
        const margin = 8;
        const minX = area.x + margin;
        const minY = area.y + margin;
        const maxX = Math.max(area.x + area.w - margin - w, minX);
        const maxY = Math.max(area.y + area.h - margin - h, minY);
        for (let y = minY; y <= maxY; y += step) {
            for (let x = minX; x <= maxX; x += step) {
                if (overlaps(x, y, w, h, gap, obstacles))
                    continue;
                const dx = x - px;
                const dy = y - py;
                const d = dx * dx + dy * dy;
                if (!best || d < best[2])
                    best = [x, y, d];
            }
        }
    }
    return best ? [best[0], best[1]] : [px, py];
}

export function freshOrigin(obstacles, areas, w, h, at, prefer) {
    if (at) {
        const origin = [at[0] - 20, at[1] - 10];
        if (!overlaps(origin[0], origin[1], w, h, NOTE_GAP, obstacles))
            return origin;
    }
    return freeOrigin(obstacles, areas, w, h, at ?? prefer);
}
