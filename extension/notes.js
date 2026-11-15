import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    attributeRuns,
    backspaceMarker,
    charOffset,
    editRange,
    editSizes,
    endList,
    ensureMarker,
    insertTable,
    lineMark,
    listContinuation,
    markAt,
    markerStatesAt,
    paintStyle,
    retargetSizes,
    retargetSpans,
    shiftSpans,
    toggleMarker,
    toggleBoxAt,
    toggleCheckboxLine,
    utf8Length,
    MARKERS,
    STYLE_BOLD,
    STYLE_ITALIC,
    STYLE_STRIKE,
    STYLE_UNDERLINE,
} from './format.js';
import {
    COLOR_LABELS,
    MIN_H,
    MIN_W,
    PALETTE,
    SWATCH_ORDER,
    TODO_ID,
    clamp,
    emptyStore,
    freshOrigin,
    normalizeSize,
    normalizeZoom,
    hexIsDark,
    zoomFont,
    parseExpires,
    formatExpires,
    expiresToFrontmatter,
    categoryFromRelpath,
    categoryPartsFromRelpath,
} from './model.js';
import {resolveNameToColor} from './name-to-color.js';
import {
    compatibleApps,
    contentTypesForFilename,
    launchExternalApp,
} from './external-editor.js';
import {DesktopLayer, PinnedLayer} from './layer.js';
import {NoteFiles, expandNotePath, normalizeRelpath} from './filesync.js';
import {t} from './i18n.js';
import {renderMarkdown, renderTodo} from './markdown-preview.js';
import {
    isImageNoteFormat,
    noteFormatForFilename,
} from './note-format.js';
import {renderPlainText, renderSafeHtml} from './safe-preview.js';
import {
    displayLine,
    parseTodoLine,
    recurrenceNextLine,
    sortTodoText,
    splitDisplayLine,
    stripTodoGlyphs,
    toDateString,
    toggleTodoDisplayLine,
    todoBackspace,
    todoContinuation,
    todoEndOfLine,
    withTodoGlyphs,
} from './todo.js';
import {NoteRibbon} from './ribbon.js';

const BUTTON_PRIMARY = 1;
const BUTTON_SECONDARY = 3;
const HANDLE = 18;
// Note header (grip) height and the close-button hit area.
const HEADER_H = 24;
const CLOSE_SIZE = 18;
// Extra pixels around a checkbox glyph that still count as a hit.
const BOX_SLOP = 3;
const MOVE_KEYS = new Set([
    Clutter.KEY_Left,
    Clutter.KEY_Right,
    Clutter.KEY_Up,
    Clutter.KEY_Down,
    Clutter.KEY_Home,
    Clutter.KEY_End,
    Clutter.KEY_Page_Up,
    Clutter.KEY_Page_Down,
    Clutter.KEY_KP_Left,
    Clutter.KEY_KP_Right,
    Clutter.KEY_KP_Up,
    Clutter.KEY_KP_Down,
    Clutter.KEY_KP_Home,
    Clutter.KEY_KP_End,
    Clutter.KEY_KP_Page_Up,
    Clutter.KEY_KP_Page_Down,
]);
const ENTER_KEYS = new Set([
    Clutter.KEY_Return,
    Clutter.KEY_KP_Enter,
    Clutter.KEY_ISO_Enter,
]);
const PALE_INK = [154, 149, 142].map(channel => Math.round(channel / 255 * 65535));
const PALE_ALPHA = Math.round(0.72 * 65535);

function color4(r, g, b, a) {
    const color = new Cogl.Color();
    color.init_from_4f(r, g, b, a);
    return color;
}

export class NotesController {
    constructor(settings) {
        this._settings = settings;
        this._ready = false;
        this._queue = [];
        this._views = new Map();
        this._store = emptyStore();
        this._saveId = 0;
        this._expirySweepId = 0;
        this._menuDropId = 0;
        this._menu = null;
        this._menuId = 0;
        this._menuView = null;
        this._menuThen = null;
        this._drag = null;
        this._textDrag = null;
        this._focused = null;
        this._overview = Main.overview.visible;
        this._byFilename = new Map();
        this._files = null;
        this._todoFile = null;
        this._todoFiles = null;
        this._ink = color4(50 / 255, 47 / 255, 56 / 255, 1);
        this._inkLight = color4(246 / 255, 245 / 255, 244 / 255, 1);
        this._select = color4(50 / 255, 47 / 255, 56 / 255, 0.16);
        this._desktop = new DesktopLayer();
        this._pinnedLayer = new PinnedLayer();
        this._layer = this._desktop.actor;
        this._menuManager = new PopupMenu.PopupMenuManager(this._layer);
        // Follow the desktop's window-button side for the note close button.
        this._closeOnLeft = this._readCloseButtonSide();

        global.stage.connectObject(
            'captured-event', (_stage, event) => this._onCaptured(event),
            this);
        global.display.connectObject(
            'notify::focus-window', () => this._onFocusWindow(),
            this);
        Main.overview.connectObject(
            'showing', () => this._setOverview(true),
            'hidden', () => this._setOverview(false),
            this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._onMonitors(),
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._applyVisibility(),
            this);
        this._load();
    }

