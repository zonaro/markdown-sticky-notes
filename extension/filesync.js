import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseDocument, parseRawDocument, writeDocument} from './document.js';

// Disk is authoritative. A monitor updates the live UI, and all extension
// writes go through the same snapshots to avoid its own monitor feedback.
//
// Notes are identified by the path RELATIVE to the notes root (e.g.
// 'projects/2026/idea.md'), not by basename — boards make folders
// significant. The internal note.filename property carries the relpath.

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

// Normalize an internal relpath: forward slashes, no dot segments, no
// absolute paths, no backslashes. Returns null when invalid.
export function normalizeRelpath(path) {
    if (typeof path !== 'string')
        return null;
    const trimmed = path.trim().replace(/\\/g, '/');
    if (!trimmed || trimmed.startsWith('/'))
        return null;
    const segments = [];
    for (const segment of trimmed.split('/')) {
        if (!segment || segment === '.' || segment === '..')
            return null;
        segments.push(segment);
    }
    return segments.join('/');
}

export function isBoardFilePath(relpath) {
    return !!relpath && GLib.path_get_basename(relpath).toLowerCase() === '.board.md';
}

export function isNoteRelpath(relpath) {
    const normalized = normalizeRelpath(relpath);
    return !!normalized
        && /\.(md|markdown|txt)$/i.test(normalized)
        && !isBoardFilePath(normalized);
}

