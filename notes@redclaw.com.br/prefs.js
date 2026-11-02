// Preferences for GNOME Shell 50/51 (GTK4 + libadwaita).
// GPL v3; original extension by Romain F. T.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class NotesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(580, 650);

        const page = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const appearance = new Adw.PreferencesGroup({
            title: _('Position of notes'),
            description: _('Choose where sticky notes appear on the desktop.'),
        });
        page.add(appearance);

        const positions = ['above-all', 'on-background', 'cycle-layers'];
        const positionRow = new Adw.ComboRow({
            title: _('Position of notes'),
            model: Gtk.StringList.new([
                _('Above everything'),
                _('On the background'),
                _('Cycle through 3 states'),
            ]),
        });
        positionRow.selected = Math.max(0, positions.indexOf(settings.get_string('layout-position')));
        positionRow.connect('notify::selected', () => {
            settings.set_string('layout-position', positions[positionRow.selected]);
        });
        appearance.add(positionRow);

        const focusRow = new Adw.SwitchRow({title: _('Automatic focus')});
        settings.bind('auto-focus', focusRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(focusRow);

        const colorRow = new Adw.ActionRow({
            title: _("First note's color"),
            subtitle: _('New notes inherit the color of their parent.'),
        });
        const colorButton = new Gtk.ColorButton({
            valign: Gtk.Align.CENTER,
            use_alpha: false,
        });
        const storedColor = settings.get_strv('first-note-rgb').map(Number);
        const rgba = new Gdk.RGBA();
        rgba.red = storedColor[0];
        rgba.green = storedColor[1];
        rgba.blue = storedColor[2];
        rgba.alpha = 1;
        colorButton.set_rgba(rgba);
        colorButton.connect('color-set', () => {
            const color = colorButton.get_rgba();
            settings.set_strv('first-note-rgb', [
                color.red.toString(), color.green.toString(), color.blue.toString(),
            ]);
        });
        colorRow.add_suffix(colorButton);
        appearance.add(colorRow);

        const controls = new Adw.PreferencesGroup({title: _('Controls')});
        page.add(controls);

        const shortcutRow = new Adw.SwitchRow({
            title: _('Use a keyboard shortcut'),
            subtitle: _('Use a keyboard shortcut to toggle notes visibility'),
        });
        settings.bind('use-shortcut', shortcutRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        controls.add(shortcutRow);

        const shortcutValue = new Adw.EntryRow({
            title: _('Keyboard shortcut value'),
            text: settings.get_strv('notes-kb-shortcut')[0] || '<Super><Alt>n',
        });
        const applyButton = new Gtk.Button({
            label: _('Apply'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        applyButton.connect('clicked', () => {
            settings.set_strv('notes-kb-shortcut', [shortcutValue.text]);
        });
        shortcutValue.add_suffix(applyButton);
        controls.add(shortcutValue);
        shortcutValue.sensitive = settings.get_boolean('use-shortcut');
        shortcutRow.connect('notify::active', () => {
            shortcutValue.sensitive = shortcutRow.active;
        });

        const hideRow = new Adw.SwitchRow({
            title: _('Hide the icon'),
            subtitle: _('Keep a shortcut enabled so you can still show notes.'),
        });
        settings.bind('hide-icon', hideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        controls.add(hideRow);

        const files = new Adw.PreferencesGroup({
            title: _('Backup'),
            description: _('Notes are stored as editable Markdown files in ~/notes/.'),
        });
        page.add(files);

        const storageRow = new Adw.ActionRow({
            title: _('Open the storage directory'),
            subtitle: GLib.build_filenamev([GLib.get_home_dir(), 'notes']),
        });
        const openButton = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            valign: Gtk.Align.CENTER,
        });
        openButton.connect('clicked', () => {
            const folder = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_home_dir(), 'notes']));
            Gio.AppInfo.launch_default_for_uri(folder.get_uri(), null);
        });
        storageRow.add_suffix(openButton);
        files.add(storageRow);

        const resetRow = new Adw.ActionRow({
            title: _('Bring notes back to the primary monitor'),
        });
        const resetButton = new Gtk.Button({label: _('Apply'), valign: Gtk.Align.CENTER});
        resetButton.connect('clicked', () => {
            settings.set_boolean('ugly-hack', !settings.get_boolean('ugly-hack'));
        });
        resetRow.add_suffix(resetButton);
        files.add(resetRow);

        const about = new Adw.PreferencesGroup({title: _('About')});
        page.add(about);
        const repoRow = new Adw.ActionRow({title: _('Source code and issue tracker')});
        const repoLink = new Gtk.LinkButton({
            uri: 'https://github.com/zonaro/notes-extension-gnome',
            label: 'GitHub',
            valign: Gtk.Align.CENTER,
        });
        repoRow.add_suffix(repoLink);
        about.add(repoRow);
    }
}
