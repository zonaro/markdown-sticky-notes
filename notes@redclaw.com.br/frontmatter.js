// Note metadata stored in YAML frontmatter, without a YAML runtime dependency.
// Only the extension's flat, namespaced keys are interpreted or updated.

const FIELDS = [
    ['x', 'gnome-notes-x'],
    ['y', 'gnome-notes-y'],
    ['width', 'gnome-notes-width'],
    ['height', 'gnome-notes-height'],
    ['color', 'gnome-notes-color'],
    ['fontSize', 'gnome-notes-font-size'],
    ['bodyVisible', 'gnome-notes-body-visible'],
];
const FIELD_NAMES = new Set(FIELDS.map(([, name]) => name));

export function parseNoteDocument(document) {
    let body = document;
    let header = [];
    let hasFrontmatter = false;
    const startsWithDelimiter = /^---(?:\r?\n|$)/.test(document);
    const match = document.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/);
    if (match) {
        const lines = (match[1] ?? '').split(/\r?\n/);
        // Avoid mistaking normal Markdown horizontal rules for frontmatter.
        if (match[1] === undefined || lines.some(line => /^\s*[\w-]+\s*:/.test(line))) {
            header = lines;
            body = document.slice(match[0].length);
            hasFrontmatter = true;
        }
    }

    const metadata = {};
    for (const [property, key] of FIELDS) {
        const line = header.find(row => row.startsWith(`${key}:`));
        if (!line)
            continue;
        const raw = line.slice(key.length + 1).trim().replace(/^"(.*)"$/, '$1');
        if (property === 'color') {
            if (/^\d{1,3},\d{1,3},\d{1,3}$/.test(raw))
                metadata.color = raw;
        } else if (property === 'bodyVisible') {
            if (raw === 'true' || raw === 'false')
                metadata.bodyVisible = raw === 'true';
        } else {
            const value = Number(raw);
            if (raw && Number.isFinite(value))
                metadata[property] = value;
        }
    }
    return {
        body, metadata, header, hasFrontmatter,
        malformedFrontmatter: startsWithDelimiter && !hasFrontmatter,
    };
}

export function writeNoteDocument(body, metadata, previousDocument = '') {
    const {header} = parseNoteDocument(previousDocument);
    const preserved = header.filter(line => {
        const match = line.match(/^([\w-]+)\s*:/);
        return !match || !FIELD_NAMES.has(match[1]);
    });
    const owned = FIELDS.map(([property, key]) => {
        const value = metadata[property];
        if (value === undefined || value === null)
            return null;
        return `${key}: ${property === 'color' ? `"${value}"` : String(value)}`;
    }).filter(Boolean);
    return `---\n${[...preserved.filter(line => line !== ''), ...owned].join('\n')}\n---\n${body}`;
}

