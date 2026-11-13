import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
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
    normalizeHexColor,
    hexIsDark,
    zoomFont,
    parseExpires,
    formatExpires,
    expiresToFrontmatter,
} from './model.js';
import {DesktopLayer, PinnedLayer} from './layer.js';
import {NoteFiles, expandNotePath} from './filesync.js';
import {t} from './i18n.js';
import {renderMarkdown, renderTodo} from './markdown-preview.js';
import {writeDocument} from './document.js';
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
const BOARD_MIN_W = 280;
const BOARD_MIN_H = 232;
const BOARD_BODY_H = 128;
const BOARD_HEADER_H = 34;
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

export class NoteBoard {
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
        this._boards = new Map();
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
        this._boards.clear();
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

    create(at, prefix = '') {
        this._whenReady(() => this._create(at, prefix));
    }

    createBoard() {
        this._whenReady(() => this._createBoard(null));
    }

    // Live boards for the panel menu, with display titles.
    boards() {
        return [...this._boards.values()]
            .map(board => ({key: board.key, title: board.note.title}));
    }

    // Permanently delete a board folder (recursively). The file monitor then
    // removes the notes and the board itself from the UI.
    deleteBoard(dirRel) {
        if (!this._boards.has(dirRel))
            return false;
        return this._files?.removeFolder(dirRel) ?? false;
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
            boards: this._boards.size,
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
            filename => this._removeFile(filename),
            null,
            present => this._onBoards(present));
        this._files.start();
        this._loadTodo();
        this._applyVisibility();
        this._flushQueue();
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
    // --- Boards ---
    // Boards are folders with a .board.md inside. The .board.md is a
    // Markdown document with frontmatter: it configures the board window and
    // carries the board's own Markdown body, which renders above the child
    // notes inside the board. Boards nest without limits.
    _boardKeyForRelpath(relpath) {
        if (typeof relpath !== 'string' || !relpath.includes('/'))
            return null;
        const segments = relpath.split('/');
        for (let end = segments.length - 1; end >= 1; end--) {
            const key = segments.slice(0, end).join('/');
            if (this._boards.has(key))
                return key;
        }
        return null;
    }

    // Absolute stage position of a (possibly nested) board frame.
    _boardStagePos(board) {
        if (board?.view) {
            const [ok, x, y] = board.view.frame.get_transformed_position();
            if (ok)
                return [x, y];
        }
        return [board?.note.x ?? 0, board?.note.y ?? 0];
    }

    _noteAbs(view) {
        const note = view.note;
        if (note.board) {
            const board = this._boards.get(note.board);
            if (board?.view) {
                const [bx, by] = this._boardStagePos(board);
                return {x: bx + note.x, y: by + note.y};
            }
        }
        return {x: note.x, y: note.y};
    }

    // Recompute board membership of everything after the set of boards
    // changed: files may have been created before their board appeared, or
    // boards may have appeared/disappeared around them.
    _reparentBoards() {
        let moved = false;
        for (const [key, board] of [...this._boards]) {
            const parent = this._boardKeyForRelpath(key);
            if ((board.parent ?? null) === parent)
                continue;
            moved = true;
            const [absX, absY] = this._boardStagePos(board);
            board.parent = parent;
            board.note.parent = parent;
            if (parent) {
                const parentBoard = this._boards.get(parent);
                const [px, py] = this._boardStagePos(parentBoard);
                board.note.x = Math.round(absX - px);
                board.note.y = Math.round(absY - py);
            } else {
                board.note.x = Math.round(absX);
                board.note.y = Math.round(absY);
            }
            const previousParent = board.view.frame.get_parent();
            previousParent?.remove_child(board.view.frame);
            this._moveBoardToParent(board);
            this._layout(board.view);
        }
        for (const view of [...this._views.values()]) {
            if (view.note.kind !== 'note')
                continue;
            const target = this._boardKeyForRelpath(view.note.filename);
            if ((view.note.board ?? null) === target)
                continue;
            moved = true;
            const abs = this._noteAbs(view);
            view.note.board = target;
            if (target) {
                const board = this._boards.get(target);
                if (!board)
                    continue;
                const [bx, by] = this._boardStagePos(board);
                view.note.x = Math.round(abs.x - bx);
                view.note.y = Math.round(abs.y - by);
                this._attachChild(view, board);
            } else {
                view.frame.get_parent()?.remove_child(view.frame);
                this._layerFor(view.note).add_child(view.frame);
                view.note.x = Math.round(abs.x);
                view.note.y = Math.round(abs.y);
                this._layout(view);
                this._paint(view);
            }
        }
        if (!moved)
            return;
        this._clampAll();
        this._applyVisibility();
        this._scheduleSave();
    }

    _attachChild(view, board) {
        const frame = view.frame;
        if (frame.get_parent() !== board.view.host)
            board.view.host.add_child(frame);
        this._layout(view);
        this._paint(view);
    }

    _moveBoardToParent(board) {
        const parentBoard = board.parent ? this._boards.get(board.parent) : null;
        if (parentBoard?.view) {
            const frame = board.view.frame;
            if (frame.get_parent() !== parentBoard.view.host)
                parentBoard.view.host.add_child(frame);
            return;
        }
        this._layerFor(board.note).add_child(board.view.frame);
    }

    _onBoards(present) {
        for (const key of [...this._boards.keys()]) {
            if (!present.has(key))
                this._unboard(key);
        }
        for (const [key, entry] of present) {
            const existing = this._boards.get(key);
            if (existing) {
                if (existing.raw === entry.raw)
                    continue;
                existing.raw = entry.raw;
                existing.document = entry.document;
                this._applyBoardDocument(existing, entry.document);
                continue;
            }
            this._mountBoard(key, entry);
        }
        this._reparentBoards();
    }