export class NoteFiles {
    // Markdown directory scan, recursive since the boards support (default),
    // or a single raw file ({file: '/path/to/todo.txt'}) watched on its own.
    // onBoards(presentBoards) fires with a Map(dirRel -> {raw, document})
    // after every scan that can see the root; .board.md files never become
    // notes.
    constructor(onChange, onDelete, target = null, onBoards = null) {
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
        this._onBoards = typeof onBoards === 'function' ? onBoards : null;
        this._known = new Map();
        // Tombstones stop stale UI writes from resurrecting externally deleted notes.
        this._deleted = new Set();
        this._knownBoards = new Map();
        this._monitors = new Map();
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
                else if (this._isWatchedRelpath(file?.get_path()) || this._isWatchedRelpath(otherFile?.get_path()))
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
        for (const [dirRel, entry] of this._monitors) {
            if (entry.id)
                entry.monitor.disconnect(entry.id);
            entry.monitor.cancel();
        }
        this._monitors.clear();
    }
    // Any change under the root re-triggers the scan: the diff is
    // authoritative, so false positives only cost one scan.
    _isWatchedRelpath(path) {
        if (!path)
            return false;
        const root = GLib.canonicalize_filename(this.directory, null);
        const canon = GLib.canonicalize_filename(path, null);
        return canon === root || canon.startsWith(`${root}/`);
    }
    _file(name) {
        const rel = normalizeRelpath(name);
        if (!rel || !isNoteRelpath(rel))
            throw new Error('Invalid Markdown note filename');
        return Gio.File.new_for_path(GLib.build_filenamev([this.directory, rel]));
    }
    _boardFile(dirRel) {
        const rel = normalizeRelpath(dirRel ? `${dirRel}/.board.md` : '.board.md');
        if (!rel)
            throw new Error('Invalid board path');
        return Gio.File.new_for_path(GLib.build_filenamev([this.directory, rel]));
    }
    boardRelpath(dirRel) {
        const rel = normalizeRelpath(dirRel ? `${dirRel}/.board.md` : '.board.md');
        if (!rel)
            throw new Error('Invalid board path');
        return rel;
    }
    _watchFile(name) {
        if (this._raw) {
            if (name !== this._rawName)
                throw new Error('Invalid TODO filename');
            return Gio.File.new_for_path(this._rawFile);
        }
        const rel = normalizeRelpath(name);
        if (!rel)
            throw new Error('Invalid note path');
        return Gio.File.new_for_path(GLib.build_filenamev([this.directory, rel]));
    }
    newFilename(prefix = '') {
        if (this._raw)
            return this._rawName;
        const base = prefix && prefix.endsWith('/') ? prefix : (prefix ? `${prefix}/` : '');
        const stamp = GLib.get_real_time();
        let name = `${base}note-${stamp}.md`;
        let n = 0;
        while (this._known.has(name) || this._file(name).query_exists(null))
            name = `${base}note-${stamp}-${++n}.md`;
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
    // Recursively collect note relpaths and board dirs under root.
    _walk() {
        const notes = new Set();
        const boards = new Map();
        const dirs = new Set(['']);
        const pending = [''];
        while (pending.length) {
            const relDir = pending.pop();
            const dirPath = relDir
                ? GLib.build_filenamev([this.directory, relDir])
                : this.directory;
            let iterator;
            try {
                iterator = Gio.File.new_for_path(dirPath).enumerate_children(
                    'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = iterator.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (name.startsWith('.') && name.toLowerCase() !== '.board.md')
                        continue; // Hidden files and directories stay out.
                    const childRel = relDir ? `${relDir}/${name}` : name;
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        dirs.add(childRel);
                        if (!pending.includes(childRel))
                            pending.push(childRel);
                        continue;
                    }
                    if (info.get_file_type() !== Gio.FileType.REGULAR)
                        continue;
                    const normalized = normalizeRelpath(childRel);
                    if (!normalized)
                        continue;
                    if (isBoardFilePath(normalized)) {
                        // Boards live in folders; a root-level .board.md is
                        // inert (never a note, never a board).
                        if (relDir)
                            boards.set(relDir, normalized);
                        else
                            console.warn('Sticky Notes: .board.md at the notes root is ignored; boards live in folders');
                    } else if (isNoteRelpath(normalized))
                        notes.add(normalized);
                }
            } catch (error) {
                console.error(`Sticky Notes: could not scan ${dirPath}: ${error}`);
                // A transient error must never delete the UI's notes.
                return null;
            } finally {
                iterator?.close(null);
            }
        }
        return {notes, boards, dirs};
    }
    _updateMonitors(dirs) {
        if (this._raw)
            return;
        for (const [dirRel, entry] of [...this._monitors]) {
            if (dirs.has(dirRel))
                continue;
            if (entry.id)
                entry.monitor.disconnect(entry.id);
            entry.monitor.cancel();
            this._monitors.delete(dirRel);
        }
        for (const dirRel of dirs) {
            if (this._monitors.has(dirRel))
                continue;
            const dirPath = dirRel
                ? GLib.build_filenamev([this.directory, dirRel])
                : this.directory;
            try {
                const file = Gio.File.new_for_path(dirPath);
                const monitor = file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
                const id = monitor.connect('changed', () => this.queueScan());
                this._monitors.set(dirRel, {monitor, id});
            } catch (error) {
                console.error(`Sticky Notes: cannot monitor ${dirPath}: ${error}`);
            }
        }
    }
    _readPath(path) {
        const [, bytes] = path.load_contents(null);
        return new TextDecoder().decode(bytes);
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
            const walk = this._walk();
            if (!walk)
                return; // A transient error must never delete the UI's notes.
            for (const rel of walk.notes)
                present.add(rel);
            this._updateMonitors(walk.dirs);
            this._scanBoards(walk.boards);
        }
        // Drop removed files first so a rename can safely preserve a note ID.
        for (const name of [...this._known.keys()]) {
            if (!present.has(name)) {
                this._known.delete(name);
                this._deleted.add(name);
                try {
                    this._onDelete(name);
                } catch (error) {
                    // One bad file must not stop the remaining files from syncing.
                    console.error(`Sticky Notes: could not remove ${name}: ${error}`);
                }
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
            try {
                this._onChange(name, this._parse(document));
            } catch (error) {
                // Keep the note tracked as known so a pathological file is not
                // re-read forever; the sync of the remaining files continues.
                console.error(`Sticky Notes: could not load ${name}: ${error}`);
            }
        }
    }
    // Present boards (dirs holding a .board.md) arrive as Map(dirRel -> relpath).
    _scanBoards(found) {
        if (!this._onBoards)
            return;
        const present = new Map();
        for (const [dirRel, relpath] of found) {
            try {
                const raw = this._readPath(this._boardFile(dirRel));
                present.set(dirRel, {raw, document: parseDocument(raw), relpath});
            } catch (error) {
                console.warn(`Sticky Notes: could not read board ${relpath}: ${error}`);
            }
        }
        for (const dirRel of [...this._knownBoards.keys()])
            if (!present.has(dirRel))
                this._knownBoards.delete(dirRel);
        for (const [dirRel, entry] of present) {
            const previous = this._knownBoards.get(dirRel);
            if (previous === entry.raw)
                continue;
            this._knownBoards.set(dirRel, entry.raw);
        }
        this._onBoards(present);
    }
    // Recursively delete a folder inside the notes root (boards). Refuses
    // anything that does not stay under the root.
    removeFolder(dirRel) {
        const rel = normalizeRelpath(dirRel);
        if (!rel)
            return false;
        const dir = Gio.File.new_for_path(GLib.build_filenamev([this.directory, rel]));
        try {
            this._deleteTree(dir);
        } catch (error) {
            console.error(`Sticky Notes: could not delete ${rel}: ${error}`);
            return false;
        }
        return true;
    }
    _deleteTree(file) {
        if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY) {
            const child = file.enumerate_children(
                'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            try {
                let info;
                while ((info = child.next_file(null)) !== null)
                    this._deleteTree(file.get_child(info.get_name()));
            } finally {
                child.close(null);
            }
        }
        file.delete(null);
    }
    removeBoard(dirRel) {
        const rel = this.boardRelpath(dirRel);
        const file = this._boardFile(dirRel);
        try {
            file.delete(null);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                console.error(`Sticky Notes: could not delete board ${rel}: ${error}`);
                return false;
            }
        }
        this._knownBoards.delete(dirRel);
        this.queueScan();
        return true;
    }
    saveBoard(dirRel, rawText) {
        const relpath = this.boardRelpath(dirRel);
        const file = this._boardFile(dirRel);
        const previous = this._knownBoards.get(dirRel);
        if (previous !== undefined) {
            try {
                if (this._readPath(file) !== previous) {
                    this.queueScan();
                    return false; // Filesystem wins over a pending board write.
                }
            } catch (error) {
                this.queueScan();
                return false;
            }
        } else if (file.query_exists(null)) {
            this.queueScan();
            return false;
        }
        if (rawText === previous)
            return true;
        const parent = normalizeRelpath(GLib.path_get_dirname(relpath) === '.' ? null : GLib.path_get_dirname(relpath));
        if (parent)
            GLib.mkdir_with_parents(GLib.build_filenamev([this.directory, parent]), 0o755);
        try {
            file.replace_contents(new TextEncoder().encode(rawText), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            this._knownBoards.set(dirRel, rawText);
            return true;
        } catch (error) {
            console.error(`Sticky Notes: could not save board ${relpath}: ${error}`);
            return false;
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
        const rel = normalizeRelpath(name);
        const parent = rel && rel.includes('/') ? GLib.path_get_dirname(rel) : null;
        if (parent)
            GLib.mkdir_with_parents(GLib.build_filenamev([this.directory, parent]), 0o755);
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
