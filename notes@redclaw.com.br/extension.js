// notes@redclaw.com.br/extension.js
// GPL v3
// Copyright 2018-2021 Romain F. T.

import St from 'gi://St';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {NoteBox} from './noteBox.js';

//------------------------------------------------------------------------------

const PATH = GLib.build_filenamev([GLib.get_home_dir(), 'notes']);

export let NOTES_MANAGER = null;
export let SETTINGS = null;
export let AUTO_FOCUS = false;
let LAYER_SETTING = '';

export default class NotesExtension extends Extension {
	enable() {
		try {
			Gio.File.new_for_path(PATH).make_directory_with_parents(null);
		} catch (error) {
			if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
				throw error;
		}
		SETTINGS = this.getSettings();
		AUTO_FOCUS = SETTINGS.get_boolean('auto-focus');
		NOTES_MANAGER = new NotesManager(this);
		NOTES_MANAGER.start();
	}

	disable() {
		NOTES_MANAGER?.destroy();
		NOTES_MANAGER = null;
		SETTINGS = null;
		AUTO_FOCUS = false;
	}
}

//------------------------------------------------------------------------------

/*
 * A singleton that manages the button in the top bar, and thus provides the
 * actions of loading, showing, hiding, creating (and in some way saving and
 * destroying) all the notes.
 * If no note exists, it will create the first one itself, otherwise it serves
 * as a middleman between the note whose "new" button has been pressed and the
 * new one.
 */
class NotesManager {
	constructor(extension) {
		this.extension = extension;
		// Initialisation of the button in the top panel
		this.panel_button = new PanelMenu.Button(0.0, _("Show notes"), false);
		let icon = new St.Icon({
			icon_name: 'document-edit-symbolic',
			style_class: 'system-status-icon'
		});
		this.panel_button.add_child(icon);
		this.panel_button.connect('button-press-event', () => {
			this._onButtonPressed();
			return true;
		});
		this._updateIconVisibility();
		// `0` is the position within the chosen box (here, the `right` one)
		Main.panel.addToStatusArea('NotesButton', this.panel_button, 0, 'right');

		// Files are the source of truth; keep a stable actor per filename.
		this._allNotes = [];
		this._notesByFilename = new Map();
		this._notesAreVisible = false;
		this._updateLayerSetting(); // it inits LAYER_SETTING

		// Initialisation of the signals connections
		this._bindKeyboardShortcut();
		this._connectAllSignals();
	}

	start() {
		const directory = Gio.File.new_for_path(PATH);
		this._fileMonitor = directory.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
		this._fileMonitor.connect('changed', (_monitor, file, otherFile) => {
			if (this._isNoteFile(file?.get_basename()) ||
			    this._isNoteFile(otherFile?.get_basename()))
				this._scheduleFileSync();
		});
		this._syncFiles();
		this._showNotes();
	}

	_isNoteFile(name) {
		return typeof name === 'string' && /\.(md|markdown)$/i.test(name);
	}

