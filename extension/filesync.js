import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseDocument, writeDocument} from './document.js';

// Disk is authoritative. A monitor updates the live UI, and all extension
// writes go through the same snapshots to avoid its own monitor feedback.
export class NoteFiles {
    constructor(onChange, onDelete, directory = null) {
        this.directory = directory ?? GLib.build_filenamev([GLib.get_home_dir(), 'notes']);
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
        GLib.mkdir_with_parents(this.directory, 0o755);
        const folder = Gio.File.new_for_path(this.directory);
        try {
            this._monitor = folder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitorId = this._monitor.connect('changed', (_watch, file, otherFile) => {
                if (this._isNote(file?.get_basename()) || this._isNote(otherFile?.get_basename()))
                    this.queueScan();
            });
        } catch (error) {
            console.error(`Sticky Notes: cannot monitor ${this.directory}: ${error}`);
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

    newFilename() {
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
                const [, bytes] = this._file(name).load_contents(null);
                document = new TextDecoder().decode(bytes);
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
            this._onChange(name, parseDocument(document));
        }
    }

    save(note) {
        const name = note.filename;
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
            this._file(name).delete(null);
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
