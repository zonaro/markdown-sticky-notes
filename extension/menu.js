import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {t} from './i18n.js';

export class NotesMenu {
    constructor(extensionPath, board, openPreferences) {
        this._board = board;
        this._openPreferences = openPreferences;

        const iconPath = GLib.build_filenamev([
            extensionPath, 'icons', 'hicolor', 'scalable',
            'actions', 'sticky-notes-symbolic.svg',
        ]);
        const indicator = new PanelMenu.Button(0.5, t('Sticky Notes'));
        indicator.add_child(new St.Icon({
            gicon: new Gio.FileIcon({file: Gio.File.new_for_path(iconPath)}),
            style_class: 'system-status-icon',
        }));
        const menu = indicator.menu;

        const newNote = new PopupMenu.PopupImageMenuItem(t('New note'), 'document-new-symbolic');
        newNote.connect('activate', () => this._board.create(null));
        menu.addMenuItem(newNote);

        this._hideItem = new PopupMenu.PopupImageMenuItem(t('Hide notes'), 'view-conceal-symbolic');
        this._hideItem.connect('activate', () => this._board.toggle());
        menu.addMenuItem(this._hideItem);

        const openFolder = new PopupMenu.PopupImageMenuItem(t('Open notes folder'), 'folder-symbolic');
        openFolder.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(GLib.build_filenamev([GLib.get_home_dir(), 'notes'])).get_uri(), null);
        });
        menu.addMenuItem(openFolder);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._deleteAll = new PopupMenu.PopupSubMenuMenuItem(t('Delete all notes'), true);
        this._deleteAll.icon.icon_name = 'edit-delete-symbolic';
        const confirmDelete = new PopupMenu.PopupImageMenuItem(
            t('Permanently delete every Markdown note'), 'edit-delete-symbolic');
        confirmDelete.connect('activate', () => this._board.deleteAll());
        this._deleteAll.menu.addMenuItem(confirmDelete);
        menu.addMenuItem(this._deleteAll);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settings = new PopupMenu.PopupImageMenuItem(t('Settings'), 'emblem-system-symbolic');
        settings.connect('activate', () => this._openPreferences());
        menu.addMenuItem(settings);

        this._menu = menu;
        this._openId = menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });
        this._indicator = indicator;
    }

    addToPanel() {
        Main.panel.addToStatusArea('sticky-notes', this._indicator, 0, 'right');
    }

    destroy() {
        if (this._openId)
            this._menu.disconnect(this._openId);
        this._indicator.destroy();
        this._indicator = null;
        this._menu = null;
        this._hideItem = null;
        this._deleteAll = null;
        this._board = null;
        this._openPreferences = null;
    }

    _refresh() {
        const status = this._board.status();
        this._hideItem.label.text = t(status.hidden ? 'Show notes' : 'Hide notes');
        this._hideItem.setIcon(status.hidden ? 'view-reveal-symbolic' : 'view-conceal-symbolic');
        this._deleteAll.setSensitive(status.notes > 0);
    }
}
