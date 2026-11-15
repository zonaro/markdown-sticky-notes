import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    parseDocument,
    parseNoteMetadata,
    parseRawDocument,
    writeDocument,
    writeNoteMetadata,
} from './document.js';
import {
    isImageNoteFormat,
    isNoteFilename,
    noteFormatForFilename,
} from './note-format.js';

// Disk is authoritative. A monitor updates the live UI, and all extension
// writes go through the same snapshots to avoid its own monitor feedback.
//
// Notes are identified by the path RELATIVE to the notes root (e.g.
// 'projects/2026/idea.md'), not by basename: the folder path is the note
// category. The internal note.filename property carries the relpath.

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

export function isNoteRelpath(relpath) {
    const normalized = normalizeRelpath(relpath);
    return !!normalized && isNoteFilename(normalized)
        && !normalized.split('/').some(part => part.startsWith('.'));
}

export function noteSidecarRelpath(relpath) {
    const normalized = normalizeRelpath(relpath);
    if (!normalized || !isNoteRelpath(normalized))
        return null;
    const dirname = normalized.includes('/') ? GLib.path_get_dirname(normalized) : '';
    const basename = GLib.path_get_basename(normalized);
    const sidecar = `.${basename}.sticky-note.json`;
    return dirname ? `${dirname}/${sidecar}` : sidecar;
}