    // Apply frontmatter of a changed .board.md to the live board.
    _applyBoardDocument(board, document) {
        const metadata = document.metadata ?? {};
        const note = board.note;
        for (const key of ['x', 'y', 'w', 'h', 'expanded_h', 'color', 'workspace']) {
            if (Number.isInteger(metadata[key]))
                note[key] = metadata[key];
        }
        if (Number.isInteger(metadata.zoom))
            note.zoom = normalizeZoom(metadata.zoom);
        if (typeof metadata.pinned === 'boolean')
            note.pinned = metadata.pinned;
        if (typeof metadata.locked === 'boolean')
            note.locked = metadata.locked;
        if (typeof metadata.custom_color === 'string')
            note.custom_color = metadata.custom_color;
        if (typeof metadata.collapsed === 'boolean')
            note.collapsed = metadata.collapsed;
        const title = this._boardTitle(document.header, board.key.split('/').pop());
        if (title !== note.title)
            note.title = title;
        note.boardBody = document.body ?? '';
        this._refreshBoardBody(board);
        this._paint(board.view);
        this._layout(board.view);
        this._applyVisibility();
    }

    _boardTitle(header, fallback) {
        for (const line of header ?? []) {
            const match = /^\s*title\s*:\s*(.*)$/.exec(line);
            if (match) {
                const value = match[1].trim().replace(/^"(.*)"$/, '$1');
                if (value)
                    return value;
            }
        }
        return fallback;
    }

    _boardBounds(board) {
        return {w: board.note.w, h: board.note.h};
    }

    _boardChildBounds(board) {
        return {x: 0, y: 0, w: board.note.w, h: board.note.h};
    }

    _childOrigin(board, childW, childH) {
        const header = Math.round(34 * normalizeZoom(board.note.zoom ?? 100) / 100);
        const body = (board.note.boardBody ?? '').trim() ? 132 : 0;
        const area = {
            x: 10,
            y: header + body + 10,
            w: Math.max(48, board.note.w - 20),
            h: Math.max(24, board.note.h - header - body - 20),
        };
        const obstacles = [];
        for (const view of this._views.values()) {
            if (view.note.kind === 'note' && view.note.board === board.key)
                obstacles.push([view.note.x, view.note.y, view.note.w, view.note.h]);
        }
        // Nested boards are obstacles too.
        for (const other of this._boards.values()) {
            if (other.parent === board.key)
                obstacles.push([other.note.x, other.note.y, other.note.w, other.note.h]);
        }
        const [x, y] = freshOrigin(obstacles, [area], childW, childH, null, null);
        return [x, y];
    }

    _defaultBoardNote(key, entry) {
        const parentKey = this._boardKeyForRelpath(key);
        const name = key.split('/').pop();
        const metadata = entry.document.metadata ?? {};
        const w = Number.isInteger(metadata.w) ? metadata.w : 420;
        const h = Number.isInteger(metadata.h) ? metadata.h : 300;
        let x = Number.isInteger(metadata.x) ? metadata.x : null;
        let y = Number.isInteger(metadata.y) ? metadata.y : null;
        if (x === null || y === null) {
            if (parentKey) {
                x = 20;
                y = 60;
            } else {
                const obstacles = this._store.notes.map(note => [note.x, note.y, note.w, note.h]);
                [x, y] = freshOrigin(obstacles, this._workAreas(), w, h, null, null);
            }
        }
        const note = {
            id: this._store.next_id++,
            kind: 'board',
            boardKey: key,
            parent: parentKey ?? null,
            filename: `${key}/.board.md`,
            title: this._boardTitle(entry.document.header, name),
            x, y, w, h,
            expanded_h: Number.isInteger(metadata.expanded_h) ? metadata.expanded_h : h,
            color: ((Number.isInteger(metadata.color) ? metadata.color : this._boards.size) + PALETTE.length) % PALETTE.length,
            size: 13, collapsed: metadata.collapsed === true, locked: metadata.locked === true,
            pinned: metadata.pinned === true,
            zoom: normalizeZoom(metadata.zoom),
            custom_color: typeof metadata.custom_color === 'string' ? metadata.custom_color : null,
            workspace: Number.isInteger(metadata.workspace) ? metadata.workspace : this._workspace(),
            text: '', spans: [], sizes: [],
            boardBody: entry.document.body ?? '',
        };
        return note;
    }

    _mountBoard(key, entry) {
        const note = this._defaultBoardNote(key, entry);
        const board = {
            key,
            parent: note.parent,
            note,
            view: null,
            raw: entry.raw,
            document: entry.document,
        };
        this._boards.set(key, board);
        board.view = this._buildBoardView(board);
        this._views.set(note.id, board.view);
        this._byFilename.set(note.filename, board.view);
        this._moveBoardToParent(board);
        this._layout(board.view);
        this._paint(board.view);
        this._applyVisibility();
        return board;
    }

    // Save one board back to its .board.md. Geometry and appearance live in
    // the file alongside the body; unrelated frontmatter is preserved.
    _saveBoard(board) {
        const note = board.note;
        const document = writeDocument({
            id: note.id, x: note.x, y: note.y, w: note.w, h: note.h,
            expanded_h: note.expanded_h ?? note.h, color: note.color, size: 13,
            workspace: note.workspace, pinned: note.pinned === true, locked: note.locked === true,
            collapsed: note.collapsed === true, zoom: normalizeZoom(note.zoom ?? 100),
            text: note.boardBody ?? '',
        }, board.raw ?? '');
        const ok = this._files.saveBoard(board.key, document);
        if (ok)
            board.raw = document;
        return ok;
    }

