import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseDocument, parseRawDocument, writeDocument} from './document.js';

// Disk is authoritative. A monitor updates the live UI, and all extension
// writes go through the same snapshots to avoid its own monitor feedback.

// Resolve user input against the home directory: '~/x' and bare relative
// paths go through the home directory, absolute paths pass through.
export function expandNotePath(path) {
    if (typeof path !== 'string')
        return null;
    const trimmed = path.trim();
    if (!trimmed)
        return null;
    if (trimmed === '~')
        return GLib.get_home_dir();
    if (trimmed.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), trimmed.slice(2)]);
    return GLib.path_is_absolute(trimmed)
        ? trimmed
        : GLib.build_filenamev([GLib.get_home_dir(), trimmed]);
}

export class NoteFiles {
    // Markdown directory scan (default) or a single raw file
    // ({file: '/path/to/todo.txt'}): one plain-text file watched on its own,
    // saved byte-for-byte, with no frontmatter involved.
    constructor(onChange, onDelete, target = null) {
        this._raw = false;
        this._rawFile = null;
        this._rawName = null;
        if (target && typeof target === 'object' && typeof target.file === 'string') {
            const expanded = expandNotePath(target.file);
            if (expanded) {
                this._raw = true;
                this._rawFile = expanded;
                this._rawName = GLib.path_get_basename(expanded);
                this.directory = GLib.path_get_dirname(expanded);
            } else {
                console.error(`Sticky Notes: empty TODO file path, falling back to ${GLib.get_home_dir()}/notes`);
                this.directory = GLib.build_filenamev([GLib.get_home_dir(), 'notes']);
            }
        } else if (typeof target === 'string' && target) {
            this.directory = target;
        } else {
            this.directory = GLib.build_filenamev([GLib.get_home_dir(), 'notes']);
        }
        this._onChange = onChange;
        this._onDelete = onDelete;
        this._known = new Map();
        // Tombstones stop stale UI writes from resurrecting externally deleted notes.
        this._deleted = new Set();
        this._monitor = null;
        this._monitorId = 0;
        this._scanId = 0;
    }
    start() {
        if (!this._raw)
            GLib.mkdir_with_parents(this.directory, 0o755);
        const watched = this._raw ? this._rawFile : this.directory;
        try {
            const file = Gio.File.new_for_path(watched);
            this._monitor = this._raw
                ? file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null)
                : file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitorId = this._monitor.connect('changed', (_watch, file, otherFile) => {
                if (this._raw)
                    this.queueScan();
                else if (this._isNote(file?.get_basename()) || this._isNote(otherFile?.get_basename()))
                    this.queueScan();
            });
        } catch (error) {
            console.error(`Sticky Notes: cannot monitor ${watched}: ${error}`);
        }
        // Start watching before the initial enumeration, closing the gap
        // where an external editor could write a file during startup.
        this.scan();
    }
    stop() {
        if (this._scanId) {
            GLib.Source.remove(this._scanId);
            this._scanId = 0;
        }
        if (this._monitor) {
            if (this._monitorId)
                this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
            this._monitorId = 0;
        }
    }
    _isNote(name) {
        return typeof name === 'string' &&
            !name.includes('/') && !name.includes('\\') &&
            /\.(md|markdown)$/i.test(name);
    }
    _file(name) {
        if (!this._isNote(name))
            throw new Error('Invalid Markdown note filename');
        return Gio.File.new_for_path(GLib.build_filenamev([this.directory, name]));
    }
    _watchFile(name) {
        if (this._raw) {
            if (name !== this._rawName)
                throw new Error('Invalid TODO filename');
            return Gio.File.new_for_path(this._rawFile);
        }
        return this._file(name);
    }
    newFilename() {
        if (this._raw)
            return this._rawName;
        // A timestamp is the stable identity in the filename; note IDs remain
        // private frontmatter metadata and never leak into the pathname.
        const stamp = GLib.get_real_time();
        let name = `note-${stamp}.md`;
        let n = 0;
        while (this._known.has(name) || this._file(name).query_exists(null))
            name = `note-${stamp}-${++n}.md`;
        return name;
    }
    queueScan() {
        if (this._scanId)
            GLib.Source.remove(this._scanId);
        this._scanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._scanId = 0;
            this.scan();
            return GLib.SOURCE_REMOVE;
        });
    }
    scan() {
        const present = new Set();
        if (this._raw) {
            try {
                const info = Gio.File.new_for_path(this._rawFile).query_info(
                    'standard::type', Gio.FileQueryInfoFlags.NONE, null);
                if (info?.get_file_type() === Gio.FileType.REGULAR)
                    present.add(this._rawName);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    console.error(`Sticky Notes: could not stat ${this._rawFile}: ${error}`);
                    return; // A transient error must never delete the UI's notes.
                }
            }
        } else {
            let iterator;
            try {
                iterator = Gio.File.new_for_path(this.directory).enumerate_children(
                    'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = iterator.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (info.get_file_type() === Gio.FileType.REGULAR && this._isNote(name))
                        present.add(name);
                }
            } catch (error) {
                console.error(`Sticky Notes: could not scan ${this.directory}: ${error}`);
                return; // A transient error must never delete the UI's notes.
            } finally {
                iterator?.close(null);
            }
        }
        // Drop removed files first so a rename can safely preserve a note ID.
        for (const name of [...this._known.keys()]) {
            if (!present.has(name)) {
                this._known.delete(name);
                this._deleted.add(name);
                this._onDelete(name);
            }
        }
        for (const name of [...present].sort((a, b) => a.localeCompare(b))) {
            let document;
            try {
                document = this._read(name);
            } catch (error) {
                // Atomic replacements can briefly make a file unavailable.
                console.warn(`Sticky Notes: could not read ${name}: ${error}`);
                continue;
            }
            if (this._known.get(name) === document) {
                this._deleted.delete(name);
                continue;
            }
            this._deleted.delete(name);
            this._known.set(name, document);
            this._onChange(name, this._parse(document));
        }
    }
    _read(name) {
        const [, bytes] = this._watchFile(name).load_contents(null);
        return new TextDecoder().decode(bytes);
    }
    _parse(content) {
        return this._raw ? parseRawDocument(content) : parseDocument(content);
    }
    save(note) {
        const name = note.filename;
        if (this._raw) {
            if (name !== this._rawName)
                return false;
            const file = this._watchFile(name);
            if (this._deleted.has(name)) {
                // An external delete (or rename) takes precedence over pending
                // edits. A recreated file is picked up by the monitor.
                this.queueScan();
                return false;
            }
            const previous = this._known.get(name);
            // Someone removed/modified the file before the file watcher fired:
            // the filesystem wins, and must not be silently overwritten.
            if (previous !== undefined) {
                try {
                    if (this._read(name) !== previous) {
                        this.queueScan();
                        return false;
                    }
                } catch (error) {
                    this.queueScan();
                    return false;
                }
            } else if (file.query_exists(null)) {
                this.queueScan();
                return false;
            }
            const text = note.rawText ?? '';
            if (text === previous)
                return true;
            try {
                file.replace_contents(new TextEncoder().encode(text), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                this._known.set(name, text);
                return true;
            } catch (error) {
                console.error(`Sticky Notes: could not save ${name}: ${error}`);
                return false;
            }
        }
        const file = this._file(name);
        if (this._deleted.has(name)) {
            // An external delete (or rename) takes precedence over pending
            // edits. A new note must always use a fresh filename.
            this.queueScan();
            return false;
        }
        const previous = this._known.get(name);
        // Someone removed/modified the file before the file watcher fired:
        // the filesystem wins, and must not be silently overwritten.
        if (previous !== undefined) {
            try {
                const [, bytes] = file.load_contents(null);
                if (new TextDecoder().decode(bytes) !== previous) {
                    this.queueScan();
                    return false;
                }
            } catch (error) {
                this.queueScan();
                return false;
            }
        } else if (file.query_exists(null)) {
            this.queueScan();
            return false;
        }
        const document = writeDocument(note, previous ?? '');
        if (document === previous)
            return true;
        try {
            file.replace_contents(new TextEncoder().encode(document), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            this._known.set(name, document);
            return true;
        } catch (error) {
            console.error(`Sticky Notes: could not save ${name}: ${error}`);
            return false;
        }
    }
    remove(name) {
        try {
            this._watchFile(name).delete(null);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                console.error(`Sticky Notes: could not delete ${name}: ${error}`);
                return false;
            }
        }
        this._known.delete(name);
        this._deleted.add(name);
        return true;
    }
}