export class NoteFiles {
    // Supported-note directory scan, recursive: every folder under the root is
    // a category. A single raw file target is reserved for todo.txt.
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
            throw new Error('Invalid note filename');
        return Gio.File.new_for_path(GLib.build_filenamev([this.directory, rel]));
    }
    _sidecarFile(name) {
        const rel = noteSidecarRelpath(name);
        if (!rel)
            throw new Error('Invalid note metadata path');
        return Gio.File.new_for_path(GLib.build_filenamev([this.directory, rel]));
    }
    _watchFile(name) {
        if (this._raw) {
            if (name !== this._rawName)
                throw new Error('Invalid TODO filename');
            return Gio.File.new_for_path(this._rawFile);
        }
        return this._file(name);
    }
    file(name) {
        return this._watchFile(name);
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
    // Recursively collect note relpaths and folders under root.
    _walk() {
        const notes = new Set();
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
                    if (name.startsWith('.'))
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
                    if (isNoteRelpath(normalized))
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
        return {notes, dirs};
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
            let entry;
            try {
                entry = this._readEntry(name);
            } catch (error) {
                // Atomic replacements can briefly make a file unavailable.
                console.warn(`Sticky Notes: could not read ${name}: ${error}`);
                continue;
            }
            if (this._known.get(name)?.snapshot === entry.snapshot) {
                this._deleted.delete(name);
                continue;
            }
            this._deleted.delete(name);
            this._known.set(name, entry);
            try {
                this._onChange(name, entry.document);
            } catch (error) {
                // Keep the note tracked as known so a pathological file is not
                // re-read forever; the sync of the remaining files continues.
                console.error(`Sticky Notes: could not load ${name}: ${error}`);
            }
        }
    }
    _read(name) {
        const [, bytes] = this._watchFile(name).load_contents(null);
        return new TextDecoder().decode(bytes);
    }
    _sidecar(name) {
        const file = this._sidecarFile(name);
        if (!file.query_exists(null))
            return {raw: '', metadata: {}, hasMetadata: false};
        const [, bytes] = file.load_contents(null);
        const raw = new TextDecoder().decode(bytes);
        return {raw, ...parseNoteMetadata(raw)};
    }
    _fingerprint(name) {
        const info = this._watchFile(name).query_info(
            'standard::size,time::modified,time::modified-usec,etag::value',
            Gio.FileQueryInfoFlags.NONE, null);
        return [
            info.get_size(),
            info.get_attribute_uint64('time::modified'),
            info.get_attribute_uint32('time::modified-usec'),
            info.get_attribute_string('etag::value') ?? '',
        ].join(':');
    }
    _readEntry(name) {
        if (this._raw) {
            const source = this._read(name);
            return {
                source,
                metadataRaw: '',
                snapshot: `raw:${source}`,
                document: parseRawDocument(source),
            };
        }
        const format = noteFormatForFilename(name);
        if (!format)
            throw new Error('Unsupported note format');
        if (format === 'markdown') {
            const source = this._read(name);
            return {
                source,
                metadataRaw: '',
                snapshot: `markdown:${source}`,
                document: parseDocument(source),
            };
        }
        const sidecar = this._sidecar(name);
        if (isImageNoteFormat(format)) {
            const fingerprint = this._fingerprint(name);
            return {
                source: null,
                metadataRaw: sidecar.raw,
                snapshot: `${format}:${fingerprint}\u0000${sidecar.raw}`,
                document: {
                    body: '',
                    metadata: sidecar.metadata,
                    hasFrontmatter: false,
                    hasMetadata: sidecar.hasMetadata,
                    format,
                    path: this._watchFile(name).get_path(),
                },
            };
        }
        const source = this._read(name);
        return {
            source,
            metadataRaw: sidecar.raw,
            snapshot: `${format}:${source}\u0000${sidecar.raw}`,
            document: {
                body: source,
                metadata: sidecar.metadata,
                hasFrontmatter: false,
                hasMetadata: sidecar.hasMetadata,
                format,
            },
        };
    }
    _replace(file, text) {
        file.replace_contents(new TextEncoder().encode(text), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
    _matchesDisk(name, known) {
        if (!known)
            return !this._watchFile(name).query_exists(null);
        try {
            return this._readEntry(name).snapshot === known.snapshot;
        } catch {
            return false;
        }
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
                    if (this._readEntry(name).snapshot !== previous.snapshot) {
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
            if (text === previous?.source)
                return true;
            try {
                this._replace(file, text);
                this._known.set(name, this._readEntry(name));
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
        if (!this._matchesDisk(name, previous)) {
            this.queueScan();
            return false;
        }
        const rel = normalizeRelpath(name);
        const parent = rel && rel.includes('/') ? GLib.path_get_dirname(rel) : null;
        if (parent)
            GLib.mkdir_with_parents(GLib.build_filenamev([this.directory, parent]), 0o755);
        const format = noteFormatForFilename(name);
        if (!format)
            return false;
        try {
            if (format === 'markdown') {
                const document = writeDocument(note, previous?.source ?? '');
                if (document !== previous?.source)
                    this._replace(file, document);
            } else {
                if (!isImageNoteFormat(format)) {
                    const source = note.text ?? '';
                    if (source !== previous?.source)
                        this._replace(file, source);
                }
                const metadata = writeNoteMetadata(note);
                if (metadata !== previous?.metadataRaw)
                    this._replace(this._sidecarFile(name), metadata);
            }
            this._known.set(name, this._readEntry(name));
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
        if (!this._raw) {
            try {
                this._sidecarFile(name).delete(null);
            } catch (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    console.warn(`Sticky Notes: could not delete metadata for ${name}: ${error}`);
            }
        }
        this._known.delete(name);
        this._deleted.add(name);
        return true;
    }
    // Move a note file to a new relpath, creating target folders. The scan
    // that follows re-keys the note in the UI by its new filename.
    move(oldName, newName) {
        if (this._raw)
            return false; // The TODO file has a fixed identity.
        const oldRel = normalizeRelpath(oldName);
        const newRel = normalizeRelpath(newName);
        if (!oldRel || !newRel || !isNoteRelpath(newRel))
            return false;
        if (oldRel === newRel)
            return true;
        if (this._deleted.has(oldRel))
            return false; // Tombstoned files never move.
        const target = this._file(newName);
        if (target.query_exists(null))
            return false; // Refuse to overwrite an existing note.
        const parent = newRel.includes('/') ? GLib.path_get_dirname(newRel) : null;
        if (parent)
            GLib.mkdir_with_parents(GLib.build_filenamev([this.directory, parent]), 0o755);
        const source = this._file(oldName);
        if (!source.query_exists(null))
            return false; // Source file gone (zombie note), nothing to move.
        try {
            source.move(target, Gio.FileCopyFlags.NONE, null, null);
        } catch (error) {
            console.error(`Sticky Notes: could not move ${oldRel} to ${newRel}: ${error}`);
            return false;
        }
        const oldSidecar = this._sidecarFile(oldRel);
        if (oldSidecar.query_exists(null)) {
            try {
                oldSidecar.move(this._sidecarFile(newRel), Gio.FileCopyFlags.OVERWRITE, null, null);
            } catch (error) {
                console.warn(`Sticky Notes: could not move metadata for ${oldRel}: ${error}`);
            }
        }
        this._known.delete(oldRel);
        try {
            this._known.set(newRel, this._readEntry(newRel));
        } catch (error) {
            console.warn(`Sticky Notes: could not refresh moved note ${newRel}: ${error}`);
        }
        this._deleted.delete(newRel);
        this.queueScan();
        return true;
    }
}
