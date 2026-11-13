// Markdown is the source of truth. Only gnome-sticky-* keys belong to this
// extension; unrelated YAML frontmatter lines are preserved on save.
// No GNOME imports: parsing can be tested with Node.js.
const FIELDS = {
    id: 'gnome-sticky-id',
    x: 'gnome-sticky-x',
    y: 'gnome-sticky-y',
    w: 'gnome-sticky-width',
    h: 'gnome-sticky-height',
    expanded_h: 'gnome-sticky-expanded-height',
    color: 'gnome-sticky-color',
    size: 'gnome-sticky-font-size',
    workspace: 'gnome-sticky-workspace',
    pinned: 'gnome-sticky-pinned',
    locked: 'gnome-sticky-locked',
    spans: 'gnome-sticky-spans',
    sizes: 'gnome-sticky-sizes',
    zoom: 'gnome-sticky-zoom',
    collapsed: 'gnome-sticky-collapsed',
    custom_color: 'gnome-sticky-color-custom',
    expires: 'gnome-sticky-expires',
};
const OWNED = new Set(Object.values(FIELDS));
const ALIASES = {
    x: 'gnome-notes-x',
    y: 'gnome-notes-y',
    w: 'gnome-notes-width',
    h: 'gnome-notes-height',
    size: 'gnome-notes-font-size',
};

function decode(value) {
    try {
        return JSON.parse(value);
    } catch {
        return value.replace(/^"(.*)"$/, '$1');
    }
}

// A raw document carries the text verbatim: no frontmatter, no metadata.
// Used for the todo.txt file, which must stay byte-compatible with other
// todo.txt tools.
export function parseRawDocument(source) {
    return {body: source, metadata: {}, header: [], hasFrontmatter: false, raw: true};
}

export function parseDocument(source) {
    let body = source;
    let header = [];
    let hasFrontmatter = false;
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (match) {
        const lines = match[1].split(/\r?\n/);
        if (lines.some(line => /^\s*[\w-]+\s*:/.test(line))) {
            header = lines;
            body = source.slice(match[0].length);
            hasFrontmatter = true;
        }
    }
    const raw = new Map();
    for (const line of header) {
        const entry = line.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
        if (entry)
            raw.set(entry[1], entry[2]);
    }
    const metadata = {};
    for (const [property, key] of Object.entries(FIELDS)) {
        const value = raw.get(key) ?? (ALIASES[property] ? raw.get(ALIASES[property]) : undefined);
        if (value === undefined)
            continue;
        const parsed = decode(value);
        if (property === 'pinned' || property === 'locked' || property === 'collapsed') {
            if (typeof parsed === 'boolean')
                metadata[property] = parsed;
        } else if (property === 'spans' || property === 'sizes') {
            if (Array.isArray(parsed))
                metadata[property] = parsed;
        } else if (property === 'custom_color' || property === 'expires') {
            if (typeof parsed === 'string')
                metadata[property] = parsed;
        } else if (Number.isInteger(parsed)) {
            metadata[property] = parsed;
        }
    }
    return {body, metadata, header, hasFrontmatter};
}

export function writeDocument(note, previous = '') {
    const {header} = parseDocument(previous);
    const preserved = header.filter(line => {
        const match = line.match(/^\s*([\w-]+)\s*:/);
        return !match || !OWNED.has(match[1]);
    }).filter(line => line.trim());
    const own = Object.entries(FIELDS).map(([property, key]) => {
        const value = note[property];
        if (value === undefined || value === null)
            return null;
        // Collapsed only matters for boards; keep note frontmatter free of it.
        if (property === 'collapsed' && value === false)
            return null;
        return `${key}: ${JSON.stringify(value)}`;
    }).filter(Boolean);
    return `---\n${[...preserved, ...own].join('\n')}\n---\n${note.text ?? ''}`;
}