    // Unmount a board. The children (notes and nested boards) move to the
    // board's own parent — or to the desktop when the unboarded board was
    // at the root — keeping every absolute on-screen position they have.
    // The .board.md file is never touched here.
    _unboard(key) {
        const board = this._boards.get(key);
        if (!board)
            return;
        const [absX, absY] = this._boardStagePos(board);
        const newParent = board.parent ?? null;
        const parentBoard = newParent ? this._boards.get(newParent) : null;
        const [px, py] = parentBoard?.view ? this._boardStagePos(parentBoard) : [0, 0];
        // Nested boards first: they keep their on-screen place and land in
        // the freed slot of the parent board (or the desktop).
        for (const other of [...this._boards.values()]) {
            if (other === board || other.parent !== key)
                continue;
            other.parent = newParent;
            other.note.parent = newParent;
            other.note.x = Math.round(absX + other.note.x - (parentBoard ? px : 0));
            other.note.y = Math.round(absY + other.note.y - (parentBoard ? py : 0));
            const frame = other.view.frame;
            frame.get_parent()?.remove_child(frame);
            this._moveBoardToParent(other);
            this._layout(other.view);
        }
        for (const childView of [...this._views.values()]) {
            if (childView.note.kind !== 'note' || childView.note.board !== key)
                continue;
            const abs = {x: absX + childView.note.x, y: absY + childView.note.y};
            childView.note.board = newParent;
            childView.frame.get_parent()?.remove_child(childView.frame);
            if (parentBoard?.view) {
                childView.note.x = Math.round(abs.x - px);
                childView.note.y = Math.round(abs.y - py);
                this._attachChild(childView, parentBoard);
            } else {
                childView.note.x = Math.round(abs.x);
                childView.note.y = Math.round(abs.y);
                this._layerFor(childView.note).add_child(childView.frame);
                this._layout(childView);
                this._paint(childView);
            }
        }
        this._boards.delete(key);
        this._drop(board.view);
        this._reparentBoards();
        this._scheduleSave();
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
            size: 13, collapsed: false, locked: false, pinned: false,
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
                file.replace_contents(new TextEncoder().encode(''), null, false,
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
            filename, x, y, w, h, expanded_h: h,
            color: this._store.notes.length % PALETTE.length,
            size: 13,
            collapsed: false,
            locked: false,
            zoom: 100,
            custom_color: null,
            expires: null,
            pinned: pinNew,
            board: this._boardKeyForRelpath(filename),
            text: '', spans: [], sizes: [], workspace: this._workspace(),
        };
    }