    destroy() {
        this._queue = [];
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }
        if (this._expirySweepId) {
            GLib.Source.remove(this._expirySweepId);
            this._expirySweepId = 0;
        }
        this._closeMenu();
        this._menuManager = null;
        this._files?.stop();
        this._todoFiles?.stop();
        if (this._ready)
            this._write();
        this._finishDrag();
        this._finishTextDrag();
        global.stage.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const view of [...this._views.values()])
            this._drop(view);
        this._byFilename.clear();
        this._files = null;
        this._todoFile = null;
        this._todoFiles = null;
        this._desktop.destroy();
        this._pinnedLayer.destroy();
        this._desktop = null;
        this._pinnedLayer = null;
        this._layer = null;
    }

    create(at) {
        this._whenReady(() => this._create(at));
    }

    toggle() {
        this._whenReady(() => this._toggle());
    }

    deleteAll() {
        this._whenReady(() => this._deleteAll());
    }

    applySettings() {
        this._whenReady(() => {
            this._clampAll();
            if (this._focused)
                this._orderNote(this._focused);
            this._applyVisibility();
            this._scheduleSave();
        });
    }

    status() {
        return {
            hidden: this._store.hidden === true,
            notes: this._store.notes.filter(note => (note.kind ?? 'note') === 'note').length,
        };
    }

    _whenReady(fn) {
        if (this._ready)
            fn();
        else
            this._queue.push(fn);
    }

    _flushQueue() {
        const queue = this._queue;
        this._queue = [];
        for (const fn of queue)
            fn();
    }

    _load() {
        this._store.hidden = this._settings.get_boolean('notes-hidden');
        this._ready = true;
        this._files = new NoteFiles(
            (filename, document) => this._upsertFile(filename, document),
            filename => this._removeFile(filename));
        console.log('Sticky Notes: _load calling _files.start()');
        this._files.start();
        console.log('Sticky Notes: _files.start() returned');
        this._loadTodo();
        this._applyVisibility();
        this._flushQueue();
        // One startup line per session: it is the acceptance evidence that the
        // scan reached the desktop, and the first thing to read in a bug report.
        const loaded = [...this._views.values()]
            .filter(view => view.note.kind === 'note').length;
        console.log(`Sticky Notes: loaded ${loaded} note(s) from ${this._files.directory}`);
        this._sweepExpiredNotes();
        this._expirySweepId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._sweepExpiredNotes();
            return GLib.SOURCE_CONTINUE;
        });
    }
    // The TODO file is a pure todo.txt watched on its own: no frontmatter
    // is ever added to it, and its layout lives in GSettings.
    _todoPath() {
        return expandNotePath(this._settings.get_string('todo-file'));
    }
    _loadTodo() {
        this._todoFile = this._todoPath();
        if (!this._todoFile)
            return;
        this._todoFiles = new NoteFiles(
            (filename, document) => this._upsertTodoFile(filename, document),
            filename => this._removeFile(filename),
            {file: this._todoFile});
        this._todoFiles.start();
    }
    // Called when the todo-file setting changes.
    reloadTodoFile() {
        const previous = this._todoFile;
        const next = this._todoPath();
        if (previous === next && this._todoFiles)
            return;
        this._todoFiles?.stop();
        this._todoFiles = null;
        this._todoFile = null;
        if (previous !== next)
            this._removeTodoView();
        this._loadTodo();
    }
    _removeTodoView() {
        const view = [...this._views.values()].find(view => view.note.kind === 'todo');
        if (!view)
            return;
        const index = this._store.notes.indexOf(view.note);
        if (index >= 0)
            this._store.notes.splice(index, 1);
        this._drop(view);
    }
    _defaultTodoNote(filename) {
        const w = this._settings.get_int('note-width');
        const h = this._settings.get_int('note-height');
        const obstacles = this._store.notes.map(note => [note.x, note.y, note.w, note.h]);
        const [x, y] = freshOrigin(obstacles, this._workAreas(), w, h, null, null);
        const note = {
            id: TODO_ID,
            kind: 'todo',
            filename,
            x, y, w, h, expanded_h: h,
            color: this._store.notes.length % PALETTE.length,
            size: 13, locked: false, pinned: false,
            zoom: 100,
            custom_color: null,
            expires: null,
            text: '', spans: [], sizes: [], workspace: this._workspace(),
        };
        try {
            const stored = this._settings.get_string('todo-layout');
            const layout = stored ? JSON.parse(stored) : null;
            if (layout && typeof layout === 'object') {
                for (const key of ['x', 'y', 'w', 'h', 'expanded_h', 'color', 'size', 'workspace'])
                    if (Number.isInteger(layout[key]))
                        note[key] = layout[key];
                if (Number.isInteger(layout.zoom))
                    note.zoom = normalizeZoom(layout.zoom);
                if (typeof layout.custom_color === 'string')
                    note.custom_color = layout.custom_color;
                if (typeof layout.pinned === 'boolean')
                    note.pinned = layout.pinned;
                if (typeof layout.locked === 'boolean')
                    note.locked = layout.locked;
            }
        } catch (error) {
            console.warn(`Sticky Notes: ignoring invalid todo-layout: ${error}`);
        }
        note.color = ((note.color % PALETTE.length) + PALETTE.length) % PALETTE.length;
        note.size = normalizeSize(note.size);
        note.spans = [];
        note.sizes = [];
        return note;
    }
    _upsertTodoFile(filename, document) {
        const view = this._byFilename.get(filename);
        const note = view ? view.note : this._defaultTodoNote(filename);
        note.kind = 'todo';
        // The editor displays each task with a leading checkbox glyph; the
        // glyph never reaches the file.
        note.text = withTodoGlyphs(document.body);
        this._clampNote(note);
        if (view) {
            view.loading = true;
            try {
                view.text.text = note.text;
                this._refreshPreview(view);
                this._moveToLayer(view);
                this._layout(view);
                this._paint(view);
                this._applyVisibility();
            } finally {
                view.loading = false;
            }
        } else {
            this._store.notes.push(note);
            this._mount(note, false);
        }
    }
    _saveTodoLayout(note) {
        const layout = {
            x: note.x, y: note.y, w: note.w, h: note.h, expanded_h: note.expanded_h,
            color: note.color, size: normalizeSize(note.size), zoom: normalizeZoom(note.zoom ?? 100),
            custom_color: typeof note.custom_color === 'string' ? note.custom_color : null,
            workspace: note.workspace,
            pinned: note.pinned === true, locked: note.locked === true,
        };
        const encoded = JSON.stringify(layout);
        if (encoded !== this._settings.get_string('todo-layout'))
            this._settings.set_string('todo-layout', encoded);
    }
    // Create the file when missing, then show/focus the note. Bound to the
    // panel menu entry.
    openOrCreateTodo() {
        if (this._overview)
            Main.overview.hide();
        if (this._store.hidden) {
            this._store.hidden = false;
            this._settings.set_boolean('notes-hidden', false);
            this._applyVisibility();
        }
        if (!this._todoFile)
            this.reloadTodoFile();
        if (!this._todoFile) {
            console.warn('Sticky Notes: TODO file is disabled; set a path in Preferences to use the TODO note');
            return;
        }
        try {
            const file = Gio.File.new_for_path(this._todoFile);
            if (!file.query_exists(null)) {
                file.replace_contents(new TextEncoder().encode('\n'), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            }
        } catch (error) {
            console.error(`Sticky Notes: could not create ${this._todoFile}: ${error}`);
            return;
        }
        this._todoFiles?.scan();
        const view = this._byFilename.get(GLib.path_get_basename(this._todoFile));
        if (view)
            this._focus(view, true);
    }

    _defaultNote(filename) {
        const w = this._settings.get_int('note-width');
        const h = this._settings.get_int('note-height');
        const pinNew = this._settings.get_boolean('pin-new-notes');
        const obstacles = this._store.notes.map(note => [note.x, note.y, note.w, note.h]);
        const [x, y] = freshOrigin(obstacles, this._workAreas(), w, h, null, null);
        return {
            id: this._store.next_id++,
            kind: 'note',
            format: noteFormatForFilename(filename) ?? 'markdown',
            filename, x, y, w, h, expanded_h: h,
            color: this._store.notes.length % PALETTE.length,
            size: 13,
            locked: false,
            zoom: 100,
            custom_color: null,
            expires: null,
            pinned: pinNew,
            text: '', spans: [], sizes: [], workspace: this._workspace(),
        };
    }

    _upsertFile(filename, document) {
        console.log(`Sticky Notes: _upsertFile ${filename}, view exists: ${!!this._byFilename.get(filename)}`);
        const view = this._byFilename.get(filename);
        const note = view ? view.note : this._defaultNote(filename);
        note.kind = 'note';
        note.format = document.format ?? noteFormatForFilename(filename) ?? 'markdown';
        note.sourcePath = typeof document.path === 'string' ? document.path : null;
        const metadata = document.metadata;
        if (!view && Number.isInteger(metadata.id) && metadata.id > 0 &&
            !this._views.has(metadata.id)) {
            note.id = metadata.id;
        }
        if (!view)
            this._store.next_id = Math.max(this._store.next_id, note.id + 1);
        for (const key of ['x', 'y', 'w', 'h', 'expanded_h', 'color', 'size', 'workspace']) {
            if (Number.isInteger(metadata[key]))
                note[key] = metadata[key];
        }
        if (Number.isInteger(metadata.zoom))
            note.zoom = normalizeZoom(metadata.zoom);
        note.custom_color = typeof metadata.custom_color === 'string'
            ? metadata.custom_color
            : null;
        note.expires = typeof metadata.expires === 'string' ? metadata.expires : null;
        for (const key of ['locked', 'pinned']) {
            if (typeof metadata[key] === 'boolean')
                note[key] = metadata[key];
        }
        note.color = ((note.color % PALETTE.length) + PALETTE.length) % PALETTE.length;
        note.size = normalizeSize(note.size);
        note.spans = Array.isArray(metadata.spans) ? metadata.spans : [];
        note.sizes = Array.isArray(metadata.sizes) ? metadata.sizes : [];
        note.text = document.body;
        this._clampNote(note);
        if (view) {
            view.loading = true;
            try {
                view.text.text = note.text;
                if (isImageNoteFormat(note.format)) {
                    view.previewMode = true;
                    view.text.visible = false;
                    view.preview.visible = true;
                }
                this._refreshPreview(view);
                this._moveToLayer(view);
                this._layout(view);
                this._paint(view);
                this._applyVisibility();
            } finally {
                view.loading = false;
            }
        } else {
            this._store.notes.push(note);
            this._mount(note, false);
        }
        // External files without the extension's metadata acquire defaults.
        if (!document.hasMetadata || !Number.isInteger(metadata.id))
            this._scheduleSave();
    }

    _removeFile(filename) {
        const view = this._byFilename.get(filename);
        if (!view)
            return;
        // The drop happens first: a failure there must leave the note in the
        // store so a later save does not silently target a stale state.
        this._drop(view);
        const index = this._store.notes.indexOf(view.note);
        if (index >= 0)
            this._store.notes.splice(index, 1);
    }

    _write() {
        for (const note of this._store.notes) {
            if (note.kind === 'todo') {
                this._saveTodoLayout(note);
                this._todoFiles?.save({filename: note.filename, rawText: stripTodoGlyphs(note.text)});
            } else {
                this._files?.save(note);
            }
        }
    }

    _scheduleSave() {
        if (!this._ready)
            return;
        if (this._saveId)
            GLib.Source.remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._saveId = 0;
            this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    _workspace() {
        return global.workspace_manager.get_active_workspace_index();
    }

    // GNOME button-layout, e.g. 'appmenu:minimize,maximize,close'.
    // The left of the colon is the left group; close usually sits on the right.
    _readCloseButtonSide() {
        try {
            // Check if the schema exists before creating Settings object
            const schemaSource = Gio.SettingsSchemaSource.get_default();
            if (!schemaSource.lookup('org.gnome.desktop.wm.preferences', true))
                return false;
            const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
            const layout = settings.get_string('button-layout');
            const [left] = String(layout).split(':');
            return (left || '').split(',').map(part => part.trim()).includes('close');
        } catch (error) {
            console.debug(`Sticky Notes: cannot read button-layout: ${error}`);
            return false;
        }
    }

    _workAreas() {
        const monitors = Main.layoutManager.monitors;
        const primary = Main.layoutManager.primaryIndex;
        const order = [];
        if (primary >= 0 && primary < monitors.length)
            order.push(primary);
        for (let i = 0; i < monitors.length; i++) {
            if (i !== primary)
                order.push(i);
        }
        const areas = [];
        for (const i of order) {
            const area = Main.layoutManager.getWorkAreaForMonitor(i);
            if (area.width >= 320 && area.height >= 240)
                areas.push({x: area.x, y: area.y, w: area.width, h: area.height});
        }
        if (!areas.length && order.length) {
            const area = Main.layoutManager.getWorkAreaForMonitor(order[0]);
            areas.push({x: area.x, y: area.y, w: area.width, h: area.height});
        }
        return areas;
    }

    _limits() {
        // 90% of the primary monitor work area (no user-configurable cap).
        const primary = Main.layoutManager.primaryIndex;
        const monitors = Main.layoutManager.monitors;
        if (primary >= 0 && primary < monitors.length) {
            const area = Main.layoutManager.getWorkAreaForMonitor(primary);
            return [Math.round(area.width * 0.9), Math.round(area.height * 0.9)];
        }
        // Fallback to first available monitor
        for (const i of monitors) {
            const area = Main.layoutManager.getWorkAreaForMonitor(i);
            return [Math.round(area.width * 0.9), Math.round(area.height * 0.9)];
        }
        // Ultimate fallback (should never happen)
        return [1920, 1080];
    }

    _clampNote(note) {
        const [maxW, maxH] = this._limits();
        const [x, y, w, h] = clamp(
            note.x, note.y, note.w, note.h, this._workAreas(), MIN_W, MIN_H, maxW, maxH);
        note.x = x;
        note.y = y;
        note.w = w;
        note.h = h;
        note.expanded_h = h;
    }

    _clampAll() {
        for (const view of this._views.values()) {
            this._clampNote(view.note);
            this._layout(view);
        }
    }

    _setOverview(open) {
        this._overview = open;
        if (open)
            this._blur();
        this._applyVisibility();
    }

    _onMonitors() {
        this._whenReady(() => {
            this._clampAll();
            this._applyVisibility();
            this._scheduleSave();
        });
    }

    _applyVisibility() {
        const show = this._ready && !this._store.hidden && !this._overview;
        const stick = this._settings.get_boolean('stick');
        const space = this._workspace();
        for (const view of this._views.values()) {
            const onSpace = stick || view.note.workspace === space;
            view.frame.visible = show && onSpace;
        }
    }

    // Return a sorted array of unique category paths from all notes.
    // Each category is a string like "pasta/subpasta" (slash-separated).
    _getAllCategories() {
        const categories = new Set();
        for (const note of this._store.notes) {
            if ((note.kind ?? 'note') !== 'note')
                continue;
            const parts = categoryPartsFromRelpath(note.filename);
            if (!parts.length)
                continue;
            // Add each level: "a", "a/b", "a/b/c"
            let current = '';
            for (const part of parts) {
                current = current ? `${current}/${part}` : part;
                categories.add(current);
            }
        }
        return [...categories].sort((a, b) => a.localeCompare(b));
    }

    _create(at) {
        if (this._overview)
            Main.overview.hide();
        if (this._store.hidden) {
            this._store.hidden = false;
            this._settings.set_boolean('notes-hidden', false);
            this._applyVisibility();
        }
        const [maxW, maxH] = this._limits();
        const w = Math.min(this._settings.get_int('note-width'), maxW);
        const h = Math.min(this._settings.get_int('note-height'), maxH);
        const areas = this._workAreas();
        const obstacles = this._store.notes.map(note => [note.x, note.y, note.w, note.h]);
        const prefer = this._focused ? [this._focused.note.x, this._focused.note.y] : null;
        const [x, y] = freshOrigin(obstacles, areas, w, h, at, prefer);
        const id = this._store.next_id;
        this._store.next_id += 1;
        const note = {
            id,
            kind: 'note',
            format: 'markdown',
            filename: this._files.newFilename(),
            pinned: this._settings.get_boolean('pin-new-notes'),
            x,
            y,
            w,
            h,
            expanded_h: h,
            color: this._store.notes.length % PALETTE.length,
            size: 13,
            locked: false,
            zoom: 100,
            custom_color: null,
            expires: null,
            text: '',
            spans: [],
            sizes: [],
            workspace: this._workspace(),
        };
        this._clampNote(note);
        this._store.notes.push(note);
        this._mount(note, true);
        this._scheduleSave();
    }

    _toggle() {
        this._store.hidden = !this._store.hidden;
        this._settings.set_boolean('notes-hidden', this._store.hidden);
        if (this._store.hidden)
            this._blur();
        this._applyVisibility();
        this._scheduleSave();
    }

    // Delete removes the note's source file and its owned sidecar, then drops
    // the view. The close button in the note header uses this same path.
    _delete(view) {
        // The TODO note is never deleted by the extension: the file may be
        // shared with other todo.txt tools. Deleting the file removes the note.
        if ((view.note.kind ?? 'note') !== 'note')
            return;
        if (!this._files.remove(view.note.filename))
            return;
        const index = this._store.notes.indexOf(view.note);
        if (index >= 0)
            this._store.notes.splice(index, 1);
        this._drop(view);
    }

    _deleteAll() {
        for (const view of [...this._views.values()]) {
            if ((view.note.kind ?? 'note') === 'note')
                this._delete(view);
        }
    }

    _layerFor(note) {
        return note.pinned ? this._pinnedLayer.actor : this._layer;
    }

    _moveToLayer(view) {
        const target = this._layerFor(view.note);
        const parent = view.frame.get_parent();
        if (parent !== target) {
            parent?.remove_child(view.frame);
            target.add_child(view.frame);
            this._layout(view);
        }
    }

    _mount(note, focus) {
        const view = this._build(note);
        this._views.set(note.id, view);
        this._byFilename.set(note.filename, view);
        this._desktop.seat();
        this._layerFor(note).add_child(view.frame);
        this._layout(view);
        this._paint(view);
        this._applyVisibility();
        if (focus)
            this._focusLater(view);
        return view;
    }

    _focusLater(view) {
        if (view.focusId)
            GLib.Source.remove(view.focusId);
        view.focusId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            view.focusId = 0;
            // A click on another note in this same turn wins.
            if (!this._focused || this._focused === view)
                this._focus(view, true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _build(note) {
        const isImage = isImageNoteFormat(note.format);
        const startsInPreview = isImage || note.format === 'html';
        const frame = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            x: note.x,
            y: note.y,
            width: note.w,
            height: note.h,
        });
        const card = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: `sticky-note ${isImage ? 'image-sticker' : PALETTE[note.color]}`,
            x_expand: true,
            y_expand: true,
        });
        const grip = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            style_class: 'sticky-note-grip',
            reactive: true,
            cursor_type: Clutter.CursorType.GRAB,
            height: HEADER_H,
            x_expand: true,
        });
        // Close button: closing deletes the note. Its side follows the
        // desktop's window-button layout.
        let closeButton = null;
        if ((note.kind ?? 'note') === 'note') {
            closeButton = new St.Button({
                style_class: 'sticky-note-close',
                can_focus: false,
                reactive: true,
                accessible_name: t('Delete note'),
            });
            closeButton.add_child(new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 12,
                style_class: 'sticky-note-close-icon',
            }));
            grip.add_child(closeButton);
        }
        // Category pills: one per folder level, e.g. `(pasta) / (subpasta)`.
        // Root notes and the TODO note have no category pill.
        let categoryPill = null;
        let categoryPills = [];
        if ((note.kind ?? 'note') === 'note' && note.filename.includes('/')) {
            const built = this._createCategoryPills(note);
            if (built) {
                grip.add_child(built.box);
                categoryPill = built.box;
                categoryPills = built.pills;
            }
        }
        const pill = new St.Widget({
            style_class: 'sticky-note-pill',
            width: 36,
            height: 4,
            x: Math.max(0, Math.round((note.w - 36) / 2)),
            y: 7,
        });
        grip.add_child(pill);
        const expiryBadge = new St.Label({
            style_class: 'sticky-note-expiry',
            text: '',
            visible: false,
            reactive: false,
            x: Math.max(0, note.w - 112),
            y: 2,
        });
        grip.add_child(expiryBadge);
        const text = new Clutter.Text({
            text: note.text,
            editable: !note.locked && !isImage,
            selectable: true,
            reactive: true,
            // Return is an activate binding. Leave it off so a newline can be inserted.
            activatable: false,
            single_line_mode: false,
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            font_name: `Sans ${note.size}`,
            color: this._ink,
            cursor_color: this._ink,
            selection_color: this._select,
            selected_text_color: this._ink,
            cursor_type: note.locked ? Clutter.CursorType.DEFAULT : Clutter.CursorType.TEXT,
            margin_top: 4,
            margin_bottom: 8,
            margin_left: 12,
            margin_right: 14,
            // Fill the page, so a press below the last line still lands on the text.
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
            visible: !startsInPreview,
        });
        // ScrollView.child must implement St.Scrollable. Clutter.Text does not;
        // St.BoxLayout does, and it holds the text.
        const page = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        page.add_child(text);
        const preview = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-note-preview',
            reactive: true,
            x_expand: true,
            y_expand: true,
            y_align: isImage ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.START,
            visible: startsInPreview,
        });
        page.add_child(preview);
        const scroll = new St.ScrollView({
            style_class: 'sticky-note-scroll',
            overlay_scrollbars: true,
            // The scroll view's pan gesture claims the press in the capture
            // phase and cancels the text's click, so a click never focuses it.
            enable_touch_scrolling: false,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
            reactive: true,
            child: page,
        });
        const resize = new St.Widget({
            style_class: 'sticky-note-resize',
            reactive: true,
            cursor_type: Clutter.CursorType.SE_RESIZE,
            width: HANDLE,
            height: HANDLE,
        });
        card.add_child(grip);
        card.add_child(scroll);
        frame.add_child(card);
        frame.add_child(resize);

        const editClick = new Clutter.ClickGesture();
        editClick.set_required_button(BUTTON_PRIMARY);
        // Recognize on release, so a press on the letters still places the caret.
        editClick.set_recognize_on_press(false);

        const view = {
            note, frame, card, grip, pill, expiryBadge, text, preview, resize, scroll, editClick,
            categoryPill, categoryPills, closeButton,
            previewMode: startsInPreview,
            previewOnly: isImage,
            editing: false,
            sizeHold: false,
            pendingSize: 0,
            anchor: null,
            rewrite: false,
            rewriteId: 0,
            focusId: 0,
            newlineId: 0,
            lastEditClick: 0,
            previewRows: [],
            renderToken: 0,
            handleSize: HANDLE,
            previewCursor: 0,
        };
        editClick.connectObject('recognize', () => {
            if (view.previewOnly) {
                this._blur();
                return;
            }
            if (view.previewMode) {
                // Double-click in the preview brings editing back. Locked
                // notes stay in preview.
                const now = GLib.get_monotonic_time();
                if (view.lastEditClick && now - view.lastEditClick < 400 * 1000) {
                    view.lastEditClick = 0;
                    if (!view.note.locked)
                        this._togglePreview(view);
                } else {
                    view.lastEditClick = now;
                    // Single-clicking a preview blurs the note being edited.
                    this._blur();
                }
                return;
            }
            if (!view.note.locked)
                this._focus(view, true);
        }, this);
        closeButton?.connectObject('clicked', () => this._delete(view), this);
        scroll.add_action(editClick);
        scroll.connectObject(
            'button-press-event', (_actor, event) => this._onBodyPress(view, event),
            this);
        preview.connectObject(
            'captured-event', (_actor, event) => this._onPreviewCapture(view, event),
            this);
        if (note.kind === 'todo' || note.format !== 'markdown') {
            view.ribbon = null;
        } else {
            view.ribbon = new NoteRibbon({
                onPointer: () => this._anchor(view),
                onStyle: bit => this._toggleStyle(view, bit),
                onList: kind => this._applyMarker(view, kind),
                onTable: () => this._insertTable(view),
                onSize: delta => this._stepZoom(view, delta * 10),
                onKeep: () => this._keepTyping(view),
            });
            card.add_child(view.ribbon.actor);
        }
        grip.connectObject(
            'captured-event', (_actor, event) => this._onHandleEvent(view, 'move', grip, event),
            this);
        resize.connectObject(
            'captured-event', (_actor, event) => this._onHandleEvent(view, 'resize', resize, event),
            this);
        frame.connectObject(
            'captured-event', (_actor, event) => this._onBodyEvent(view, event),
            'captured-event', (_actor, event) => this._onShortcutCapture(view, event),
            'button-press-event', (_actor, event) => this._onFramePress(view, event),
            this);
        grip.connectObject(
            'button-press-event', (_actor, event) => this._onGripPress(view, event),
            this);
        text.connectObject(
            'captured-event', (_actor, event) => this._onTextCapture(view, event),
            'button-press-event', (_actor, event) => this._onTextPress(view, event),
            'key-press-event', (_actor, event) => {
                view._userChoseEditMode = false;
                return this._onTextKey(view, event);
            },
            'key-focus-in', () => {
                view.editing = true;
                this._focus(view, false);
            },
            'key-focus-out', () => {
                view.editing = false;
                this._dropHold(view);
                this._autoPreview(view);
                this._syncRibbon(view);
            },
            'cursor-changed', () => this._syncRibbon(view),
            'text-changed', () => this._onText(view),
            this);
        // Key controllers run before the actor's key signal. Return's binding
        // is activate, and it does not insert a line, so the newline has to
        // be inserted from the controller that sees the key first.
        view.keyControllers = this._watchTextKeys(view, text);
        // Add clipboard key controller for edit mode (Ctrl+C/V/X/A).
        this._addClipboardKeyController(view, text);
        if (view.previewMode)
            this._refreshPreview(view);
        return view;
    }

    _watchTextKeys(view, text) {
        const watched = [];
        const actions = text.get_actions();
        const named = text.get_action('Clutter shortcuts key controller');
        if (named && !actions.includes(named))
            actions.push(named);
        for (const action of actions) {
            if (!(action instanceof Clutter.KeyController))
                continue;
            action.connectObject('key-press', () => this._onShortcutKey(view, action), this);
            watched.push(action);
        }
        return watched;
    }

    _copyTextSelection(view) {
        const selection = view.text.get_selection();
        if (!selection)
            return false;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selection);
        return true;
    }

    _cutTextSelection(view) {
        if (view.note.locked || !this._copyTextSelection(view))
            return false;
        view.text.delete_selection();
        return true;
    }

    _pasteTextClipboard(view) {
        if (view.note.locked)
            return;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, value) => {
            if (!value || view.note.locked || view.previewMode ||
                this._views.get(view.note.id) !== view)
                return;
            this._focus(view, true);
            view.text.delete_selection();
            const at = this._clampIndex(view, view.text.cursor_position);
            view.text.insert_text(value, at);
        });
    }

    _selectAllText(view) {
        view.text.set_selection(0, -1);
    }

    // Clutter.Text has no copy/paste helpers. Handle the common editing
    // shortcuts explicitly with St.Clipboard while the text owns key focus.
    // On GNOME Shell 51, Clutter.KeyController::key-press has no signal args.
    // Read keyval/keycode via get_key() and modifier state via get_state().
    _addClipboardKeyController(view, text) {
        const controller = new Clutter.KeyController();
        controller.connectObject('key-press', () => {
            const [, keyval] = controller.get_key();
            const [, pressed] = controller.get_state();
            const control = (pressed & Clutter.ModifierType.CONTROL_MASK) !== 0;
            const shift = (pressed & Clutter.ModifierType.SHIFT_MASK) !== 0;
            if (!view.editing || global.stage.get_key_focus() !== text)
                return Clutter.EVENT_PROPAGATE;
            const lower = keyval >= 0x41 && keyval <= 0x5a ? keyval + 0x20 : keyval;
            // Shift+Insert: Paste (no control)
            if (!control && shift && keyval === Clutter.KEY_Insert) {
                this._pasteTextClipboard(view);
                return Clutter.EVENT_STOP;
            }
            if (!control)
                return Clutter.EVENT_PROPAGATE;
            // Ctrl+Shift+...: let format shortcuts handle these (code, strikethrough, etc.)
            if (shift)
                return Clutter.EVENT_PROPAGATE;
            // Plain Ctrl+C / Ctrl+Insert: Copy
            if (lower === 0x63 || keyval === Clutter.KEY_Insert) {
                this._copyTextSelection(view);
                return Clutter.EVENT_STOP;
            }
            // Ctrl+V: Paste
            if (lower === 0x76) {
                this._pasteTextClipboard(view);
                return Clutter.EVENT_STOP;
            }
            // Ctrl+X: Cut
            if (lower === 0x78) {
                this._cutTextSelection(view);
                return Clutter.EVENT_STOP;
            }
            // Ctrl+A: Select all
            if (lower === 0x61) {
                this._selectAllText(view);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }, this);
        text.add_action(controller);
        view.keyControllers.push(controller);
    }

    // Build the horizontal row of category pills for a note's folder levels.
    // Returns null for root notes (no folder part) or hidden (dotted) paths.
    _createCategoryPills(note) {
        const parts = categoryPartsFromRelpath(note.filename);
        if (!parts.length)
            return null;
        const box = new St.BoxLayout({
            style_class: 'sticky-note-category-pills',
            reactive: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const pills = [];
        parts.forEach((part, index) => {
            if (index > 0) {
                const sep = new St.Label({
                    text: '/',
                    style_class: 'sticky-note-category-separator',
                    reactive: false,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                box.add_child(sep);
            }
            const pill = new St.Label({
                style_class: 'sticky-note-category-pill',
                text: `(${part})`,
                reactive: false,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });
            pill.clutter_text.line_wrap = false;
            pill.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(pill);
            pills.push(pill);
        });
        box.accessible_name = parts.map(part => `(${part})`).join(' / ');
        return {box, pills};
    }

    // Rebuild the category pill row after a note's folder changes.
    _updateCategoryPill(view) {
        if (view.categoryPill) {
            view.grip.remove_child(view.categoryPill);
            view.categoryPill.destroy();
            view.categoryPill = null;
            view.categoryPills = [];
        }
        if ((view.note.kind ?? 'note') === 'note' && view.note.filename.includes('/')) {
            const built = this._createCategoryPills(view.note);
            if (built) {
                view.grip.add_child(built.box);
                view.categoryPill = built.box;
                view.categoryPills = built.pills;
            }
        }
        this._layoutHeader(view);
    }

    // Move the note file to a new relpath, keeping the same view mounted.
    _moveNote(view, newFilename) {
        const oldName = view.note.filename;
        if (oldName === newFilename)
            return true;
        if (!this._files.move(oldName, newFilename))
            return false;
        this._byFilename.delete(oldName);
        view.note.filename = newFilename;
        if (isImageNoteFormat(view.note.format)) {
            view.note.sourcePath = this._files.file(newFilename).get_path();
            this._refreshPreview(view);
        }
        this._byFilename.set(newFilename, view);
        this._updateCategoryPill(view);
        this._scheduleSave();
        return true;
    }

    // Extract the first H1 heading from markdown text.
    _extractFirstH1(text) {
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
            const match = line.match(/^\s*#\s+(.+)$/);
            if (match)
                return match[1].trim();
        }
        return null;
    }

    // Convert H1 text to a valid filename base (without extension).
    _h1ToFilename(h1) {
        // Remove characters invalid in filenames, collapse whitespace, limit length
        let base = h1
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remove diacritics/accents
            .replace(/[<>:"\/\\|?*\x00-\x1f]/g, '')            // forbidden chars
            .replace(/[\s]+/g, '-')                             // spaces -> hyphens
            .replace(/^-+|-+$/g, '')                            // trim hyphens
            .substring(0, 80);                                  // reasonable limit
        return base || 'note';
    }

    // Try to rename the note file based on its first H1 heading.
    // If the target name conflicts, append a timestamp.
    _maybeRenameFromH1(view, previousText) {
        const prevH1 = this._extractFirstH1(previousText);
        const newH1 = this._extractFirstH1(view.note.text);
        if (!newH1 || newH1 === prevH1)
            return;
        const currentBase = view.note.filename.split('/').pop().replace(/\.md$/, '');
        const newH1Slug = this._h1ToFilename(newH1);
        // Already matches (exact or with timestamp suffix)
        if (currentBase === newH1Slug || currentBase.startsWith(newH1Slug + '-'))
            return;
        const dir = view.note.filename.includes('/')
            ? view.note.filename.slice(0, view.note.filename.lastIndexOf('/') + 1)
            : '';
        let newFilename = `${dir}${newH1Slug}.md`;
        // Conflict resolution: if file exists, append timestamp
        if (this._files.file(newFilename).query_exists(null)) {
            const stamp = GLib.get_real_time();
            newFilename = `${dir}${newH1Slug}-${stamp}.md`;
        }
        this._moveNote(view, newFilename);
    }

    // Apply a category change. When the note shares its old category with
    // siblings, they all move together: editing a category relocates it.
    // Empty categoryText means "no category" (move to root).
    _applyCategory(view, categoryText) {
        const newCategory = categoryText ? normalizeRelpath(categoryText) : '';
        if (newCategory === null)
            return false;
        const oldName = view.note.filename;
        const oldCategory = categoryFromRelpath(oldName);
        const base = oldName.split('/').pop();
        const newName = newCategory ? `${newCategory}/${base}` : base;
        if (!this._moveNote(view, newName))
            return false;
        if (oldCategory) {
            const siblings = this._store.notes.filter(note =>
                note !== view.note && categoryFromRelpath(note.filename) === oldCategory);
            for (const sibling of siblings) {
                const siblingView = this._byFilename.get(sibling.filename);
                if (!siblingView)
                    continue; // Skip zombie notes without views
                console.log(`Sticky Notes: _applyCategory moving sibling ${sibling.filename} (id=${sibling.id}) to ${newCategory || 'root'}`);
                const siblingBase = sibling.filename.split('/').pop();
                const siblingNewName = newCategory ? `${newCategory}/${siblingBase}` : siblingBase;
                this._moveNote(siblingView, siblingNewName);
            }
        }
        return true;
    }

    _layout(view) {
        const {note, frame, card, text, resize, pill, expiryBadge, categoryPill} = view;
        frame.set_position(note.x, note.y);
        frame.set_size(note.w, note.h);
        card.set_position(0, 0);
        card.set_size(note.w, note.h);

        this._layoutHeader(view);

        text.width = Math.max(48, note.w - 26);
        view.preview.width = isImageNoteFormat(note.format)
            ? Math.max(48, note.w)
            : Math.max(48, note.w - 26);
        text.min_height = 0;
        resize.set_position(
            Math.max(0, note.w - view.handleSize), Math.max(0, note.h - view.handleSize));
        resize.set_size(view.handleSize, view.handleSize);
    }

    // Layout the header grip: close button (per GNOME layout), category pills
    // (left), expiry badge (right), decorative pill (center). None may overlap.
    _layoutHeader(view) {
        const {note, pill, expiryBadge, categoryPill, closeButton} = view;
        const w = note.w;
        const closeW = closeButton ? CLOSE_SIZE : 0;
        // Side insets reserve room for the close button on its configured side.
        const leftInset = closeButton && this._closeOnLeft ? 4 + closeW + 4 : 6;
        const rightInset = closeButton && !this._closeOnLeft ? 4 + closeW + 4 : 6;
        const midY = Math.max(0, Math.round((HEADER_H - 14) / 2));
        const pillY = Math.max(0, Math.round((HEADER_H - 4) / 2));

        // Close button
        if (closeButton) {
            closeButton.set_size(closeW, closeW);
            const x = this._closeOnLeft ? 4 : Math.max(4, w - closeW - 4);
            closeButton.set_position(x, Math.max(0, Math.round((HEADER_H - closeW) / 2)));
        }

        // Measure expiry badge natural width when visible (or 0 when hidden)
        let expiryW = 0;
        if (expiryBadge && expiryBadge.visible) {
            expiryBadge.set_width(-1);
            const [, natW] = expiryBadge.get_preferred_width(-1);
            expiryW = natW;
        }

        // Category pills on the left (after the close button when it is there)
        if (categoryPill) {
            const maxPillW = Math.max(0, w - leftInset - 8 - expiryW - rightInset);
            if (maxPillW <= 0) {
                categoryPill.hide();
            } else {
                categoryPill.show();
                categoryPill.set_width(-1);
                const [, natW] = categoryPill.get_preferred_width(-1);
                const pillW = Math.min(natW, maxPillW);
                categoryPill.set_width(pillW);
                categoryPill.set_position(leftInset, midY);
            }
        }

        // Expiry badge on the right (bounded by the note edge / close button)
        if (expiryBadge) {
            if (expiryBadge.visible) {
                const [, natW] = expiryBadge.get_preferred_width(-1);
                const clampedW = Math.min(natW, Math.max(0, w - leftInset - 8 - rightInset));
                expiryBadge.set_width(clampedW);
                expiryBadge.set_position(Math.max(leftInset, w - clampedW - rightInset), midY);
            } else {
                expiryBadge.set_position(Math.max(0, w - 112), midY);
            }
        }

        // Decorative drag pill (centered). Hide when the category pills, the
        // expiry badge or the close button would overlap it.
        const hasCategory = categoryPill?.visible ?? false;
        if (hasCategory) {
            pill.hide();
        } else {
            const pillCenter = Math.round(w / 2);
            const pillLeft = pillCenter - 18;
            const pillRight = pillCenter + 18;
            const expiryLeft = expiryBadge?.visible ? expiryBadge.x : (w - 112);
            const closeLeft = closeButton && !this._closeOnLeft ? closeButton.x : w;
            const closeRight = closeButton && this._closeOnLeft ? closeButton.x + closeW : 0;
            const overlapsExpiry = pillRight > expiryLeft;
            const overlapsClose = pillLeft < closeRight || pillRight > closeLeft;
            if (overlapsExpiry || overlapsClose) {
                pill.hide();
            } else {
                pill.show();
                pill.set_position(Math.max(0, pillLeft), pillY);
            }
        }
    }

    _paint(view) {
        const note = view.note;
        const isImage = isImageNoteFormat(note.format);
        const custom = note.custom_color ? resolveNameToColor(note.custom_color) : null;
        const dark = !isImage && custom ? hexIsDark(custom) : false;
        view.customDark = dark;
        const name = PALETTE[note.color] ?? PALETTE[0];
        for (const color of PALETTE)
            view.card.remove_style_class_name(color);
        view.card.remove_style_class_name('custom-color');
        if (isImage) {
            view.card.add_style_class_name('image-sticker');
            view.card.style = 'background-color: transparent;';
        } else if (custom) {
            view.card.add_style_class_name('custom-color');
            view.card.style = `background-color: ${custom};`;
        } else {
            view.card.style = '';
            view.card.add_style_class_name(name);
        }
        if (note.pinned)
            view.card.add_style_class_name('pinned');
        else
            view.card.remove_style_class_name('pinned');
        const ink = dark ? this._inkLight : this._ink;

        // Category pill text color adapts to theme
        if (view.categoryPill) {
            view.categoryPill.style = dark
                ? 'color: rgba(255,255,255,0.85);'
                : 'color: #322f38;';
        }

        if (view.pill)
            view.pill.style = dark ? 'background-color: rgba(246,245,244,0.4);' : '';
        view.text.editable = !note.locked && !isImage;
        const cursor = note.locked || isImage
            ? Clutter.CursorType.DEFAULT
            : Clutter.CursorType.TEXT;
        view.text.cursor_type = cursor;
        view.frame.cursor_type = cursor;
        const zoom = normalizeZoom(note.zoom ?? 100);
        note.zoom = zoom;
        view.handleSize = HANDLE;
        // Zoom affects only the text font size. Header (grip/pill) and chrome stay fixed.
        view.text.font_name = `Sans ${zoomFont(zoom)}`;
        view.text.color = ink;
        view.text.cursor_color = ink;
        view.resize.style = isImage
            ? ''
            : (dark ? 'background-color: rgba(246,245,244,0.25);' : '');
        view.grip.set_height(HEADER_H);
        view.pill.set_width(36);
        this._updateExpiryBadge(view);
        this._showAttrs(view);
        this._syncRibbon(view);
    }

    _updateExpiryBadge(view) {
        const badge = view.expiryBadge;
        if (!badge)
            return;
        const expires = parseExpires(view.note.expires);
        if (!expires) {
            badge.visible = false;
            this._layoutHeader(view);
            return;
        }
        const pad = value => String(value).padStart(2, '0');
        badge.text = `⌛ ${pad(expires.getDate())}/${pad(expires.getMonth() + 1)} `
            + `${pad(expires.getHours())}:${pad(expires.getMinutes())}`;
        badge.style = view.customDark ? 'color: rgba(246,245,244,0.85);' : '';
        badge.visible = true;
        this._layoutHeader(view);
    }

    _drop(view) {
        for (const key of ['rewriteId', 'focusId', 'newlineId']) {
            if (view[key]) {
                GLib.Source.remove(view[key]);
                view[key] = 0;
            }
        }
        view.pendingText = null;
        view.renderToken += 1;
        if (this._focused === view) {
            if (global.stage.get_key_focus() === view.text)
                global.stage.set_key_focus(null);
            this._focused = null;
        }
        if (this._drag && this._drag.view === view)
            this._finishDrag();
        if (this._textDrag && this._textDrag.view === view)
            this._finishTextDrag();
        if (this._menuView === view)
            this._closeMenu();
        view.resize?.disconnectObject(this);
        view.editClick?.disconnectObject(this);
        if (view.scroll && view.editClick)
            view.scroll.remove_action(view.editClick);
        view.scroll?.disconnectObject(this);
        view.frame.disconnectObject(this);
        view.grip.disconnectObject(this);
        view.text.disconnectObject(this);
        view.preview.disconnectObject(this);
        for (const controller of view.keyControllers ?? [])
            controller.disconnectObject(this);
        view.ribbon?.destroy();
        this._views.delete(view.note.id);
        this._byFilename.delete(view.note.filename);
        view.frame.destroy();
    }

    _focus(view, grabText) {
        this._focused = view;
        this._moveToLayer(view);
        this._orderNote(view);
        if (grabText && !view.note.locked && !view.previewMode && view.frame.visible) {
            view.editing = true;
            view.text.grab_key_focus();
        }
        this._syncRibbon(view);
    }

    _orderNote(view) {
        if (!this._settings.get_boolean('sink-unfocused'))
            return;
        const parent = view.frame.get_parent();
        if (parent === this._layer || parent === this._pinnedLayer.actor)
            parent.set_child_above_sibling(view.frame, null);
    }

    _blur() {
        // The stage focus holder is the source of truth; the tracked
        // this._focused can lag behind one press behind.
        let view = null;
        const focused = global.stage.get_key_focus();
        for (const candidate of this._views.values()) {
            if (candidate.text === focused) {
                view = candidate;
                break;
            }
        }
        view ??= this._focused;
        if (!view)
            return;
        this._focused = null;
        view.editing = false;
        this._dropHold(view);
        this._autoPreview(view);
        this._syncRibbon(view);
        if (global.stage.get_key_focus() === view.text)
            global.stage.set_key_focus(null);
    }

    _onCaptured(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            !this._eventHitsUs(global.stage.get_event_actor(event)))
            this._blur();
        return Clutter.EVENT_PROPAGATE;
    }

    _eventHitsUs(actor) {
        while (actor) {
            if (actor === this._layer)
                return true;
            if (this._menu && actor === this._menu.actor)
                return true;
            for (const view of this._views.values()) {
                if (actor === view.frame)
                    return true;
            }
            actor = actor.get_parent();
        }
        return false;
    }

    _onFramePress(view, event) {
        if (event.get_button() === BUTTON_SECONDARY) {
            this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() === BUTTON_PRIMARY &&
            !this._onChrome(view, global.stage.get_event_actor(event))) {
            const editable = (view.note.kind ?? 'note') === 'note';
            this._focus(view, editable && !view.note.locked && !view.previewMode);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onChrome(view, actor) {
        while (actor && actor !== view.frame) {
            if (actor === view.grip || actor === view.resize ||
                (view.ribbon && actor === view.ribbon.actor))
                return true;
            actor = actor.get_parent();
        }
        return false;
    }

    _onBodyPress(view, event) {
        if (event.get_button() === BUTTON_SECONDARY) {
            this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() === BUTTON_PRIMARY) {
            const editable = (view.note.kind ?? 'note') === 'note';
            if (editable && !view.note.locked && !view.previewMode)
                this._focus(view, true);
            else if (!editable)
                this._focus(view, false);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onGripPress(view, event) {
        if (event.get_button() === BUTTON_SECONDARY) {
            this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onTextPress(view, event) {
        if (event.get_button() === BUTTON_SECONDARY) {
            // In edit mode, show text editing context menu; otherwise show note menu.
            if (view.editing && global.stage.get_key_focus() === view.text)
                this._openTextEditMenu(view, event);
            else
                this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() === BUTTON_PRIMARY)
            view.sizeHold = false;
        this._focus(view, !view.note.locked);
        return Clutter.EVENT_PROPAGATE;
    }

    // Mouse and keyboard shortcuts for a note that is in focus but not in
    // edit mode. Never interferes with typing or selection: the key handler
    // bails out whenever editing is active.
    _onShortcutCapture(view, event) {
        const type = event.type();
        const control = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const kind = view.note.kind ?? 'note';
        const editing = view.editing && global.stage.get_key_focus() === view.text;
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 2) {
            // Middle click copies; Ctrl+middle duplicates. Pointer-driven,
            // so no focus requirement; works in any editing state.
            if (kind !== 'note')
                return Clutter.EVENT_PROPAGATE;
            if (isImageNoteFormat(view.note.format))
                return Clutter.EVENT_PROPAGATE;
            if (control && view.note.format === 'markdown')
                this._duplicate(view);
            else if (!control)
                this._copyNote(view);
            else
                return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.SCROLL && control) {
            if (isImageNoteFormat(view.note.format))
                return Clutter.EVENT_PROPAGATE;
            const direction = event.get_scroll_direction();
            let step;
            if (direction === Clutter.ScrollDirection.SMOOTH) {
                // Touchpads emit SMOOTH; wheel events may still report UP/DOWN.
                const [, delta] = event.get_scroll_delta();
                // Scroll up produces a negative delta = zoom in.
                step = Math.abs(delta) < 0.01 ? -10 : (delta < 0 ? 10 : -10);
            } else {
                step = direction === Clutter.ScrollDirection.UP ? 10 : -10;
            }
            this._stepZoom(view, step);
            return Clutter.EVENT_STOP;
        }
        if (kind !== 'note' || this._focused !== view || editing)
            return Clutter.EVENT_PROPAGATE;
        if (type !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        const key = event.get_key_symbol();
        const lower = key >= 0x41 && key <= 0x5a ? key + 0x20 : key;
        if (control && lower === 0x63) {
            if (isImageNoteFormat(view.note.format))
                return Clutter.EVENT_PROPAGATE;
            this._copyNote(view);
            return Clutter.EVENT_STOP;
        }
        if (control && key === Clutter.KEY_Delete) {
            this._delete(view);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _dropHold(view) {
        view.sizeHold = false;
    }

    // A press on the note body outside the text, in its margins, places the
    // caret and drags a selection the way a press on the text does.
    _onBodyEvent(view, event) {
        if (view.previewMode || (view.note.kind ?? 'note') !== 'note')
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        const drag = this._textDrag;
        if (drag && drag.view === view) {
            if (type === Clutter.EventType.MOTION) {
                if (event.get_state() & Clutter.ModifierType.BUTTON1_MASK)
                    view.text.set_selection(drag.anchor, this._indexAt(view, event));
                else
                    this._finishTextDrag();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                if (event.get_button() === BUTTON_PRIMARY)
                    this._finishTextDrag();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== BUTTON_PRIMARY ||
            view.note.locked)
            return Clutter.EVENT_PROPAGATE;
        const actor = global.stage.get_event_actor(event);
        if (actor === view.text || this._onChrome(view, actor))
            return Clutter.EVENT_PROPAGATE;
        if (this._pressBox(view, event))
            return Clutter.EVENT_STOP;
        const index = this._indexAt(view, event);
        const extend = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        view.sizeHold = false;
        this._focus(view, true);
        const anchor = extend ? this._clampIndex(view, view.text.selection_bound) : index;
        view.text.set_selection(anchor, index);
        this._textDrag = {view, anchor, grab: global.stage.grab(view.frame)};
        return Clutter.EVENT_STOP;
    }

    _finishTextDrag() {
        const drag = this._textDrag;
        if (!drag)
            return;
        this._textDrag = null;
        drag.grab.dismiss();
    }

    // Character offset nearest a pointer position, which may lie outside the
    // text. Pango indexes bytes, the note text counts characters.
    _indexAt(view, event) {
        const [sx, sy] = event.get_coords();
        const [ok, x, y] = view.text.transform_stage_point(sx, sy);
        if (!ok)
            return this._clampIndex(view, view.text.cursor_position);
        const [ox, oy] = view.text.get_layout_offsets();
        const [, index, trailing] = view.text.get_layout().xy_to_index(
            Math.round((x - ox) * Pango.SCALE),
            Math.round((y - oy) * Pango.SCALE));
        return this._clampIndex(view, charOffset(view.text.text, index) + trailing);
    }

    // Checkbox presses are taken on the way down, before Clutter.Text moves
    // the caret or starts a selection under them.
    _onTextCapture(view, event) {
        if (view.note.locked)
            return Clutter.EVENT_PROPAGATE;
        if (view.note.kind !== 'todo' && view.note.format !== 'markdown')
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.MOTION) {
            const cursor = this._boxAt(view, event) < 0
                ? Clutter.CursorType.TEXT
                : Clutter.CursorType.POINTER;
            if (view.text.cursor_type !== cursor)
                view.text.cursor_type = cursor;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        return this._pressBox(view, event) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _pressBox(view, event) {
        if (view.note.kind !== 'todo' && view.note.format !== 'markdown')
            return false;
        const start = this._boxAt(view, event);
        if (start < 0)
            return false;
        if (view.note.kind === 'todo')
            return this._toggleTodoAt(view, this._lineIndexAt(view.note.text, start));
        const next = toggleBoxAt(view.note.text, start);
        if (next === null)
            return false;
        view.sizeHold = false;
        const cursor = view.text.cursor_position;
        this._focus(view, false);
        this._commitText(view, next, cursor);
        return true;
    }
    // Index of the line whose first character sits at offset in text.
    _lineIndexAt(text, offset) {
        let index = 0;
        let seen = 0;
        for (const line of text.split('\n')) {
            if (seen === offset)
                return index;
            seen += Array.from(line).length + 1;
            index += 1;
        }
        return Math.max(0, index - 1);
    }
    // Toggle one task line: flip the checkbox glyph and the x/date prefix.
    // Completing a recurring task inserts its next occurrence right below.
    _toggleTodoAt(view, lineIndex) {
        const lines = view.note.text.split('\n');
        const line = lines[lineIndex];
        if (line === undefined)
            return false;
        const today = toDateString(new Date());
        const toggled = toggleTodoDisplayLine(line, today);
        if (toggled === null)
            return false;
        const {raw} = splitDisplayLine(line);
        const before = parseTodoLine(raw);
        const merged = [...lines];
        merged[lineIndex] = toggled;
        if (before && !before.completed) {
            const next = recurrenceNextLine(before, today);
            if (next)
                merged.splice(lineIndex + 1, 0, displayLine(next, false));
        }
        view.sizeHold = false;
        this._focus(view, false);
        let cursor = 0;
        for (let i = 0; i < lineIndex; i++)
            cursor += Array.from(merged[i]).length + 1;
        this._commitText(view, merged.join('\n'), cursor);
        return true;
    }
    // --- Preview interaction ---
    // One capture handler serves every preview row (all note kinds). Rows
    // are actors of the preview box; the press source identifies the row.
    _previewRowFor(view, actor) {
        let current = actor;
        const children = view.preview.get_children();
        while (current && current !== view.preview) {
            if (current.get_parent() === view.preview) {
                const index = children.indexOf(current);
                if (index >= 0 && view.previewRows[index])
                    return {row: view.previewRows[index], actor: current, index};
                return null;
            }
            current = current.get_parent();
        }
        return null;
    }

    // Byte index of the pointer position inside the label's layout, or -1.
    // Pango indexes bytes; links are reported in byte ranges.
    _rowPointIndex(view, actor, event) {
        if (!(actor instanceof St.Label))
            return -1;
        const [sx, sy] = event.get_coords();
        const ink = actor.clutter_text;
        const [ok, x, y] = ink.transform_stage_point(sx, sy);
        if (!ok)
            return -1;
        const [ox, oy] = ink.get_layout_offsets();
        const [, bytes] = ink.get_layout().xy_to_index(
            Math.round((x - ox) * Pango.SCALE),
            Math.round((y - oy) * Pango.SCALE));
        return bytes;
    }

    _linkAt(view, hit, event) {
        const {row, actor} = hit;
        if (!row.links?.length)
            return null;
        const bytes = this._rowPointIndex(view, actor, event);
        if (bytes < 0)
            return null;
        return row.links.find(link => bytes >= link.from && bytes < link.to) ?? null;
    }

    _openLink(view, url) {
        let target = null;
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
            target = url;
        } else {
            const root = this._files?.directory
                ?? GLib.build_filenamev([GLib.get_home_dir(), 'notes']);
            const sub = view.note.filename.includes('/')
                ? GLib.path_get_dirname(view.note.filename)
                : '';
            const resolved = GLib.canonicalize_filename(
                GLib.build_filenamev([root, sub, url]), null);
            target = Gio.File.new_for_path(resolved).get_uri();
        }
        try {
            Gio.AppInfo.launch_default_for_uri(target, null);
        } catch (error) {
            console.warn(`Sticky Notes: could not open ${target}: ${error}`);
        }
    }

    // Toggle the Markdown checkbox on one source line ([ ] ↔ [x]).
    _toggleBoxLineAt(view, source) {
        const lines = view.note.text.split('\n');
        const line = lines[source];
        if (line === undefined)
            return false;
        const toggled = toggleCheckboxLine(line);
        if (toggled === null)
            return false;
        lines[source] = toggled;
        view.sizeHold = false;
        this._focus(view, false);
        let cursor = 0;
        for (let i = 0; i < source; i++)
            cursor += Array.from(lines[i]).length + 1;
        cursor += Array.from(lines[source]).length;
        this._commitText(view, lines.join('\n'), cursor);
        return true;
    }

    _onPreviewCapture(view, event) {
        const type = event.type();
        if (type === Clutter.EventType.MOTION) {
            const found = this._previewRowFor(view, event.get_source());
            const row = found?.row;
            const interactive = row && (row.todo || row.box || row.links?.length > 0);
            const cursor = interactive ? Clutter.CursorType.POINTER : Clutter.CursorType.DEFAULT;
            if (view.preview.cursor_type !== cursor)
                view.preview.cursor_type = cursor;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS)
            return Clutter.EVENT_PROPAGATE;
        const button = event.get_button();
        if (button === BUTTON_SECONDARY) {
            this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        if (button !== BUTTON_PRIMARY || !view.previewMode)
            return Clutter.EVENT_PROPAGATE;
        const found = this._previewRowFor(view, event.get_source());
        if (!found)
            return Clutter.EVENT_PROPAGATE;
        return this._onPreviewRowPress(view, found.row, found.actor, event);
    }

    _onPreviewRowPress(view, row, actor, event) {
        if (event.get_button() !== BUTTON_PRIMARY || !view.previewMode)
            return Clutter.EVENT_PROPAGATE;
        const found = {row, actor};
        const link = this._linkAt(view, found, event);
        if (link) {
            this._openLink(view, link.url);
            return Clutter.EVENT_STOP;
        }
        if (row.todo)
            return this._toggleTodoAt(view, row.source)
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        if (row.box)
            return this._toggleBoxLineAt(view, row.source)
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        // Not interactive: let the scroll gesture handle blur/double-click.
        return Clutter.EVENT_PROPAGATE;
    }
    // Character offset of the line whose checkbox glyph is under the pointer,
    // or -1. Pango indexes bytes, the note text counts characters.
    _boxAt(view, event) {
        if (view.note.kind !== 'todo' && view.note.format !== 'markdown')
            return -1;
        const [sx, sy] = event.get_coords();
        const [ok, x, y] = view.text.transform_stage_point(sx, sy);
        if (!ok)
            return -1;
        const layout = view.text.get_layout();
        const [ox, oy] = view.text.get_layout_offsets();
        let bytes = 0;
        let chars = 0;
        for (const line of view.note.text.split('\n')) {
            const mark = lineMark(line);
            if (mark && mark.kind === 'check') {
                const rect = layout.index_to_pos(bytes);
                const left = ox + Math.min(rect.x, rect.x + rect.width) / Pango.SCALE;
                const top = oy + rect.y / Pango.SCALE;
                const width = Math.abs(rect.width) / Pango.SCALE;
                const height = rect.height / Pango.SCALE;
                if (x >= left - BOX_SLOP && x <= left + width + BOX_SLOP &&
                    y >= top - BOX_SLOP && y < top + height + BOX_SLOP)
                    return chars;
            }
            bytes += utf8Length(line) + 1;
            chars += Array.from(line).length + 1;
        }
        return -1;
    }

    _onShortcutKey(view, controller) {
        const [, keyval] = controller.get_key();
        const [, pressed] = controller.get_state();
        if ((pressed & Clutter.ModifierType.CONTROL_MASK) || !ENTER_KEYS.has(keyval))
            return Clutter.EVENT_PROPAGATE;
        return this._insertNewline(view) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    // The key controller and the key-press signal both see one Enter press.
    // Only the first of them inserts the newline.
    _insertNewline(view) {
        if (view.note.locked || view.newlineId)
            return false;
        view.newlineId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            view.newlineId = 0;
            return GLib.SOURCE_REMOVE;
        });
        const text = view.text;
        const structured = view.note.kind === 'todo' || view.note.format === 'markdown';
        if (structured && text.cursor_position === text.selection_bound) {
            const cursor = this._clampIndex(view, text.cursor_position);
            const ended = view.note.kind === 'todo'
                ? todoEndOfLine(view.note.text, cursor)
                : endList(view.note.text, cursor);
            if (ended) {
                this._commitText(view, ended.text, ended.cursor);
                return true;
            }
        }
        if (text.cursor_position !== text.selection_bound)
            text.delete_selection();
        // Clutter reports -1 for the end of the text.
        const at = text.cursor_position < 0 ? Array.from(text.text).length : text.cursor_position;
        text.insert_text('\n', at);
        return true;
    }

    _onTextKey(view, event) {
        const key = event.get_key_symbol();
        const control = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (key === Clutter.KEY_Escape) {
            this._blur();
            return Clutter.EVENT_STOP;
        }
        if (MOVE_KEYS.has(key)) {
            this._dropHold(view);
            return Clutter.EVENT_PROPAGATE;
        }
        if (control && !view.note.locked && view.note.format === 'markdown') {
            const action = this._formatShortcut(key, (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0);
            if (action) {
                this._runFormatShortcut(view, action);
                return Clutter.EVENT_STOP;
            }
        }
        if (!control && ENTER_KEYS.has(key))
            return this._insertNewline(view) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        if (key === Clutter.KEY_BackSpace && !control && !view.note.locked &&
            view.text.cursor_position === view.text.selection_bound &&
            (view.note.kind === 'todo' || view.note.format === 'markdown')) {
            const cursor = view.text.cursor_position < 0
                ? Array.from(view.note.text).length
                : view.text.cursor_position;
            let next = view.note.kind === 'todo' ? todoBackspace(view.note.text, cursor) : null;
            next ??= backspaceMarker(view.note.text, cursor);
            if (next) {
                this._commitText(view, next.text, next.cursor);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onText(view) {
        if (view.loading)
            return;
        if (view.rewrite)
            return;
        const next = view.text.text;
        const prev = view.note.text;
        if (next === prev)
            return;
        if (view.note.kind !== 'todo' && view.note.format !== 'markdown') {
            view.note.text = next;
            view.note.spans = [];
            view.note.sizes = [];
            view.text.set_attributes(null);
            this._scheduleSave();
            return;
        }
        const edit = editRange(prev, next);
        if (edit.removed === 1 && edit.inserted === 0) {
            const marker = backspaceMarker(prev, edit.start + 1);
            if (marker) {
                this._queueText(view, marker.text, marker.cursor);
                return;
            }
        }
        const oldLen = Array.from(prev).length;
        let spans = shiftSpans(view.note.spans, oldLen, edit.start, edit.removed, edit.inserted);
        let sizes = editSizes(view.note.sizes, prev, edit.start, edit.removed, edit.inserted,
            view.sizeHold ? view.pendingSize : null);
        const newLen = oldLen - edit.removed + edit.inserted;
        if (edit.inserted === 1 && edit.removed === 0 && Array.from(next)[edit.start] === '\n') {
            const prefix = view.note.kind === 'todo'
                ? todoContinuation(next, edit.start, toDateString(new Date()))
                : listContinuation(next, edit.start);
            if (prefix) {
                const at = edit.start + 1;
                const prefixChars = Array.from(prefix);
                const merged = Array.from(next);
                merged.splice(at, 0, ...prefixChars);
                spans = shiftSpans(spans, newLen, at, 0, prefixChars.length);
                spans = paintStyle(spans, merged.length, at, at + prefixChars.length, 0);
                sizes = editSizes(sizes, next, at, 0, prefixChars.length);
                // The key handler places the caret after this signal returns.
                // Apply the marker on the next idle, or the caret lands in front of it.
                this._queueText(view, merged.join(''), at + prefixChars.length, spans, sizes);
                return;
            }
        }
        view.note.text = next;
        view.note.spans = spans;
        view.note.sizes = sizes;
        this._showAttrs(view);
        this._syncRibbon(view);
        this._scheduleSave();
        // Auto-rename markdown notes based on first H1
        if (view.note.format === 'markdown')
            this._maybeRenameFromH1(view, prev);
    }

    // Without spans or sizes, both follow the edit from the current note text.
    _queueText(view, text, cursor, spans = null, sizes = null) {
        spans ??= retargetSpans(view.note.spans, view.note.text, text);
        sizes ??= retargetSizes(view.note.sizes, view.note.text, text);
        view.pendingText = {text, cursor, spans, sizes};
        if (view.rewriteId) {
            GLib.Source.remove(view.rewriteId);
            view.rewriteId = 0;
        }
        view.rewriteId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            view.rewriteId = 0;
            const pending = view.pendingText;
            view.pendingText = null;
            if (pending)
                this._commitText(view, pending.text, pending.cursor, pending.spans, pending.sizes);
            return GLib.SOURCE_REMOVE;
        });
    }

    _commitText(view, text, cursor, spans = null, sizes = null, selection = null) {
        spans ??= retargetSpans(view.note.spans, view.note.text, text);
        sizes ??= retargetSizes(view.note.sizes, view.note.text, text);
        view.rewrite = true;
        view.note.text = text;
        view.note.spans = spans;
        view.note.sizes = sizes;
        view.text.set_text(text);
        if (selection && selection[0] !== selection[1])
            view.text.set_selection(selection[0], selection[1]);
        else
            view.text.set_cursor_position(cursor);
        view.rewrite = false;
        this._showAttrs(view);
        this._syncRibbon(view);
        if (view.previewMode)
            this._refreshPreview(view);
        this._scheduleSave();
    }

    _anchor(view) {
        view.anchor = this._range(view);
    }

    // Clutter reports -1 for the end of the text.
    _clampIndex(view, value) {
        const length = Array.from(view.note.text).length;
        return value < 0 ? length : Math.min(value, length);
    }

    _range(view) {
        const start = this._clampIndex(view, view.text.cursor_position);
        const end = this._clampIndex(view, view.text.selection_bound);
        return [Math.min(start, end), Math.max(start, end)];
    }

    // Applies (or removes) the Markdown marker for the style around the
    // selection, or inserts an empty pair with the caret inside. Legacy
    // spans of existing notes stay untouched and keep rendering.
    _toggleStyle(view, bit) {
        if (view.note.locked || view.note.format !== 'markdown')
            return;
        const marker = MARKERS[bit];
        if (!marker)
            return;
        const [start, end] = view.anchor ?? this._range(view);
        const next = toggleMarker(view.note.text, start, end, marker);
        this._commitText(view, next.text, next.end, null, null, [next.start, next.end]);
        view.anchor = null;
        this._keepTyping(view);
    }

    _insertTable(view) {
        if (view.note.locked || view.note.format !== 'markdown')
            return;
        const [, end] = view.anchor ?? this._range(view);
        // Insert at the caret end and keep whatever was selected.
        const next = insertTable(view.note.text, end, end);
        this._commitText(view, next.text, next.cursor);
        view.anchor = null;
        this._keepTyping(view);
    }

    _applyMarker(view, kind) {
        if (view.note.locked || view.note.format !== 'markdown')
            return;
        const cursor = view.anchor ? view.anchor[1] : this._range(view)[1];
        const next = ensureMarker(view.note.text, cursor, kind);
        if (!next)
            return;
        this._commitText(view, next.text, next.cursor);
        view.anchor = null;
        this._keepTyping(view);
    }

    // Resolve the popular formatting shortcut set; returns an action id or null.
    _formatShortcut(key, shift) {
        const lower = key >= 0x41 && key <= 0x5a ? key + 0x20 : key; // A-Z -> a-z
        if (!shift) {
            if (lower === 0x62)
                return 'bold';
            if (lower === 0x69)
                return 'italic';
            if (lower === 0x75)
                return 'underline';
            return null;
        }
        if (key === 0x58 || key === 0x78)
            return 'strike'; // X / x
        if (key === 0x43 || key === 0x63)
            return 'code';   // C / c
        // Ctrl+Shift+7/8/9; US/ABNT shifted glyphs (& * ()) also accepted.
        if (key === 0x37 || key === 0x26)
            return 'list-number';
        if (key === 0x38 || key === 0x2a)
            return 'list-bullet';
        if (key === 0x39 || key === 0x28)
            return 'list-check';
        return null;
    }

    _runFormatShortcut(view, action) {
        switch (action) {
            case 'bold':
                this._toggleStyle(view, STYLE_BOLD);
                return;
            case 'italic':
                this._toggleStyle(view, STYLE_ITALIC);
                return;
            case 'underline':
                this._toggleStyle(view, STYLE_UNDERLINE);
                return;
            case 'strike':
                this._toggleStyle(view, STYLE_STRIKE);
                return;
            case 'code': {
                const [start, end] = view.anchor ?? this._range(view);
                const next = toggleMarker(view.note.text, start, end, {open: '`', close: '`'});
                this._commitText(view, next.text, next.end, null, null, [next.start, next.end]);
                view.anchor = null;
                this._keepTyping(view);
                return;
            }
            case 'list-number':
                this._applyMarker(view, 'number');
                return;
            case 'list-bullet':
                this._applyMarker(view, 'bullet');
                return;
            case 'list-check':
                this._applyMarker(view, 'check');
        }
    }

    _keepTyping(view) {
        if (!view.note.locked && global.stage.get_key_focus() !== view.text) {
            view.editing = true;
            view.text.grab_key_focus();
        }
        this._syncRibbon(view);
    }

    // Style bits from the Markdown markers around the caret or selection.
    _toolBits(view) {
        const [start, end] = this._range(view);
        return markerStatesAt(view.note.text, start, end);
    }

    _syncRibbon(view) {
        if (!view.ribbon || !view.ribbon.actor.get_parent())
            return;
        const editing = view.editing && global.stage.get_key_focus() === view.text;
        const show = !view.note.locked && !view.previewMode && view.frame.visible && editing;
        const was = view.ribbon.visible();
        view.ribbon.setVisible(show);
        view.ribbon.setSize(Math.round(normalizeZoom(view.note.zoom ?? 100)));
        view.ribbon.setMarks(this._toolBits(view));
        view.ribbon.setList(markAt(view.note.text, this._range(view)[1]));
        if (was !== show)
            this._layout(view);
    }

    _showAttrs(view) {
        if (view.note.kind !== 'todo' && view.note.format !== 'markdown') {
            view.text.set_attributes(null);
            return;
        }
        const runs = attributeRuns(view.note.text, view.note.spans, view.note.sizes);
        if (!runs.length) {
            view.text.set_attributes(null);
            return;
        }
        const list = new Pango.AttrList();
        for (const run of runs)
            this._addRun(list, run);
        view.text.set_attributes(list);
        view.text.queue_relayout();
    }

    _addRun(list, run) {
        const add = attr => {
            attr.start_index = run.start;
            attr.end_index = run.end;
            list.insert(attr);
        };
        if (run.style & STYLE_BOLD)
            add(Pango.attr_weight_new(Pango.Weight.BOLD));
        if (run.style & STYLE_ITALIC)
            add(Pango.attr_style_new(Pango.Style.ITALIC));
        if (run.style & STYLE_UNDERLINE)
            add(Pango.attr_underline_new(Pango.Underline.SINGLE));
        if ((run.style & STYLE_STRIKE) || run.done)
            add(Pango.attr_strikethrough_new(true));
        if (run.done) {
            add(Pango.attr_foreground_new(PALE_INK[0], PALE_INK[1], PALE_INK[2]));
            add(Pango.attr_foreground_alpha_new(PALE_ALPHA));
        }
        if (run.size)
            add(Pango.attr_size_new(run.size * Pango.SCALE));
    }

    // A press on the grip or the corner holds a stage grab until the button
    // is released. Without it, once the cursor outruns the note the desktop
    // window under it receives the motion and the drag stalls.
    _onHandleEvent(view, mode, actor, event) {
        const type = event.type();
        const drag = this._drag;
        if (drag && drag.actor === actor) {
            if (type === Clutter.EventType.MOTION) {
                if (event.get_state() & Clutter.ModifierType.BUTTON1_MASK)
                    this._applyPointer(event);
                else
                    this._finishDrag();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                if (event.get_button() === BUTTON_PRIMARY)
                    this._finishDrag();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.SCROLL)
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === BUTTON_PRIMARY) {
            const source = global.stage.get_event_actor(event);
            // Interactive children (e.g. the board collapse toggle) keep
            // their own clicks.
            if (source !== actor && source instanceof St.Button)
                return Clutter.EVENT_PROPAGATE;
            this._beginDrag(view, mode, actor, event);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _beginDrag(view, mode, actor, event) {
        this._finishDrag();
        this._focus(view, false);
        const grab = global.stage.grab(actor);
        const [px, py] = event.get_coords();
        const cursor = mode === 'move'
            ? Clutter.CursorType.GRABBING
            : Clutter.CursorType.SE_RESIZE;
        if (mode === 'move')
            view.grip.cursor_type = cursor;
        // Shown while the pointer is ahead of the handle, until it catches up.
        const stageCursor = global.stage.cursor_type;
        global.stage.cursor_type = cursor;
        this._drag = {
            view,
            mode,
            actor,
            grab,
            stageCursor,
            originX: view.note.x,
            originY: view.note.y,
            originW: view.note.w,
            originH: view.note.h,
            pointerX: px,
            pointerY: py,
        };
    }

    _applyPointer(event) {
        const drag = this._drag;
        const [px, py] = event.get_coords();
        const dx = Math.round(px - drag.pointerX);
        const dy = Math.round(py - drag.pointerY);
        const note = drag.view.note;
        if (drag.mode === 'move') {
            note.x = drag.originX + dx;
            note.y = drag.originY + dy;
        } else {
            note.w = drag.originW + dx;
            note.h = drag.originH + dy;
        }
        this._clampNote(note);
        this._layout(drag.view);
    }

    _finishDrag() {
        const drag = this._drag;
        if (!drag)
            return;
        const view = drag.view;
        this._drag = null;
        drag.grab.dismiss();
        global.stage.cursor_type = drag.stageCursor;
        view.grip.cursor_type = Clutter.CursorType.GRAB;
        view.note.expanded_h = view.note.h;
        view.note.workspace = this._workspace();
        if (isImageNoteFormat(view.note.format))
            this._refreshPreview(view);
        this._scheduleSave();
    }

    _setColor(view, index) {
        view.note.color = index % PALETTE.length;
        view.note.custom_color = null;
        this._paint(view);
        if (view.previewMode)
            this._refreshPreview(view);
        this._scheduleSave();
    }

    _stepZoom(view, delta) {
        const current = normalizeZoom(view.note.zoom ?? 100);
        const next = Math.min(200, Math.max(5, current + delta));
        if (next === current)
            return;
        // Zoom scales only the written content. Header (grip/pill) and chrome stay fixed.
        view.note.zoom = next;
        this._paint(view);
        if (view.previewMode)
            this._refreshPreview(view);
        this._scheduleSave();
    }

    _copyNote(view) {
        const text = view.note.kind === 'todo'
            ? stripTodoGlyphs(view.note.text)
            : view.note.text;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    _externalAppsForView(view) {
        const groups = [];
        for (const contentType of contentTypesForFilename(view.note.filename)) {
            try {
                groups.push(Gio.AppInfo.get_all_for_type(contentType) ?? []);
            } catch (error) {
                console.warn(`Sticky Notes: cannot list applications for ${contentType}: ${error}`);
            }
        }
        return compatibleApps(groups);
    }

    _launchExternalEditor(view, app) {
        try {
            // Flush the latest edit before another process reads the file.
            this._write();
            const files = view.note.kind === 'todo' ? this._todoFiles : this._files;
            const file = files?.file(view.note.filename);
            if (!file?.query_exists(null))
                throw new Error('Note file does not exist');
            launchExternalApp(app, file);
        } catch (error) {
            const name = app?.get_display_name?.() ?? app?.get_name?.() ?? 'application';
            console.warn(`Sticky Notes: could not open ${view.note.filename} in ${name}: ${error}`);
        }
    }

    _duplicate(view) {
        if (view.note.kind !== 'note' || view.note.format !== 'markdown')
            return;
        const source = view.note;
        const areas = this._workAreas();
        const obstacles = this._store.notes.map(note => [note.x, note.y, note.w, note.h]);
        const [x, y] = freshOrigin(obstacles, areas, source.w, source.h, null, [source.x, source.y]);
        const id = this._store.next_id;
        this._store.next_id += 1;
        // Duplicate in the same folder as the original note
        const prefix = source.filename.includes('/')
            ? source.filename.slice(0, source.filename.lastIndexOf('/') + 1)
            : '';
        const note = {
            id,
            kind: 'note',
            format: 'markdown',
            filename: this._files.newFilename(prefix),
            pinned: source.pinned === true,
            x,
            y,
            w: source.w,
            h: source.h,
            expanded_h: source.h,
            color: source.color,
            size: source.size,
            locked: false,
            text: source.text,
            spans: source.spans.map(span => ({...span})),
            sizes: source.sizes.map(run => ({...run})),
            zoom: normalizeZoom(source.zoom ?? 100),
            custom_color: typeof source.custom_color === 'string' ? source.custom_color : null,
            expires: typeof source.expires === 'string' ? source.expires : null,
            workspace: this._workspace(),
        };
        this._clampNote(note);
        this._store.notes.push(note);
        this._mount(note, true);
        this._scheduleSave();
    }

    _togglePin(view) {
        view.note.pinned = !view.note.pinned;
        this._moveToLayer(view);
        this._paint(view);
        this._orderNote(view);
        this._scheduleSave();
    }

    _sortTodo(view) {
        const raw = stripTodoGlyphs(view.note.text);
        const sorted = sortTodoText(raw);
        if (sorted === raw)
            return;
        this._commitText(view, withTodoGlyphs(sorted), 0);
    }
    _refreshPreview(view) {
        console.log(`Sticky Notes: _refreshPreview for ${view.note.filename}, previewMode=${view.previewMode}, token will be ${view.renderToken + 1}`);
        if (!view.previewMode)
            return;
        for (const child of view.preview.get_children()) {
            view.preview.remove_child(child);
            child.destroy();
        }
        view.renderToken += 1;
        const token = view.renderToken;
        view.previewRows = [];
        try {
            if (isImageNoteFormat(view.note.format)) {
                this._addStickerPreview(view, token);
                return;
            }
            let render;
            if (view.note.kind === 'todo')
                render = renderTodo(view.note.text, toDateString(new Date()));
            else if (view.note.format === 'text')
                render = renderPlainText(view.note.text);
            else if (view.note.format === 'html')
                render = renderSafeHtml(view.note.text);
            else
                render = renderMarkdown(view.note.text);
            for (const row of render.rows)
                this._addPreviewRow(view, row, token);
        } catch (error) {
            console.warn(`Sticky Notes: could not render preview: ${error}`);
            const fallback = new St.Label({style_class: 'sticky-note-preview-line', x_expand: true});
            fallback.clutter_text.line_wrap = true;
            fallback.text = view.note.text;
            view.preview.add_child(fallback);
        }
    }

    // Preview font size derived from the note zoom; rows set it inline so
    // they stay correct after a zoom change without a stylesheet. Rows also
    // carry the ink color when the note uses a dark custom color.
    _previewStyle(view) {
        return `font-size: ${zoomFont(view.note.zoom ?? 100)}pt${view.customDark ? '; color: #f6f5f4' : ''};`;
    }

    _addPreviewRow(view, row, token) {
        const style = this._previewStyle(view);
        let actor = null;
        if (row.kind === 'text' || row.kind === 'block') {
            actor = new St.Label({
                style_class: row.kind === 'block' ? 'sticky-note-preview-block' : 'sticky-note-preview-line',
                style,
                x_expand: true,
                reactive: true,
            });
            actor.clutter_text.set_markup(row.pango);
            actor.clutter_text.line_wrap = row.kind === 'text';
            actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        } else if (row.kind === 'image') {
            actor = this._buildImageRow(view, row, token, style);
        } else if (row.kind === 'diagram') {
            actor = this._buildDiagramRow(view, row, token, style);
        }
        if (!actor)
            return;
        // The preview-level capture handler is the fast path. A direct row
        // handler is a fallback for Shell/Clutter versions where a gesture on
        // the surrounding scroll view prevents that capture path from seeing
        // the final button event.
        if (row.todo || row.box || row.links?.length > 0) {
            actor.connectObject('button-press-event', (_actor, event) =>
                this._onPreviewRowPress(view, row, actor, event), this);
        }
        view.previewRows.push(row);
        view.preview.add_child(actor);
    }

    _imageMaxWidth(view) {
        return Math.max(48, view.note.w - 40);
    }

    _cacheDir(kind) {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'markdown-sticky-notes', kind]);
    }

    _sha256(text) {
        const checksum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
        checksum.update(new TextEncoder().encode(text));
        return checksum.get_string();
    }

    // Resolve an image source to a local path or remote URL. Relative
    // paths resolve against the note's directory inside the notes root.
    _resolveImageSrc(view, src) {
        const raw = String(src ?? '').trim();
        if (!raw)
            return null;
        if (raw.startsWith('~') || raw.startsWith('/') || raw.startsWith('file://')) {
            const path = raw.startsWith('file://')
                ? Gio.File.new_for_uri(raw).get_path()
                : expandNotePath(raw);
            return path ? {path} : null;
        }
        if (/^https?:\/\//i.test(raw))
            return {url: raw};
        const root = this._files?.directory
            ?? GLib.build_filenamev([GLib.get_home_dir(), 'notes']);
        const sub = view.note.filename.includes('/')
            ? GLib.path_get_dirname(view.note.filename)
            : '';
        const resolved = GLib.canonicalize_filename(
            GLib.build_filenamev([root, sub, raw]), null);
        return {path: resolved};
    }

    // Show a local image file in the row, replacing the alt placeholder.
    _showImageFile(view, box, placeholder, path, maxWidth, token,
        maxHeight = 1200, quiet = false) {
        if (token !== view.renderToken || !box.get_parent())
            return;
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                path, Math.max(1, maxWidth), Math.max(1, maxHeight), true);
            const width = pixbuf.get_width();
            const height = pixbuf.get_height();
            const hasAlpha = pixbuf.get_has_alpha();
            if (placeholder.get_parent() === box)
                box.remove_child(placeholder);
            placeholder.destroy();
            // Use Clutter.TextureContent with Gdk.Texture (GDK 4 paintable API)
            const gdkTexture = Gdk.Texture.new_for_pixbuf(pixbuf);
            const widget = new St.Widget({
                style_class: 'sticky-note-image-pic',
                width, height,
                reactive: true,
                accessible_name: 'image',
            });
            const content = new Clutter.TextureContent();
            content.texture = gdkTexture;
            widget.set_content(content);
            box.add_child(widget);
            box._imageWidget = widget;
            box._imageHasAlpha = hasAlpha;
            box._imageWidth = width;
            box._imageHeight = height;
            return true;
        } catch (error) {
            // A broken image never breaks the preview; keep the alt text.
            if (!quiet)
                console.warn(`Sticky Notes: could not load image ${path}: ${error}`);
            box._imageError = `${error}`;
            return false;
        }
    }

    _addStickerPreview(view, token) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-image-sticker-content',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const placeholder = new St.Label({
            style_class: 'sticky-image-placeholder',
            text: t('Invalid image'),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        placeholder.clutter_text.line_wrap = true;
        box.add_child(placeholder);
        const path = view.note.sourcePath ?? this._files?.file(view.note.filename)?.get_path();
        const maxWidth = Math.max(1, view.note.w - 8);
        const maxHeight = Math.max(1, view.note.h - HEADER_H - 8);
        view.stickerContent = box;
        view.preview.add_child(box);
        if (path)
            console.log(`Sticky Notes: loading sticker ${path} into ${maxWidth}x${maxHeight}`);
        const loaded = path
            ? this._showImageFile(view, box, placeholder, path, maxWidth, token, maxHeight, true)
            : false;
        if (!loaded)
            box.add_style_class_name('invalid');
    }

    _buildImageRow(view, row, token, style) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-note-image',
            style,
            x_expand: true,
            reactive: true,
        });
        const placeholder = new St.Label({
            style_class: 'sticky-note-image-alt',
            style,
            x_expand: true,
            text: row.alt || row.src,
        });
        placeholder.clutter_text.line_wrap = true;
        box.add_child(placeholder);
        const resolved = this._resolveImageSrc(view, row.src);
        const maxWidth = this._imageMaxWidth(view);
        if (resolved?.path) {
            this._showImageFile(view, box, placeholder, resolved.path, maxWidth, token);
        } else if (resolved?.url) {
            const cached = this._imageCachePath(resolved.url);
            if (GLib.file_test(cached, GLib.FileTest.EXISTS)) {
                this._showImageFile(view, box, placeholder, cached, maxWidth, token);
            } else {
                placeholder.text = t('Loading image…');
                this._downloadImage(view, resolved.url, cached, box, placeholder, maxWidth, token, row.alt);
            }
        } else {
            placeholder.text = row.alt || row.src;
        }
        return box;
    }

    _imageCachePath(url) {
        const ext = /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.exec(url)?.[1]?.toLowerCase() ?? 'img';
        return GLib.build_filenamev([this._cacheDir('images'), `${this._sha256(url)}.${ext}`]);
    }

    async _downloadImage(view, url, cached, box, placeholder, maxWidth, token, alt = '') {
        try {
            // libsoup is optional: remote images just fail when it is missing.
            const soup = await import('gi://Soup');
            const Soup = soup.default;
            const uri = GLib.Uri.new(url);
            if (!uri)
                throw new Error('invalid URL');
            const session = new Soup.Session({timeout: 15});
            const message = new Soup.Message({method: 'GET', uri});
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    if (token !== view.renderToken || !box.get_parent())
                        return;
                    const bytes = sess.send_and_read_finish(result);
                    const status = message.get_status();
                    const headers = message.get_response_headers();
                    const type = (headers?.get_one('Content-Type') ?? '').toLowerCase();
                    const size = bytes?.get_size() ?? 0;
                    if (status !== Soup.Status.OK || size === 0 || size > 10 * 1024 * 1024)
                        throw new Error(`download failed (HTTP ${status})`);
                    if (type && !type.startsWith('image/'))
                        throw new Error('not an image');
                    GLib.mkdir_with_parents(GLib.path_get_dirname(cached), 0o755);
                    const bytesData = bytes.get_data();
                    Gio.File.new_for_path(cached).replace_contents(
                        new Uint8Array(bytesData), null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    this._showImageFile(view, box, placeholder, cached, maxWidth, token);
                } catch (error) {
                    console.warn(`Sticky Notes: could not download ${url}: ${error}`);
                    if (token === view.renderToken && box.get_parent())
                        placeholder.text = `![${alt || 'image'}](${url})`;
                }
            });
        } catch (error) {
            console.warn(`Sticky Notes: libsoup is not available for remote images: ${error}`);
            if (token === view.renderToken && box.get_parent())
                placeholder.text = url;
        }
    }

    _buildDiagramRow(view, row, token, style) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-note-diagram',
            style,
            x_expand: true,
            reactive: true,
        });
        const code = new St.Label({
            style_class: 'sticky-note-preview-block',
            style,
            x_expand: true,
            reactive: true,
        });
        code.clutter_text.line_wrap = false;
        code.clutter_text.set_markup(
            row.code.split('\n').map(line => `<tt>${this._escapeText(line)}</tt>`).join('\n'));
        box.add_child(code);
        if (row.lang === 'dot')
            this._renderDot(view, row, box, code, token);
        else
            this._renderMermaid(view, row, box, code, token);
        return box;
    }

    _escapeText(text) {
        return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
    }

    _diagramPath(view, row) {
        return GLib.build_filenamev(
            [this._cacheDir('diagrams'), `${this._sha256(`${row.lang}:${row.code}`)}.svg`]);
    }

    _swapToImage(view, box, codeLabel, imagePath, maxWidth, token, maxHeight = 600) {
        this._showImageFile(view, box, codeLabel, imagePath, maxWidth, token);
        if (token !== view.renderToken || !box.get_parent())
            return;
        // The SVG is laid out with a capped height.
        for (const child of box.get_children()) {
            if (child.style_class === 'sticky-note-image-pic' && child.height > maxHeight)
                child.height = maxHeight;
        }
    }

    _renderDot(view, row, box, codeLabel, token) {
        const dot = GLib.find_program_in_path('dot');
        const hint = (text) => this._appendDiagramHint(box, text);
        if (!dot) {
            hint(t('Install graphviz to render this diagram'));
            return;
        }
        const out = this._diagramPath(view, row);
        GLib.mkdir_with_parents(GLib.path_get_dirname(out), 0o755);
        if (GLib.file_test(out, GLib.FileTest.EXISTS)) {
            this._swapToImage(view, box, codeLabel, out, this._imageMaxWidth(view), token);
            return;
        }
        const proc = new Gio.Subprocess({
            argv: [dot, '-Tsvg', '-o', out],
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDERR_PIPE |
                   Gio.SubprocessFlags.STDOUT_SILENCE,
        });
        try {
            proc.init(null);
        } catch (error) {
            hint(`${t('Could not render diagram')}: ${error.message ?? error}`);
            return;
        }
        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            try {
                proc.force_exit();
            } catch (_error) {
                // Already exited.
            }
            return GLib.SOURCE_REMOVE;
        });
        proc.communicate_utf8_async(row.code, null, (subprocess, result) => {
            GLib.Source.remove(timeoutId);
            try {
                if (token !== view.renderToken || !box.get_parent())
                    return;
                const [, , stderr] = subprocess.communicate_utf8_finish(result);
                if (subprocess.get_successful() && GLib.file_test(out, GLib.FileTest.EXISTS)) {
                    this._swapToImage(view, box, codeLabel, out, this._imageMaxWidth(view), token);
                    return;
                }
                const message = (stderr ?? '').trim().split('\n')[0]?.slice(0, 120);
                hint(message ? `${t('Could not render diagram')}: ${message}` : t('Could not render diagram'));
            } catch (error) {
                if (token === view.renderToken && box.get_parent())
                    hint(`${t('Could not render diagram')}: ${error.message ?? error}`);
            }
        });
    }

    _renderMermaid(view, row, box, codeLabel, token) {
        const mmdc = GLib.find_program_in_path('mmdc');
        const hint = (text) => this._appendDiagramHint(box, text);
        if (!mmdc) {
            hint(t('Install @mermaid-js/mermaid-cli to render this Mermaid diagram'));
            return;
        }
        const out = this._diagramPath(view, row);
        GLib.mkdir_with_parents(GLib.path_get_dirname(out), 0o755);
        if (GLib.file_test(out, GLib.FileTest.EXISTS)) {
            this._swapToImage(view, box, codeLabel, out, this._imageMaxWidth(view), token);
            return;
        }
        const temp = GLib.build_filenamev([GLib.get_tmp_dir(), `mermaid-${this._sha256(row.code)}.mmd`]);
        GLib.file_set_contents(temp, row.code);
        const proc = new Gio.Subprocess({
            argv: [mmdc, '-i', temp, '-o', out, '-b', 'transparent'],
            flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        try {
            proc.init(null);
        } catch (error) {
            try {
                Gio.File.new_for_path(temp).delete(null);
            } catch (_error) {
                // Best effort.
            }
            hint(`${t('Could not render diagram')}: ${error.message ?? error}`);
            return;
        }
        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            try {
                proc.force_exit();
            } catch (_error) {
                // Already exited.
            }
            return GLib.SOURCE_REMOVE;
        });
        proc.communicate_utf8_async(null, null, (subprocess, result) => {
            GLib.Source.remove(timeoutId);
            try {
                Gio.File.new_for_path(temp).delete(null);
            } catch (_error) {
                // Best effort.
            }
            try {
                if (token !== view.renderToken || !box.get_parent())
                    return;
                const [, , stderr] = subprocess.communicate_utf8_finish(result);
                if (subprocess.get_successful() && GLib.file_test(out, GLib.FileTest.EXISTS)) {
                    this._swapToImage(view, box, codeLabel, out, this._imageMaxWidth(view), token);
                    return;
                }
                const message = (stderr ?? '').trim().split('\n')[0]?.slice(0, 120);
                hint(message ? `${t('Could not render diagram')}: ${message}` : t('Could not render diagram'));
            } catch (error) {
                if (token === view.renderToken && box.get_parent())
                    hint(`${t('Could not render diagram')}: ${error.message ?? error}`);
            }
        });
    }

    _appendDiagramHint(box, text) {
        const hint = new St.Label({
            style_class: 'sticky-note-diagram-hint',
            x_expand: true,
            text,
        });
        hint.clutter_text.line_wrap = true;
        box.add_child(hint);
    }

    _togglePreview(view) {
        if (view.previewOnly)
            return;
        view.previewMode = !view.previewMode;
        // When user explicitly chooses edit mode, suppress auto-preview until
        // they edit again (key-press clears the flag).
        if (!view.previewMode)
            view._userChoseEditMode = true;
        if (view.previewMode) {
            if (global.stage.get_key_focus() === view.text)
                global.stage.set_key_focus(null);
            this._refreshPreview(view);
        }
        view.text.visible = !view.previewMode;
        view.preview.visible = view.previewMode;
        this._syncRibbon(view);
        this._layout(view);
        if (!view.previewMode)
            this._focusLater(view);
    }

    // Losing focus automatically switches the note to the preview. Editing
    // comes back via the menu (Edit Markdown) or double-clicking the note.
    _autoPreview(view) {
        if (view.previewMode || (view.note.kind ?? 'note') !== 'note')
            return;
        // Suppress auto-preview while the text-edit menu is open for this view.
        // The menu steals key focus from view.text; without this guard,
        // key-focus-out would hide view.text and switch to preview mode.
        if (view._inTextEditMenu || view._inNoteMenu)
            return;
        // Respect explicit user choice: if they toggled to edit mode, don't
        // auto-preview until they start editing again.
        if (view._userChoseEditMode)
            return;
        view.previewMode = true;
        this._refreshPreview(view);
        view.text.visible = false;
        view.preview.visible = true;
        this._layout(view);
    }

    // The shell does not always steal the stage key focus for an ordinary
    // application window, so the window-focus signal is the reliable
    // indicator that the user left the note.
    _onFocusWindow() {
        if (this._focused)
            this._blur();
    }

    _toggleLock(view) {
        view.note.locked = !view.note.locked;
        this._paint(view);
        if (view.note.locked && global.stage.get_key_focus() === view.text)
            global.stage.set_key_focus(null);
        this._scheduleSave();
    }

    _setExpiry(view, date) {
        view.note.expires = expiresToFrontmatter(date);
        this._updateExpiryBadge(view);
        this._scheduleSave();
    }

    _clearExpiry(view) {
        view.note.expires = null;
        this._updateExpiryBadge(view);
        this._scheduleSave();
    }

    // Shared color swatch grid for note and board context menus.
    _addColorSwatches(menu, view) {
        const colors = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-note-colors',
            x_expand: true,
        });
        colors.add_child(new St.Label({
            text: t('Color'),
            style_class: 'sticky-note-caption',
            x_align: Clutter.ActorAlign.START,
        }));
        const custom = view.note.custom_color ? resolveNameToColor(view.note.custom_color) : null;
        for (const row of [SWATCH_ORDER.slice(0, 8), SWATCH_ORDER.slice(8)]) {
            const line = new St.BoxLayout({
                style_class: 'sticky-swatch-row',
                x_align: Clutter.ActorAlign.CENTER,
            });
            for (const index of row) {
                const name = PALETTE[index];
                const button = new St.Button({
                    style_class: `sticky-swatch ${name}${!custom && index === view.note.color ? ' current' : ''}`,
                    width: 22,
                    height: 22,
                    can_focus: true,
                    accessible_name: t(COLOR_LABELS[name]),
                });
                button.connectObject('clicked', () => {
                    this._setColor(view, index);
                    this._markCurrent(colors, view);
                }, this);
                line.add_child(button);
            }
            colors.add_child(line);
        }
        // Arbitrary color: the last ball opens an inline picker.
        const customRow = new St.BoxLayout({
            style_class: 'sticky-swatch-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const customButton = new St.Button({
            style_class: `sticky-swatch sticky-swatch-custom${custom ? ' current' : ''}`,
            width: 22,
            height: 22,
            can_focus: true,
            accessible_name: t('Custom color'),
        });
        customButton.add_child(new St.Icon({
            icon_name: 'color-picker-symbolic',
            icon_size: 14,
            style_class: 'sticky-swatch-dropper',
        }));
        if (custom)
            customButton.style = `background-color: ${custom};`;
        customButton.connectObject('clicked', () => this._toggleColorEditor(menu, view, customButton, colors), this);
        customRow.add_child(customButton);
        colors.add_child(customRow);
        menu.box.add_child(colors);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    // Inline custom-color editor: NameToColor accepts hexadecimal values,
    // color names, moods and arbitrary deterministic text.
    _toggleColorEditor(menu, view, customButton, colors) {
        const existing = menu.box.get_children().find(child =>
            child.has_style_class_name?.('sticky-swatch-editor'));
        if (existing) {
            menu.box.remove_child(existing);
            existing.destroy();
            return;
        }
        const editor = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'sticky-swatch-editor',
            x_expand: true,
        });
        const entry = new St.Entry({
            style_class: 'sticky-swatch-entry',
            x_expand: true,
            can_focus: true,
            hint_text: '#RRGGBB, blue, calma…',
        });
        const preview = new St.Widget({
            style_class: 'sticky-swatch-preview',
            width: 22,
            height: 22,
        });
        const apply = new St.Button({
            style_class: 'sticky-swatch-apply',
            can_focus: true,
            label: '✓',
            accessible_name: t('Apply'),
        });
        const applyColor = () => {
            const expression = entry.get_text().trim();
            if (!resolveNameToColor(expression))
                return; // Invalid input: nothing happens.
            this._setCustomColor(view, expression);
            this._markCurrent(colors, view);
        };
        const entryText = entry.get_clutter_text();
        entryText.connectObject('text-changed', () => {
            const normalized = resolveNameToColor(entry.get_text());
            preview.style = normalized ? `background-color: ${normalized};` : '';
        }, this);
        entryText.connectObject('activate', applyColor, this);
        apply.connectObject('clicked', applyColor, this);
        editor.add_child(entry);
        editor.add_child(preview);
        editor.add_child(apply);
        // Insert the editor right after the color swatches so it is visible.
        const colorsIndex = menu.box.get_children().indexOf(colors);
        if (colorsIndex >= 0)
            menu.box.insert_child_at_index(editor, colorsIndex + 1);
        else
            menu.box.add_child(editor);
        const seeded = view.note.custom_color ? resolveNameToColor(view.note.custom_color) : null;
        if (seeded) {
            entry.text = view.note.custom_color;
            preview.style = `background-color: ${seeded};`;
        }
        editor._entry = entry;
        editor._preview = preview;
        editor._applyButton = apply;
        entry.grab_key_focus();
    }

    _setCustomColor(view, expression) {
        view.note.custom_color = expression;
        this._paint(view);
        if (view.previewMode)
            this._refreshPreview(view);
        this._scheduleSave();
    }

    // Compact icon button for the 3-row context-menu grid.
    _mkMenuButton(icon, name, fn, sensitive = true) {
        const button = new St.Button({
            style_class: `sticky-menu-btn${sensitive ? '' : ' insensitive'}`,
            can_focus: true,
            accessible_name: name,
            reactive: sensitive,
        });
        button.add_child(new St.Icon({
            icon_name: icon,
            icon_size: 16,
            style_class: 'sticky-menu-icon',
        }));
        if (sensitive)
            button.connectObject('clicked', () => fn(), this);
        return button;
    }

    // Button that expands a calendar built entirely from Shell actors. GTK
    // widgets cannot be embedded in the GNOME Shell St/Clutter actor tree.
    _buildExpiryEditor(view) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-menu-expiry',
            x_expand: true,
        });
        const expires = parseExpires(view.note.expires);
        const editorRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'expiry-editor',
            x_expand: true,
        });
        const icon = new St.Label({text: '⌛', style_class: 'expiry-icon'});
        const dateLabel = new St.Label({
            text: expires ? formatExpires(expires) : t('Set expiry'),
            x_align: Clutter.ActorAlign.START,
        });
        const dateButton = new St.Button({
            style_class: 'sticky-expiry-button',
            can_focus: true,
            x_expand: true,
            accessible_name: t('Choose expiry date'),
        });
        dateButton.add_child(dateLabel);
        const clearBtn = new St.Button({
            style_class: `sticky-swatch-apply${expires ? '' : ' insensitive'}`,
            can_focus: true,
            reactive: !!expires,
            label: '✕',
            accessible_name: t('Clear expiry'),
        });
        const setClearEnabled = enabled => {
            clearBtn.reactive = enabled;
            if (enabled)
                clearBtn.remove_style_class_name('insensitive');
            else
                clearBtn.add_style_class_name('insensitive');
        };
        let calendar = null;
        const applyDate = date => {
            this._setExpiry(view, date);
            dateLabel.text = formatExpires(date);
            setClearEnabled(true);
            calendar?.setDate(date);
        };
        const initialDate = expires ?? new Date();
        initialDate.setSeconds(0, 0);
        calendar = this._buildExpiryCalendar(initialDate, applyDate);
        calendar.actor.visible = false;
        dateButton.connectObject('clicked', () => {
            calendar.actor.visible = !calendar.actor.visible;
        }, this);
        clearBtn.connectObject('clicked', () => {
            this._clearExpiry(view);
            dateLabel.text = t('Set expiry');
            setClearEnabled(false);
        }, this);
        editorRow.add_child(icon);
        editorRow.add_child(dateButton);
        editorRow.add_child(clearBtn);
        box.add_child(editorRow);
        box.add_child(calendar.actor);
        const presetRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'sticky-menu-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        presetRow.add_child(this._mkMenuButton('alarm-symbolic', t('In 1 hour'),
            () => applyDate(new Date(Date.now() + 3600e3))));
        presetRow.add_child(this._mkMenuButton('alarm-symbolic', t('Tomorrow 09:00'), () => {
            const date = new Date();
            date.setDate(date.getDate() + 1);
            date.setHours(9, 0, 0, 0);
            applyDate(date);
        }));
        presetRow.add_child(this._mkMenuButton('alarm-symbolic', t('In 1 week'),
            () => applyDate(new Date(Date.now() + 7 * 86400e3))));
        box.add_child(presetRow);
        box._dateButton = dateButton;
        box._clearButton = clearBtn;
        box._calendar = calendar;
        box._presetRow = presetRow;
        return box;
    }

    _buildExpiryCalendar(initialDate, onChange) {
        let selected = new Date(initialDate);
        let shown = new Date(selected.getFullYear(), selected.getMonth(), 1);
        const actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-expiry-calendar',
            x_expand: true,
        });
        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'sticky-calendar-header',
            x_expand: true,
        });
        const monthLabel = new St.Label({
            style_class: 'sticky-calendar-month',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const previous = this._mkMenuButton(
            'go-previous-symbolic', t('Previous month'), () => {
                shown = new Date(shown.getFullYear(), shown.getMonth() - 1, 1);
                rebuild();
            });
        const next = this._mkMenuButton(
            'go-next-symbolic', t('Next month'), () => {
                shown = new Date(shown.getFullYear(), shown.getMonth() + 1, 1);
                rebuild();
            });
        header.add_child(previous);
        header.add_child(monthLabel);
        header.add_child(next);
        actor.add_child(header);

        const weekdays = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'sticky-calendar-week',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const weekStart = Shell.util_get_week_start?.() ?? 0;
        const weekdayFormat = new Intl.DateTimeFormat(undefined, {weekday: 'narrow'});
        for (let column = 0; column < 7; column++) {
            const weekday = (weekStart + column) % 7;
            const date = new Date(2023, 0, 1 + weekday);
            weekdays.add_child(new St.Label({
                text: weekdayFormat.format(date),
                style_class: 'sticky-calendar-weekday',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        actor.add_child(weekdays);

        const days = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-calendar-days',
            x_align: Clutter.ActorAlign.CENTER,
        });
        actor.add_child(days);
        const timeLabel = new St.Label({
            style_class: 'sticky-calendar-time',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const sameDay = (left, right) => left.getFullYear() === right.getFullYear() &&
            left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
        const commit = date => {
            selected = new Date(date);
            selected.setSeconds(0, 0);
            shown = new Date(selected.getFullYear(), selected.getMonth(), 1);
            onChange(new Date(selected));
            rebuild();
        };
        const adjustMinutes = amount => {
            const date = new Date(selected);
            date.setMinutes(date.getMinutes() + amount);
            commit(date);
        };
        const timeButton = (label, name, amount) => {
            const button = new St.Button({
                style_class: 'sticky-calendar-time-button',
                can_focus: true,
                label,
                accessible_name: name,
            });
            button.connectObject('clicked', () => adjustMinutes(amount), this);
            return button;
        };
        const timeRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'sticky-calendar-time-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        timeRow.add_child(timeButton('−1h', t('One hour earlier'), -60));
        timeRow.add_child(timeButton('−15', t('Fifteen minutes earlier'), -15));
        timeRow.add_child(timeLabel);
        timeRow.add_child(timeButton('+15', t('Fifteen minutes later'), 15));
        timeRow.add_child(timeButton('+1h', t('One hour later'), 60));
        actor.add_child(timeRow);

        const monthFormat = new Intl.DateTimeFormat(undefined, {month: 'long', year: 'numeric'});
        const fullDateFormat = new Intl.DateTimeFormat(undefined, {dateStyle: 'full'});
        const today = new Date();
        const rebuild = () => {
            monthLabel.text = monthFormat.format(shown);
            timeLabel.text = formatExpires(selected).slice(-5);
            for (const child of days.get_children())
                child.destroy();
            const offset = (new Date(shown.getFullYear(), shown.getMonth(), 1).getDay() -
                weekStart + 7) % 7;
            const first = new Date(shown.getFullYear(), shown.getMonth(), 1 - offset);
            for (let rowIndex = 0; rowIndex < 6; rowIndex++) {
                const row = new St.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    style_class: 'sticky-calendar-week',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                for (let column = 0; column < 7; column++) {
                    const date = new Date(first);
                    date.setDate(first.getDate() + rowIndex * 7 + column);
                    date.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
                    const classes = ['sticky-calendar-day'];
                    if (date.getMonth() !== shown.getMonth())
                        classes.push('other-month');
                    if (sameDay(date, today))
                        classes.push('today');
                    if (sameDay(date, selected))
                        classes.push('selected');
                    const button = new St.Button({
                        style_class: classes.join(' '),
                        can_focus: true,
                        label: `${date.getDate()}`,
                        accessible_name: fullDateFormat.format(date),
                    });
                    button._date = date;
                    button.connectObject('clicked', () => commit(date), this);
                    row.add_child(button);
                }
                days.add_child(row);
            }
        };
        rebuild();
        return {
            actor,
            get selectedDate() {
                return new Date(selected);
            },
            setDate(date) {
                selected = new Date(date);
                selected.setSeconds(0, 0);
                shown = new Date(selected.getFullYear(), selected.getMonth(), 1);
                rebuild();
            },
        };
    }



    // Build a popup menu for selecting/creating categories.
// Shows existing categories + an entry for typing a new one (with / for subcategories).
    _buildCategoryPicker(view, run) {
        const categories = this._getAllCategories();
        const currentCategory = categoryPartsFromRelpath(view.note.filename).join('/');

        // Create the popup menu
        const menu = new PopupMenu.PopupMenu(view.grip, 0.0, St.Side.TOP);
        menu.actor.add_style_class_name('sticky-category-picker');
        menu.actor.style = 'min-width: 280px;';

        // Entry for new category at the top
        const entry = new St.Entry({
            style_class: 'sticky-category-entry',
            x_expand: true,
            can_focus: true,
            hint_text: t('Type category or subcategory (pasta/subpasta)'),
        });
        entry.text = currentCategory;
        const entryItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        entryItem.actor.add_child(entry);
        entryItem.actor.style = 'padding: 8px 12px;';
        menu.addMenuItem(entryItem);

        // Separator
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // "No category" option
        const noCatItem = new PopupMenu.PopupMenuItem(t('(no category)'));
        noCatItem.actor.style = currentCategory === '' ? 'font-weight: bold;' : '';
        noCatItem.connectObject('activate', () => {
            run(() => this._applyCategory(view, ''));
            menu.close({animate: false});
        }, this);
        menu.addMenuItem(noCatItem);

        // Existing categories
        if (categories.length) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (const cat of categories) {
                const catItem = new PopupMenu.PopupMenuItem(cat.replace(/\//g, ' / '));
                catItem.actor.style = cat === currentCategory ? 'font-weight: bold;' : '';
                catItem.connectObject('activate', () => {
                    run(() => this._applyCategory(view, cat));
                    menu.close({animate: false});
                }, this);
                menu.addMenuItem(catItem);
            }
        }

        // Handle entry activation
        entry.get_clutter_text().connectObject('activate', () => {
            const category = entry.get_text().trim();
            run(() => this._applyCategory(view, category));
            menu.close({animate: false});
        }, this);

        // Focus the entry when menu opens
        menu.actor.connect('notify::open-state', () => {
            if (menu.isOpen) {
                entry.grab_key_focus();
                // Select all text for easy replacement
                entry.get_clutter_text().select_all();
            }
        });

        // Register with menuManager so it participates in menu management
        Main.layoutManager.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (_menu, open) => {
            if (!open) {
                this._menuManager.removeMenu(_menu);
                Main.layoutManager.uiGroup.remove_child(_menu.actor);
            }
        });

        return menu;
    }

    _buildExternalEditorChooser(view, run) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-external-editors',
            x_expand: true,
        });
        const apps = this._externalAppsForView(view);
        if (!apps.length) {
            box.add_child(new St.Label({
                text: t('No compatible applications'),
                style_class: 'sticky-note-caption',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        for (const app of apps) {
            const name = app.get_display_name?.() ?? app.get_name?.() ?? t('Application');
            const button = new St.Button({
                style_class: 'sticky-external-editor',
                can_focus: true,
                reactive: true,
                accessible_name: name,
                x_expand: true,
            });
            const content = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'sticky-external-editor-content',
                x_expand: true,
            });
            const gicon = app.get_icon?.();
            content.add_child(gicon
                ? new St.Icon({gicon, icon_size: 16})
                : new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 16}));
            content.add_child(new St.Label({
                text: name,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            button.add_child(content);
            button.connectObject('clicked', () => run(() => this._launchExternalEditor(view, app)), this);
            box.add_child(button);
        }
        box._apps = apps;
        return box;
    }

    _openMenu(view) {
        this._closeMenu();
        // Opening the menu of another note leaves the note being edited.
        // Opening this note's own menu must not silently force preview mode.
        view._inNoteMenu = true;
        if (this._focused !== view && global.stage.get_key_focus() !== view.text)
            this._blur();
        this._focus(view, false);
        const menu = new PopupMenu.PopupMenu(view.grip, 0.0, St.Side.TOP);
        const isTodo = view.note.kind === 'todo';
        const kind = view.note.kind ?? 'note';
        const isImage = isImageNoteFormat(view.note.format);
        if (!isImage)
            this._addColorSwatches(menu, view);
        const run = fn => {
            this._menuThen = fn;
            if (this._menu?.isOpen)
                this._menu.close({animate: false});
            else {
                this._menuThen = null;
                fn();
            }
        };
        // Rectangular grid of icon buttons in 3 rows (replaces the long list).
        const grid = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-menu-grid',
            x_expand: true,
        });
        let expiryRow = null;
        const externalEditorRow = this._buildExternalEditorChooser(view, run);
        externalEditorRow.visible = false;
        if (kind === 'note') {
            expiryRow = this._buildExpiryEditor(view);
            expiryRow.visible = false;
        }
        const addRow = (...buttons) => {
            const row = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'sticky-menu-row',
                x_align: Clutter.ActorAlign.CENTER,
            });
            for (const button of buttons)
                if (button)
                    row.add_child(button);
            grid.add_child(row);
        };
        let previewLabel;
        if (isTodo)
            previewLabel = view.previewMode ? 'Edit tasks' : 'Preview tasks';
        else if (view.note.format === 'text')
            previewLabel = view.previewMode ? 'Edit text' : 'Preview text';
        else if (view.note.format === 'html')
            previewLabel = view.previewMode ? 'Edit HTML source' : 'Preview HTML';
        else
            previewLabel = view.previewMode ? 'Edit Markdown' : 'Preview Markdown';
        // Row 1: create, duplicate, copy, preview
        addRow(
            this._mkMenuButton('document-new-symbolic', t('New note'), () => run(() => this._create(null))),
            !isImage
                ? this._mkMenuButton('view-dual-symbolic', t('Duplicate'),
                    () => run(() => this._duplicate(view)), !isTodo && view.note.format === 'markdown')
                : null,
            !isImage
                ? this._mkMenuButton('edit-copy-symbolic', t('Copy note'),
                    () => run(() => this._copyNote(view)))
                : null,
            !isImage
                ? this._mkMenuButton(
                    view.previewMode ? 'document-edit-symbolic' : 'document-preview-symbolic',
                    t(previewLabel), () => run(() => this._togglePreview(view)))
                : null,
        );
        // Row 2: pin, lock, category (or sort for TODO), expiry
        addRow(
            this._mkMenuButton(view.note.pinned ? 'window-restore-symbolic' : 'view-pin-symbolic',
                t(view.note.pinned ? 'Unpin note' : 'Pin above windows'),
                () => run(() => this._togglePin(view))),
            !isImage
                ? this._mkMenuButton(
                    view.note.locked ? 'changes-prevent-symbolic' : 'changes-allow-symbolic',
                    t(view.note.locked ? 'Unlock' : 'Lock'),
                    () => run(() => this._toggleLock(view)))
                : null,
            kind === 'note'
                ? this._mkMenuButton('folder-symbolic', t('Category'),
                    () => {
                        const picker = this._buildCategoryPicker(view, run);
                        picker.open({animate: false});
                    })
                : this._mkMenuButton('view-sort-descending-symbolic', t('Sort tasks'),
                    () => run(() => this._sortTodo(view))),
            kind === 'note'
                ? this._mkMenuButton('alarm-symbolic', t('Expiry'), () => {
                    expiryRow.visible = !expiryRow.visible;
                    if (expiryRow.visible) {
                        externalEditorRow.visible = false;
                    }
                })
                : null,
        );
        // Row 3: zoom out, zoom level, zoom in, delete
        const zoomLabel = isImage ? null : new St.Label({
            text: `${view.note.zoom ?? 100}%`,
            style_class: 'sticky-menu-zoom-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        addRow(
            !isImage
                ? this._mkMenuButton('zoom-out-symbolic', t('Zoom out'),
                    () => run(() => this._stepZoom(view, -10)))
                : null,
            zoomLabel,
            !isImage
                ? this._mkMenuButton('zoom-in-symbolic', t('Zoom in'),
                    () => run(() => this._stepZoom(view, 10)))
                : null,
            this._mkMenuButton('document-open-symbolic', t('Edit in'), () => {
                externalEditorRow.visible = !externalEditorRow.visible;
                if (externalEditorRow.visible) {
                    if (expiryRow)
                        expiryRow.visible = false;
                }
            }),
            this._mkMenuButton('edit-delete-symbolic', t('Delete'), () => run(() => this._delete(view)), !isTodo),
        );
        menu.box.add_child(grid);
        if (expiryRow)
            grid.add_child(expiryRow);
        grid.add_child(externalEditorRow);
        menu._actionGrid = grid;
        menu._expiryEditor = expiryRow;
        menu._externalEditorChooser = externalEditorRow;
        this._finishMenu(menu, view);
    }

    // Shared menu tail: remember the menu and wire its close signal.
    _finishMenu(menu, view) {
        this._menu = menu;
        this._menuView = view;
        this._menuId = menu.connect('open-state-changed', (_menu, open) => {
            if (!open)
                this._scheduleMenuDrop();
        });
        Main.layoutManager.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        const opened = menu.open({animate: false});
        if (opened === false)
            console.warn('Sticky Notes: context menu could not be opened');
    }

    // Context menu for text editing (Cut/Copy/Paste/Select All) in edit mode.
    _openTextEditMenu(view, _event) {
        this._closeMenu();
        this._focus(view, false);
        // Anchor to view.grip (not view.text) so the menu's source actor
        // is never hidden. The menu still steals key focus from view.text,
        // but the _inTextEditMenu guard prevents _autoPreview from hiding
        // view.text and switching to preview mode.
        view._inTextEditMenu = true;
        const menu = new PopupMenu.PopupMenu(view.grip, 0.0, St.Side.TOP);
        const text = view.text;
        const hasSelection = text.get_selection().length > 0;
        const clipboard = St.Clipboard.get_default();
        const later = fn => {
            this._menuThen = fn;
        };

        menu.addAction(t('Cut'), () => later(() => this._cutTextSelection(view)), 'edit-cut-symbolic')
            .setSensitive(hasSelection && !view.note.locked);
        menu.addAction(t('Copy'), () => later(() => this._copyTextSelection(view)), 'edit-copy-symbolic')
            .setSensitive(hasSelection);
        const pasteItem = menu.addAction(
            t('Paste'), () => later(() => this._pasteTextClipboard(view)), 'edit-paste-symbolic');
        pasteItem.setSensitive(false);
        menu.addAction(t('Select All'), () => later(() => this._selectAllText(view)), 'edit-select-all-symbolic')
            .setSensitive(text.text.length > 0);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(t('Note menu'), () => later(() => this._openMenu(view)), 'view-more-symbolic');
        this._finishMenu(menu, view);
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, value) => {
            if (this._menu === menu)
                pasteItem.setSensitive(!!value && !view.note.locked);
        });
    }

    // Expiry sweep: delete notes whose deadline has passed. Runs once after
    // the initial scan and then every 60 seconds. Deletion is permanent,
    // like the menu's Delete action.
    _sweepExpiredNotes() {
        const now = Date.now();
        for (const view of [...this._views.values()]) {
            if (view.note.kind !== 'note')
                continue;
            const expires = parseExpires(view.note.expires);
            if (expires && expires.getTime() <= now)
                this._delete(view);
        }
    }

    _markCurrent(colors, view) {
        const custom = view.note.custom_color ? resolveNameToColor(view.note.custom_color) : null;
        for (const row of colors.get_children()) {
            if (!row.has_style_class_name('sticky-swatch-row'))
                continue;
            for (const button of row.get_children()) {
                if (button.has_style_class_name('sticky-swatch-custom')) {
                    button.style = custom ? `background-color: ${custom};` : '';
                    if (custom)
                        button.add_style_class_name('current');
                    else
                        button.remove_style_class_name('current');
                    continue;
                }
                const name = PALETTE.find(palette => button.has_style_class_name(palette));
                const isCurrent = !custom && name && PALETTE.indexOf(name) === view.note.color;
                if (isCurrent)
                    button.add_style_class_name('current');
                else
                    button.remove_style_class_name('current');
            }
        }
    }

    _scheduleMenuDrop() {
        if (this._menuDropId) {
            GLib.Source.remove(this._menuDropId);
            this._menuDropId = 0;
        }
        this._menuDropId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._menuDropId = 0;
            const then = this._menuThen;
            this._menuThen = null;
            this._closeMenu();
            if (then)
                then();
            return GLib.SOURCE_REMOVE;
        });
    }

    _closeMenu() {
        if (this._menuDropId) {
            GLib.Source.remove(this._menuDropId);
            this._menuDropId = 0;
        }
        this._menuThen = null;
        if (!this._menu)
            return;
        if (this._menuId) {
            this._menu.disconnect(this._menuId);
            this._menuId = 0;
        }
        // Clear text-edit menu guard on the view that owned this menu
        if (this._menuView) {
            this._menuView._inTextEditMenu = false;
            this._menuView._inNoteMenu = false;
        }
        this._menuView = null;
        this._menu.destroy();
        this._menu = null;
    }
}