	_listNoteFiles() {
		const names = [];
		const iterator = Gio.File.new_for_path(PATH).enumerate_children(
			'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
		try {
			let info;
			while ((info = iterator.next_file(null)) !== null) {
				if (info.get_file_type() === Gio.FileType.REGULAR &&
				    this._isNoteFile(info.get_name()))
					names.push(info.get_name());
			}
		} finally {
			iterator.close(null);
		}
		return names.sort((a, b) => a.localeCompare(b));
	}

	_scheduleFileSync() {
		if (this._syncTimeout)
			GLib.Source.remove(this._syncTimeout);
		this._syncTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
			this._syncTimeout = null;
			this._syncFiles();
			return GLib.SOURCE_REMOVE;
		});
	}

	_syncFiles() {
		let files;
		try {
			files = this._listNoteFiles();
		} catch (error) {
			console.error(`Could not scan ~/notes: ${error}`);
			return;
		}
		const present = new Set(files);
		for (const [name, note] of this._notesByFilename) {
			if (!present.has(name)) {
				this._notesByFilename.delete(name);
				const index = this._allNotes.indexOf(note);
				if (index !== -1)
					this._allNotes.splice(index, 1);
				note.destroy(); // File was removed outside GNOME; do not recreate it.
			}
		}
		for (const name of files) {
			const note = this._notesByFilename.get(name);
			if (note) {
				try {
					note.reloadIfChanged();
				} catch (error) {
					console.error(`Could not reload ${name}: ${error}`);
				}
			} else {
				this.createNote('', 16, name);
			}
		}
	}

	_bindKeyboardShortcut () {
		this._useKeyboardShortcut = SETTINGS.get_boolean('use-shortcut');
		if (this._useKeyboardShortcut) {
			Main.wm.addKeybinding(
				'notes-kb-shortcut',
				SETTINGS,
				Meta.KeyBindingFlags.NONE,
				Shell.ActionMode.ALL,
				this._onButtonPressed.bind(this)
			);
		}
	}

	//--------------------------------------------------------------------------
	// "Public" methods, accessed by the NoteBox objects -----------------------

	createNote (colorString, fontSize, filename = null) {
		const isNew = filename === null;
		if (isNew) {
			const stamp = Date.now();
			let counter = 0;
			do {
				filename = `note-${stamp}${counter ? `-${counter}` : ''}.md`;
				counter++;
			} while (GLib.file_test(GLib.build_filenamev([PATH, filename]), GLib.FileTest.EXISTS));
			GLib.file_set_contents(GLib.build_filenamev([PATH, filename]), '');
		}
		try {
			const note = new NoteBox(filename, colorString, fontSize);
			this._allNotes.push(note);
			this._notesByFilename.set(filename, note);
			if (this._notesAreVisible)
				note.show();
			else
				note.onlyHide();
		} catch (e) {
			Main.notify(_("Notes extension error: failed to load a note"));
			console.error(`Failed to create note ${filename}: ${e}`);
		}
	}

	postDelete (filename) {
		const note = this._notesByFilename.get(filename);
		if (note) {
			this._notesByFilename.delete(filename);
			const index = this._allNotes.indexOf(note);
			if (index !== -1)
				this._allNotes.splice(index, 1);
		}
		this._deleteNoteFile(filename);
	}

	/*
	 * Tells if [x, y] are suitable coords for a note (= not too close of the
	 * other existing notes). Called by NoteBox objects on various occasions,
	 * for example when brought back to the primary monitor, or when deciding
	 * the initial coords at the creation of the note.
	 */
	areCoordsUsable (x, y) {
		let areaIsFree = true;
		this._allNotes.forEach(function (n) {
			if( (Math.abs(n._x - x) < 230) && (Math.abs(n._y - y) < 100) ) {
				areaIsFree = false;
			}
		});
		return areaIsFree;
	}

	notesNeedChromeTracking () {
		return this._layerId == 'above-all';
	}

	//--------------------------------------------------------------------------

	_showNotes () {
		this._notesAreVisible = true;
		this._allNotes.forEach(function (n) {
			n.show();
		});
	}

	_hideNotes () {
		this._onlyHideNotes();
		this._timeout_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
			this._timeout_id = null;
			// saving to the disk is slightly delayed to give the illusion that
			// the extension doesn't freeze the system
			this._allNotes.forEach(function (n) {
				n.onlySave();
			});
			return GLib.SOURCE_REMOVE;
		});
	}

	_onlyHideNotes () {
		this._allNotes.forEach(function (n) {
			n.onlyHide();
		});
		this._notesAreVisible = false;
	}

	_deleteNoteFile (filename) {
		const file = Gio.File.new_for_path(GLib.build_filenamev([PATH, filename]));
		if (file.query_exists(null))
			file.delete(null);
	}

	_onButtonPressed () {
		// log('_onButtonPressed');

		let preventReshowing = false;
		if(LAYER_SETTING === 'cycle-layers') {
			this._allNotes.forEach(function (n) {
				n.removeFromCorrectLayer();
			});

			// the notes' visibility will be inverted later
			if(!this._notesAreVisible) {
				this._layerId = 'on-background';
				this._notesAreVisible = false;
			} else if(this._layerId === 'on-background') {
				this._layerId = 'above-all';
				this._notesAreVisible = false;
				preventReshowing = true;
			} else if(this._layerId === 'above-all') {
				this._layerId = 'above-all';
				this._notesAreVisible = true;
			}

			this._allNotes.forEach(function (n) {
				n.loadIntoCorrectLayer();
			});
		}

		if(this._allNotes.length == 0) {
			this.createNote('', 16);
			this._showNotes();
		} else if (this._notesAreVisible) {
			this._hideNotes();
		} else if (preventReshowing) {
			this._notesAreVisible = true;
		} else {
			this._showNotes();
		}
	}

	//--------------------------------------------------------------------------
	// Watch the gsettings values and update the extension if they change ------

	_connectAllSignals () {
		this._settingsSignals = {};

		this._settingsSignals['layout'] = SETTINGS.connect(
			'changed::layout-position',
			this._updateLayerSetting.bind(this)
		);
		this._settingsSignals['bring-back'] = SETTINGS.connect(
			'changed::ugly-hack',
			this._bringToPrimaryMonitorOnly.bind(this)
		);
		this._settingsSignals['hide-icon'] = SETTINGS.connect(
			'changed::hide-icon',
			this._updateIconVisibility.bind(this)
		);
		this._settingsSignals['kb-shortcut-1'] = SETTINGS.connect(
			'changed::use-shortcut',
			this._updateShortcut.bind(this)
		);
		this._settingsSignals['kb-shortcut-2'] = SETTINGS.connect(
			'changed::notes-kb-shortcut',
			this._updateShortcut.bind(this)
		);
		this._settingsSignals['auto-focus'] = SETTINGS.connect(
			'changed::auto-focus',
			this._updateFocusSetting.bind(this)
		);
	}

	_updateShortcut () {
		if(this._useKeyboardShortcut) {
			Main.wm.removeKeybinding('notes-kb-shortcut');
		}
		this._bindKeyboardShortcut();
	}

	_updateFocusSetting () {
		// XXX currently not very user-friendly
		Main.notify(
			_("Notes"),
			_("Restart the extension to apply the changes")
		);
	}

	_updateIconVisibility () {
		let now_visible = !SETTINGS.get_boolean('hide-icon');
		this.panel_button.visible = now_visible;
	}

	_bringToPrimaryMonitorOnly () {
		this._allNotes.forEach(function (n) {
			n.fixState();
		});
	}

	/*
	 * Remove all the notes from where they are, and add them to the layer that
	 * is actually set by the user. Possible values for the layers can be
	 * 'above-all', 'on-background' or 'cycle-layers'.
	 */
	_updateLayerSetting () {
		this._allNotes.forEach(function (n) {
			n.removeFromCorrectLayer();
		});

		LAYER_SETTING = SETTINGS.get_string('layout-position');
		this._layerId = (LAYER_SETTING == 'on-background')
			? 'on-background'
			: 'above-all'
		;

		this._allNotes.forEach(function (n) {
			n.loadIntoCorrectLayer();
		});

		if(!this._notesAreVisible) {
			this._onlyHideNotes();
		}
	}

	//--------------------------------------------------------------------------

	destroy() {
		this._fileMonitor?.cancel();
		this._fileMonitor = null;
		if (this._syncTimeout) {
			GLib.Source.remove(this._syncTimeout);
			this._syncTimeout = null;
		}
		SETTINGS.disconnect(this._settingsSignals['layout']);
		SETTINGS.disconnect(this._settingsSignals['bring-back']);
		SETTINGS.disconnect(this._settingsSignals['hide-icon']);
		SETTINGS.disconnect(this._settingsSignals['kb-shortcut-1']);
		SETTINGS.disconnect(this._settingsSignals['kb-shortcut-2']);
		SETTINGS.disconnect(this._settingsSignals['auto-focus']);

		this._allNotes.forEach(function (n) {
			n.onlySave();
			n.destroy();
		});

		if(this._useKeyboardShortcut) {
			Main.wm.removeKeybinding('notes-kb-shortcut');
		}

		this.panel_button.destroy();

		if (this._timeout_id) {
			GLib.Source.remove(this._timeout_id);
			this._timeout_id = null;
		}
	}
};

//------------------------------------------------------------------------------

