// File-format classification shared by filesystem sync, rendering and tests.
// Keep this module free of GNOME imports.

const EXTENSIONS = new Map([
    ['md', 'markdown'],
    ['markdown', 'markdown'],
    ['txt', 'text'],
    ['html', 'html'],
    ['htm', 'html'],
    ['png', 'image'],
    ['jpg', 'image'],
    ['jpeg', 'image'],
]);

export function noteFormatForFilename(filename) {
    if (typeof filename !== 'string')
        return null;
    const match = filename.toLowerCase().match(/\.([^.\/]+)$/);
    return match ? EXTENSIONS.get(match[1]) ?? null : null;
}

export function isNoteFilename(filename) {
    return noteFormatForFilename(filename) !== null;
}

export function isTextNoteFormat(format) {
    return format === 'markdown' || format === 'text' || format === 'html';
}

export function isImageNoteFormat(format) {
    return format === 'image';
}