    _upsertFile(filename, document) {
        const view = this._byFilename.get(filename);
        const note = view ? view.note : this._defaultNote(filename);
        note.kind = 'note';
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
        if (!document.hasFrontmatter || !Number.isInteger(metadata.id))
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
        for (const board of this._boards.values()) {
            try {
                this._saveBoard(board);
            } catch (error) {
                console.error(`Sticky Notes: could not save board ${board.key}: ${error}`);
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
        return [this._settings.get_int('max-width'), this._settings.get_int('max-height')];
    }

    _clampNote(note) {
        if (note.kind === 'board') {
            const [x, y, w, h] = clamp(
                note.x, note.y, note.w, note.h, this._workAreas(), BOARD_MIN_W, BOARD_MIN_H, 3000, 3000);
            note.x = x;
            note.y = y;
            note.w = w;
            note.h = h;
            note.expanded_h = note.expanded_h && note.expanded_h > BOARD_MIN_H ? note.expanded_h : h;
            return;
        }
        if (note.board) {
            const board = this._boards.get(note.board);
            if (board) {
                const maxW = Math.max(MIN_W, board.note.w - 8);
                const maxH = Math.max(MIN_H, board.note.h - 8);
                note.w = Math.min(Math.max(note.w, MIN_W), maxW);
                note.h = Math.min(Math.max(note.h, MIN_H), maxH);
                note.x = Math.min(Math.max(note.x, 0), Math.max(0, board.note.w - note.w));
                note.y = Math.min(Math.max(note.y, 0), Math.max(0, board.note.h - note.h));
                note.expanded_h = note.h;
                return;
            }
        }
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
            const parent = view.note.board ? this._boards.get(view.note.board) : null;
            const parentHidden = parent ? parent.note.collapsed === true : false;
            view.frame.visible = show && onSpace && !parentHidden;
        }
    }

    _create(at, prefix = '') {
        if (this._overview)
            Main.overview.hide();
        if (this._store.hidden) {
            this._store.hidden = false;
            this._settings.set_boolean('notes-hidden', false);
            this._applyVisibility();
        }
        const board = prefix ? this._boards.get(prefix.replace(/\/$/, '')) : null;
        const [maxW, maxH] = this._limits();
        const w = Math.min(this._settings.get_int('note-width'), maxW);
        const h = Math.min(this._settings.get_int('note-height'), maxH);
        const areas = this._workAreas();
        const obstacles = this._store.notes
            .filter(note => (note.board ?? null) === (board?.key ?? null))
            .map(note => [note.x, note.y, note.w, note.h]);
        const prefer = this._focused ? [this._focused.note.x, this._focused.note.y] : null;
        let x;
        let y;
        if (board?.view) {
            [x, y] = this._childOrigin(board, w, h);
        } else {
            [x, y] = freshOrigin(obstacles, areas, w, h, at, prefer);
        }
        const id = this._store.next_id;
        this._store.next_id += 1;
        const note = {
            id,
            kind: 'note',
            filename: this._files.newFilename(prefix),
            pinned: this._settings.get_boolean('pin-new-notes'),
            x,
            y,
            w,
            h,
            expanded_h: h,
            color: this._store.notes.length % PALETTE.length,
            size: 13,
            collapsed: false,
            locked: false,
            zoom: 100,
            custom_color: null,
            expires: null,
            board: board?.key ?? null,
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
        const board = note.board ? this._boards.get(note.board) : null;
        if (board?.view)
            this._attachChild(view, board);
        else
            this._layerFor(note).add_child(view.frame);
        this._layout(view);
        this._paint(view);
        this._applyVisibility();
        // The panel menu still owns the pointer grab inside its activate
        // handler. Focusing on the next idle lets that grab finish first.
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
            style_class: `sticky-note ${PALETTE[note.color]}`,
            x_expand: true,
            y_expand: true,
        });
        const grip = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            style_class: 'sticky-note-grip',
            reactive: true,
            cursor_type: Clutter.CursorType.GRAB,
            height: 18,
            x_expand: true,
        });
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
            editable: !note.locked,
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
            y_align: Clutter.ActorAlign.START,
            visible: false,
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
            previewMode: false,
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
        scroll.add_action(editClick);
        scroll.connectObject(
            'button-press-event', (_actor, event) => this._onBodyPress(view, event),
            this);
        preview.connectObject(
            'captured-event', (_actor, event) => this._onPreviewCapture(view, event),
            this);
        if (note.kind === 'todo') {
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
            'key-press-event', (_actor, event) => this._onTextKey(view, event),
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
        return view;
    }

    // Board frame: chrome above, children notes below. Children are real
    // note frames parented into this frame; boards nest recursively.
    _buildBoardView(board) {
        const note = board.note;
        const zoom = normalizeZoom(note.zoom ?? 100);
        const frame = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            x: note.x,
            y: note.y,
            width: note.w,
            height: note.h,
        });
        const background = new St.Widget({
            style_class: `sticky-note sticky-note-board ${PALETTE[note.color]}`,
            reactive: true,
            x: 0,
            y: 0,
            width: note.w,
            height: note.h,
        });
        // Three layers, painted in add order: background, children host,
        // chrome (grip + body). Children can never cover the chrome.
        const host = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x: 0,
            y: 0,
            width: note.w,
            height: note.h,
        });
        const chrome = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-note-board-chrome',
            x: 0,
            y: 0,
            width: note.w,
        });
        const grip = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            style_class: 'sticky-note-grip sticky-note-board-header',
            reactive: true,
            cursor_type: Clutter.CursorType.GRAB,
            height: Math.max(16, Math.round(BOARD_HEADER_H * zoom / 100)),
            x_expand: true,
        });
        const toggle = new St.Button({
            style_class: 'sticky-note-board-toggle',
            label: note.collapsed ? '▸' : '▾',
            can_focus: false,
            x: 4,
            y: 4,
            accessible_name: t('Collapse board'),
        });
        const title = new St.Label({
            style_class: 'sticky-note-board-title',
            style: `font-size: ${zoomFont(zoom)}pt;`,
            text: note.title,
            x: 34,
            y: 6,
            width: Math.max(48, note.w - 44),
            reactive: true,
        });
        title.clutter_text.line_wrap = false;
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        grip.add_child(toggle);
        grip.add_child(title);
        chrome.add_child(grip);
        const body = (note.boardBody ?? '').trim();
        let bodyScroll = null;
        let bodyLabel = null;
        if (body) {
            bodyLabel = new St.Label({
                style_class: 'sticky-note-board-body',
                style: `font-size: ${zoomFont(zoom)}pt;`,
                x_expand: true,
            });
            bodyLabel.clutter_text.set_markup(renderMarkdown(body).markup);
            bodyLabel.clutter_text.line_wrap = true;
            bodyLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            const page = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_expand: true,
            });
            page.add_child(bodyLabel);
            bodyScroll = new St.ScrollView({
                style_class: 'sticky-note-scroll',
                overlay_scrollbars: true,
                enable_touch_scrolling: false,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.EXTERNAL,
                x_expand: true,
                height: BOARD_BODY_H,
                child: page,
            });
            chrome.add_child(bodyScroll);
        }
        frame.add_child(background);
        frame.add_child(host);
        frame.add_child(chrome);
        const handleSize = Math.max(12, Math.round(HANDLE * zoom / 100));
        const resize = new St.Widget({
            style_class: 'sticky-note-resize',
            reactive: true,
            cursor_type: Clutter.CursorType.SE_RESIZE,
            width: handleSize,
            height: handleSize,
        });
        frame.add_child(resize);
        // Stubs: shared code paths touch text/preview on every view.
        const text = new Clutter.Text({
            text: '',
            editable: false,
            reactive: false,
            visible: false,
        });
        const preview = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            visible: false,
        });
        frame.add_child(text);
        frame.add_child(preview);
        const view = {
            note, frame, card: background, host, chrome, grip, toggle, title, pill: null,
            bodyScroll, bodyLabel, text, preview, resize,
            scroll: null, editClick: null, keyControllers: [],
            ribbon: null,
            previewMode: false, editing: false, sizeHold: false, pendingSize: 0,
            anchor: null, rewrite: false, rewriteId: 0, focusId: 0, newlineId: 0,
            lastEditClick: 0, previewRows: [], renderToken: 0,
            handleSize, previewCursor: 0,
        };
        grip.connectObject(
            'captured-event', (_actor, event) => this._onHandleEvent(view, 'move', grip, event),
            'button-press-event', (_actor, event) => {
                if (event.get_button() === BUTTON_SECONDARY) {
                    this._openBoardMenu(view);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            },
            this);
        toggle.connect('clicked', () => this._toggleBoardCollapsed(view));
        title.connectObject(
            'button-press-event', (_actor, event) => {
                if (event.get_button() === BUTTON_SECONDARY) {
                    this._openBoardMenu(view);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            },
            this);
        resize.connectObject(
            'captured-event', (_actor, event) => this._onHandleEvent(view, 'resize', resize, event),
            this);
        frame.connectObject(
            'captured-event', (_actor, event) => this._onShortcutCapture(view, event),
            'button-press-event', (_actor, event) => {
                if (event.get_button() === BUTTON_SECONDARY) {
                    this._openBoardMenu(view);
                    return Clutter.EVENT_STOP;
                }
                if (event.get_button() === BUTTON_PRIMARY)
                    this._focus(view, false);
                return Clutter.EVENT_PROPAGATE;
            },
            this);
        return view;
    }

    _refreshBoardBody(board) {
        const {view, note} = board;
        const body = (note.boardBody ?? '').trim();
        if (!view.bodyLabel && body) {
            // A body appeared after mounting: rebuild the board view.
            this._unboard(board.key);
            this._files.queueScan();
            return;
        }
        if (!view.bodyLabel)
            return;
        if (view.bodyLabel)
            view.bodyLabel.clutter_text.set_markup(renderMarkdown(body).markup);
        if (view.bodyScroll)
            view.bodyScroll.visible = note.collapsed !== true;
    }

    _toggleBoardCollapsed(view) {
        if (view.note.kind !== 'board')
            return;
        view.note.collapsed = !view.note.collapsed;
        this._paint(view);
        this._layoutBoard(view);
        this._applyVisibility();
        this._scheduleSave();
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

    _layout(view) {
        const {note, frame, card, text, resize} = view;
        if (note.kind === 'board') {
            this._layoutBoard(view);
            return;
        }
        frame.set_position(note.x, note.y);
        frame.set_size(note.w, note.h);
        card.set_position(0, 0);
        card.set_size(note.w, note.h);
        view.pill.set_position(
            Math.max(0, Math.round((note.w - view.pill.width) / 2)), 7);
        if (view.expiryBadge)
            view.expiryBadge.set_position(Math.max(0, note.w - 112), 2);
        text.width = Math.max(48, note.w - 26);
        view.preview.width = Math.max(48, note.w - 26);
        text.min_height = 0;
        resize.set_position(
            Math.max(0, note.w - view.handleSize), Math.max(0, note.h - view.handleSize));
        resize.set_size(view.handleSize, view.handleSize);
    }

    _layoutBoard(view) {
        const {note, frame, card, resize} = view;
        const zoom = normalizeZoom(note.zoom ?? 100);
        const collapsed = note.collapsed === true;
        const header = Math.max(16, Math.round(BOARD_HEADER_H * zoom / 100));
        const body = (!collapsed && view.bodyScroll) ? BOARD_BODY_H : 0;
        const height = collapsed ? header : note.h;
        frame.set_position(note.x, note.y);
        frame.set_size(note.w, height);
        card.set_position(0, 0);
        card.set_size(note.w, height);
        view.host.set_size(note.w, note.h);
        view.host.visible = !collapsed;
        view.chrome.set_size(note.w, header + body);
        view.grip.set_height(header);
        if (view.bodyScroll)
            view.bodyScroll.visible = !collapsed;
        const handle = Math.max(12, Math.round(HANDLE * zoom / 100));
        view.handleSize = handle;
        resize.visible = !collapsed;
        resize.set_position(Math.max(0, note.w - handle), Math.max(0, height - handle));
        resize.set_size(handle, handle);
        if (view.toggle)
            view.toggle.label = collapsed ? '▸' : '▾';
    }

    _paint(view) {
        const note = view.note;
        const custom = note.custom_color ? normalizeHexColor(note.custom_color) : null;
        const dark = custom ? hexIsDark(custom) : false;
        view.customDark = dark;
        const name = PALETTE[note.color] ?? PALETTE[0];
        for (const color of PALETTE)
            view.card.remove_style_class_name(color);
        view.card.remove_style_class_name('custom-color');
        if (custom) {
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
        if (view.pill)
            view.pill.style = dark ? 'background-color: rgba(246,245,244,0.4);' : '';
        if (note.kind === 'board') {
            const zoom = normalizeZoom(note.zoom ?? 100);
            note.zoom = zoom;
            view.handleSize = Math.max(12, Math.round(HANDLE * zoom / 100));
            const bodyStyle = `font-size: ${zoomFont(zoom)}pt${dark ? '; color: #f6f5f4' : ''};`;
            if (view.title)
                view.title.style = bodyStyle;
            if (view.bodyLabel)
                view.bodyLabel.style = bodyStyle;
            this._layoutBoard(view);
            return;
        }
        view.text.editable = !note.locked;
        const cursor = note.locked
            ? Clutter.CursorType.DEFAULT
            : Clutter.CursorType.TEXT;
        view.text.cursor_type = cursor;
        view.frame.cursor_type = cursor;
        const zoom = normalizeZoom(note.zoom ?? 100);
        note.zoom = zoom;
        view.handleSize = Math.max(12, Math.round(HANDLE * zoom / 100));
        view.text.font_name = `Sans ${zoomFont(zoom)}`;
        view.text.color = ink;
        view.text.cursor_color = ink;
        view.resize.style = dark ? 'background-color: rgba(246,245,244,0.25);' : '';
        view.grip.set_height(Math.max(10, Math.round(18 * zoom / 100)));
        view.pill.set_width(Math.max(16, Math.round(36 * zoom / 100)));
        this._updateExpiryBadge(view);
        this._showAttrs(view);
        this._syncRibbon(view);
    }

    // Grip badge: short expiration label, hidden when unset.
    _updateExpiryBadge(view) {
        const badge = view.expiryBadge;
        if (!badge)
            return;
        const expires = parseExpires(view.note.expires);
        if (!expires) {
            badge.visible = false;
            return;
        }
        const pad = value => String(value).padStart(2, '0');
        badge.text = `⌛ ${pad(expires.getDate())}/${pad(expires.getMonth() + 1)} `
            + `${pad(expires.getHours())}:${pad(expires.getMinutes())}`;
        badge.style = view.customDark ? 'color: rgba(246,245,244,0.85);' : '';
        badge.visible = true;
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
        if (view.note.kind === 'board')
            this._boards.delete(view.note.boardKey);
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
            if (control)
                this._duplicate(view);
            else
                this._copyNote(view);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.SCROLL && control && !editing) {
            const direction = event.get_scroll_direction();
            const step = direction === Clutter.ScrollDirection.UP ? 10 : -10;
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
        const link = this._linkAt(view, found, event);
        if (link) {
            this._openLink(view, link.url);
            return Clutter.EVENT_STOP;
        }
        if (found.row.todo)
            return this._toggleTodoAt(view, found.row.source)
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        if (found.row.box)
            return this._toggleBoxLineAt(view, found.row.source)
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        // Not interactive: let the scroll gesture handle blur/double-click.
        return Clutter.EVENT_PROPAGATE;
    }
    // Character offset of the line whose checkbox glyph is under the pointer,
    // or -1. Pango indexes bytes, the note text counts characters.
    _boxAt(view, event) {
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
        if (text.cursor_position === text.selection_bound) {
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
        if (control && !view.note.locked) {
            const action = this._formatShortcut(key, (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0);
            if (action) {
                this._runFormatShortcut(view, action);
                return Clutter.EVENT_STOP;
            }
        }
        if (!control && ENTER_KEYS.has(key))
            return this._insertNewline(view) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        if (key === Clutter.KEY_BackSpace && !control && !view.note.locked &&
            view.text.cursor_position === view.text.selection_bound) {
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
        if (view.note.locked)
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
        if (view.note.locked)
            return;
        const [, end] = view.anchor ?? this._range(view);
        // Insert at the caret end and keep whatever was selected.
        const next = insertTable(view.note.text, end, end);
        this._commitText(view, next.text, next.cursor);
        view.anchor = null;
        this._keepTyping(view);
    }

    _applyMarker(view, kind) {
        if (view.note.locked)
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
        const factor = next / current;
        view.note.zoom = next;
        view.note.w = Math.min(3000, Math.max(MIN_W, Math.round(view.note.w * factor)));
        view.note.h = Math.min(3000, Math.max(MIN_H, Math.round(view.note.h * factor)));
        view.note.expanded_h = Math.min(3000,
            Math.max(MIN_H, Math.round((view.note.expanded_h ?? view.note.h) * factor)));
        this._paint(view);
        this._layout(view);
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

    _duplicate(view) {
        if (view.note.kind !== 'note')
            return;
        const source = view.note;
        const board = typeof source.board === 'string' && source.board
            ? this._boards.get(source.board)
            : null;
        const areas = this._workAreas();
        const obstacles = this._store.notes
            .filter(note => (note.board ?? null) === (board?.key ?? null))
            .map(note => [note.x, note.y, note.w, note.h]);
        let x;
        let y;
        if (board?.view)
            [x, y] = this._childOrigin(board, source.w, source.h);
        else
            [x, y] = freshOrigin(obstacles, areas, source.w, source.h, null, [source.x, source.y]);
        const id = this._store.next_id;
        this._store.next_id += 1;
        const prefix = typeof source.board === 'string' && source.board
            ? `${source.board}/`
            : (source.filename.includes('/')
                ? source.filename.slice(0, source.filename.lastIndexOf('/') + 1)
                : '');
        const note = {
            id,
            kind: 'note',
            filename: this._files.newFilename(prefix),
            pinned: source.pinned === true,
            x,
            y,
            w: source.w,
            h: source.h,
            expanded_h: source.h,
            color: source.color,
            size: source.size,
            collapsed: false,
            locked: false,
            text: source.text,
            spans: source.spans.map(span => ({...span})),
            sizes: source.sizes.map(run => ({...run})),
            zoom: normalizeZoom(source.zoom ?? 100),
            custom_color: typeof source.custom_color === 'string' ? source.custom_color : null,
            expires: typeof source.expires === 'string' ? source.expires : null,
            board: source.board ?? null,
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
            const render = view.note.kind === 'todo'
                ? renderTodo(view.note.text, toDateString(new Date()))
                : renderMarkdown(view.note.text);
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
    _showImageFile(view, box, placeholder, path, maxWidth, token) {
        if (token !== view.renderToken || !box.get_parent())
            return;
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, maxWidth, 1200, true);
            const width = pixbuf.get_width();
            const height = pixbuf.get_height();
            const image = new Clutter.Image();
            image.set_data(
                pixbuf.get_pixels(),
                pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                width, height, pixbuf.get_rowstride());
            const texture = Clutter.TextureContent.new_from_texture(image.get_texture(), null);
            if (placeholder.get_parent() === box)
                box.remove_child(placeholder);
            placeholder.destroy();
            const widget = new St.Widget({
                style_class: 'sticky-note-image-pic',
                width, height,
                reactive: true,
                accessible_name: 'image',
            });
            widget.set_content(texture);
            box.add_child(widget);
        } catch (error) {
            // A broken image never breaks the preview; keep the alt text.
            console.warn(`Sticky Notes: could not load image ${path}: ${error}`);
        }
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
        view.previewMode = !view.previewMode;
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

    // Prefix for creating a new note inside the same board as `view`.
    _boardPrefix(view) {
        return typeof view.note.board === 'string' && view.note.board
            ? `${view.note.board}/`
            : '';
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
        const custom = view.note.custom_color ? normalizeHexColor(view.note.custom_color) : null;
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
                    can_focus: false,
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
            can_focus: false,
            label: '+',
            accessible_name: t('Custom color'),
        });
        if (custom)
            customButton.style = `background-color: ${custom};`;
        customButton.connectObject('clicked', () => this._toggleColorEditor(menu, view, customButton, colors), this);
        customRow.add_child(customButton);
        colors.add_child(customRow);
        menu.box.add_child(colors);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    // Inline custom-color editor: an entry with a live preview and an apply
    // action. Toggles off when the + button is clicked again.
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
            hint_text: '#RRGGBB',
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
            const normalized = normalizeHexColor(entry.get_text());
            if (!normalized)
                return; // Invalid input: nothing happens.
            this._setCustomColor(view, normalized);
            this._markCurrent(colors, view);
        };
        entry.connectObject('changed', () => {
            const normalized = normalizeHexColor(entry.get_text());
            preview.style = normalized ? `background-color: ${normalized};` : '';
        }, this);
        entry.connectObject('activate', applyColor, this);
        apply.connectObject('clicked', applyColor, this);
        editor.add_child(entry);
        editor.add_child(preview);
        editor.add_child(apply);
        menu.box.add_child(editor);
        const seeded = view.note.custom_color ? normalizeHexColor(view.note.custom_color) : null;
        if (seeded) {
            entry.text = seeded;
            preview.style = `background-color: ${seeded};`;
        }
        entry.grab_key_focus();
    }

    _setCustomColor(view, hex) {
        view.note.custom_color = hex;
        this._paint(view);
        if (view.previewMode)
            this._refreshPreview(view);
        this._scheduleSave();
    }

    _openMenu(view) {
        if (view.note.kind === 'board') {
            this._openBoardMenu(view);
            return;
        }
        this._closeMenu();
        // Opening the menu of another note leaves the note being edited.
        if (global.stage.get_key_focus() !== view.text)
            this._blur();
        this._focus(view, false);
        const menu = new PopupMenu.PopupMenu(view.grip, 0.0, St.Side.TOP);
        this._addColorSwatches(menu, view);
        const later = fn => {
            this._menuThen = fn;
        };
        const isTodo = view.note.kind === 'todo';
        menu.addAction(t('New note'), () => later(() => this._create(null, this._boardPrefix(view))), 'document-new-symbolic');
        if (!isTodo)
            menu.addAction(t('Duplicate'), () => later(() => this._duplicate(view)), 'view-dual-symbolic');
        menu.addAction(t('Copy note'), () => later(() => this._copyNote(view)), 'edit-copy-symbolic');
        menu.addAction(
            t(view.previewMode ? (isTodo ? 'Edit tasks' : 'Edit Markdown')
                : (isTodo ? 'Preview tasks' : 'Preview Markdown')),
            () => later(() => this._togglePreview(view)),
            view.previewMode ? 'document-edit-symbolic' : 'document-preview-symbolic');
        if (isTodo)
            menu.addAction(t('Sort tasks'), () => later(() => this._sortTodo(view)), 'view-sort-descending-symbolic');
        menu.addAction(
            t(view.note.pinned ? 'Unpin note' : 'Pin above windows'),
            () => later(() => this._togglePin(view)),
            view.note.pinned ? 'window-restore-symbolic' : 'view-pin-symbolic');
        menu.addAction(
            t(view.note.locked ? 'Unlock' : 'Lock'),
            () => later(() => this._toggleLock(view)),
            view.note.locked ? 'changes-prevent-symbolic' : 'changes-allow-symbolic');
        if ((view.note.kind ?? 'note') === 'note') {
            const expires = parseExpires(view.note.expires);
            let caption = null;
            if (expires) {
                caption = new PopupMenu.PopupMenuItem(
                    `${t('Expires')}: ${formatExpires(expires)}`);
                caption.setSensitive(false);
                menu.addMenuItem(caption);
            }
            // Inline editor row: keeps the menu open, seeded when set.
            const editorRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'expiry-editor',
                x_expand: true,
            });
            const icon = new St.Label({text: '⌛', style_class: 'expiry-icon'});
            const entry = new St.Entry({
                style_class: 'sticky-swatch-entry',
                x_expand: true,
                can_focus: true,
                hint_text: 'YYYY-MM-DD HH:MM',
            });
            const apply = new St.Button({
                style_class: 'sticky-swatch-apply',
                can_focus: true,
                label: '✓',
                accessible_name: t('Apply'),
            });
            const applyExpiry = () => {
                const date = parseExpires(entry.get_text());
                if (!date)
                    return; // Invalid input: nothing happens.
                this._setExpiry(view, date);
                if (caption)
                    caption.label.text = `${t('Expires')}: ${formatExpires(date)}`;
            };
            entry.connectObject('activate', applyExpiry, this);
            apply.connectObject('clicked', applyExpiry, this);
            if (expires)
                entry.text = formatExpires(expires);
            editorRow.add_child(icon);
            editorRow.add_child(entry);
            editorRow.add_child(apply);
            menu.box.add_child(editorRow);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            if (expires) {
                menu.addAction(t('Clear expiry'),
                    () => later(() => this._clearExpiry(view)), 'edit-undo-symbolic');
            } else {
                menu.addAction(t('In 1 hour'),
                    () => later(() => this._setExpiry(view, new Date(Date.now() + 3600e3))),
                    'alarm-symbolic');
                menu.addAction(t('Tomorrow 09:00'),
                    () => later(() => {
                        const date = new Date();
                        date.setDate(date.getDate() + 1);
                        date.setHours(9, 0, 0, 0);
                        this._setExpiry(view, date);
                    }),
                    'alarm-symbolic');
                menu.addAction(t('In 1 week'),
                    () => later(() => this._setExpiry(view, new Date(Date.now() + 7 * 86400e3))),
                    'alarm-symbolic');
            }
        }
        const zoomItem = new PopupMenu.PopupMenuItem(`${t('Zoom')}: ${view.note.zoom ?? 100}%`);
        zoomItem.setSensitive(false);
        menu.addMenuItem(zoomItem);
        menu.addAction(t('Zoom out'), () => later(() => this._stepZoom(view, -10)), 'zoom-out-symbolic');
        menu.addAction(t('Zoom in'), () => later(() => this._stepZoom(view, 10)), 'zoom-in-symbolic');
        if (!isTodo)
            menu.addAction(t('Delete'), () => later(() => this._delete(view)), 'edit-delete-symbolic');
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
        menu.actor.hide();
        this._menuManager.addMenu(menu);
        menu.open();
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

    // Board context menu: a board window is not a note, it gets its own.
    _openBoardMenu(view) {
        this._closeMenu();
        const key = view.note.boardKey;
        this._focus(view, false);
        const menu = new PopupMenu.PopupMenu(view.grip, 0.0, St.Side.TOP);
        this._addColorSwatches(menu, view);
        const later = fn => {
            this._menuThen = fn;
        };
        menu.addAction(t('New note in board'), () => later(() => this._create(null, `${key}/`)), 'document-new-symbolic');
        menu.addAction(t('New board in board'), () => later(() => this._createBoard(key)), 'folder-new-symbolic');
        menu.addAction(t('Open board folder'), () => later(() => this._openFolder(key)), 'folder-symbolic');
        menu.addAction(
            t(view.note.collapsed ? 'Expand board' : 'Collapse board'),
            () => later(() => this._toggleBoardCollapsed(view)),
            view.note.collapsed ? 'pan-end-symbolic' : 'pan-down-symbolic');
        menu.addAction(
            t(view.note.pinned ? 'Unpin note' : 'Pin above windows'),
            () => later(() => this._togglePin(view)),
            view.note.pinned ? 'window-restore-symbolic' : 'view-pin-symbolic');
        menu.addAction(
            t(view.note.locked ? 'Unlock' : 'Lock'),
            () => later(() => this._toggleLock(view)),
            view.note.locked ? 'changes-prevent-symbolic' : 'changes-allow-symbolic');
        const zoomItem = new PopupMenu.PopupMenuItem(`${t('Zoom')}: ${view.note.zoom ?? 100}%`);
        zoomItem.setSensitive(false);
        menu.addMenuItem(zoomItem);
        menu.addAction(t('Zoom out'), () => later(() => this._stepZoom(view, -10)), 'zoom-out-symbolic');
        menu.addAction(t('Zoom in'), () => later(() => this._stepZoom(view, 10)), 'zoom-in-symbolic');
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(t('Unboard'), () => later(() => this._unboardAction(key)), 'go-up-symbolic');
        this._finishMenu(menu, view);
    }

    _openFolder(key) {
        const dir = Gio.File.new_for_path(GLib.build_filenamev([this._files.directory, key]));
        try {
            Gio.AppInfo.launch_default_for_uri(dir.get_uri(), null);
        } catch (error) {
            console.warn(`Sticky Notes: could not open ${dir.get_path()}: ${error}`);
        }
    }

    _unboardAction(key) {
        if (!this._files?.removeBoard(key))
            return;
        this._unboard(key);
    }

    _createBoard(parentKey = null) {
        const root = this._files?.directory;
        if (!root)
            return;
        const parentBoard = parentKey ? this._boards.get(parentKey) : null;
        const areas = this._workAreas();
        let name = null;
        let dirRel = null;
        for (let n = 1; n <= 500; n++) {
            name = `board-${n}`;
            dirRel = parentKey ? `${parentKey}/${name}` : name;
            const exists = GLib.file_test(GLib.build_filenamev([root, dirRel]), GLib.FileTest.EXISTS);
            if (!exists && !this._boards.has(dirRel))
                break;
        }
        if (!name)
            return;
        const w = 420;
        const h = 300;
        let x;
        let y;
        if (parentBoard?.view) {
            const count = [...this._views.values()].filter(v => v.note.board === parentKey).length;
            x = 24 + (count * 30) % Math.max(1, parentBoard.note.w - w - 24);
            y = 64 + (count * 30) % Math.max(1, parentBoard.note.h - h - 64);
        } else {
            const obstacles = this._store.notes.map(note => [note.x, note.y, note.w, note.h]);
            [x, y] = freshOrigin(obstacles, areas, w, h, null, null);
        }
        const dirPath = GLib.build_filenamev([root, dirRel]);
        try {
            GLib.mkdir_with_parents(dirPath, 0o755);
            const content = [
                '---',
                `title: ${name}`,
                `gnome-sticky-id: ${this._store.next_id++}`,
                `gnome-sticky-x: ${x}`,
                `gnome-sticky-y: ${y}`,
                `gnome-sticky-width: ${w}`,
                `gnome-sticky-height: ${h}`,
                `gnome-sticky-expanded-height: ${h}`,
                'gnome-sticky-color: 3',
                'gnome-sticky-zoom: 100',
                '---',
                '',
            ].join('\n');
            Gio.File.new_for_path(GLib.build_filenamev([dirPath, '.board.md']))
                .replace_contents(new TextEncoder().encode(content), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (error) {
            console.error(`Sticky Notes: could not create board ${dirRel}: ${error}`);
            return;
        }
        this._files.queueScan();
    }

    _markCurrent(colors, view) {
        const custom = view.note.custom_color ? normalizeHexColor(view.note.custom_color) : null;
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
            this._menuThen = null;
        }
        if (!this._menu)
            return;
        if (this._menuId) {
            this._menu.disconnect(this._menuId);
            this._menuId = 0;
        }
        this._menuView = null;
        this._menu.destroy();
        this._menu = null;
    }
}
