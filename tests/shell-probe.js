// Copied into a disposable test extension by shell-smoke.sh; never installed normally.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'notes@redclaw.com.br';
const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
async function until(predicate, message, timeout = 5000) {
    const deadline = GLib.get_monotonic_time() + timeout * 1000;
    while (!predicate()) {
        if (GLib.get_monotonic_time() > deadline)
            throw new Error(message);
        await pause(30);
    }
}
const disk = path => Gio.File.new_for_path(path);
const read = path => new TextDecoder().decode(disk(path).load_contents(null)[1]);
const descendants = root => {
    const actors = [];
    const visit = actor => {
        actors.push(actor);
        for (const child of actor.get_children?.() ?? [])
            visit(child);
    };
    visit(root);
    return actors;
};
const namedButton = (root, name) => descendants(root).find(actor =>
    actor instanceof St.Button && actor.accessible_name === name);

export default class NotesAcceptance extends Extension {
    enable() {
        this._checks = [];
        this._run().then(() => this._report(null), error => this._report(error));
    }

    disable() {
        this._keyboard?.run_dispose();
        this._keyboard = null;
    }

    _check(condition, message) {
        if (!condition)
            throw new Error(message);
        this._checks.push(message);
    }

    _report(error) {
        this.disable();
        const result = {ok: !error, checks: this._checks, error: error ? `${error}\n${error.stack}` : null};
        GLib.file_set_contents(`${GLib.getenv('NOTES_SMOKE_DIR')}/result.json`, JSON.stringify(result, null, 2));
    }

    async _chord(key, shift = false) {
        const modifiers = [Clutter.KEY_Control_L, ...(shift ? [Clutter.KEY_Shift_L] : [])];
        const notify = (value, state) => this._keyboard.notify_keyval(GLib.get_monotonic_time(), value, state);
        for (const modifier of modifiers) {
            notify(modifier, Clutter.KeyState.PRESSED);
            await pause(15);
        }
        notify(key, Clutter.KeyState.PRESSED);
        await pause(20);
        notify(key, Clutter.KeyState.RELEASED);
        for (const modifier of modifiers.reverse())
            notify(modifier, Clutter.KeyState.RELEASED);
        await pause(120);
    }

    _headerFits(view) {
        const {categoryPill: category, expiryBadge: expiry, pill, closeButton: close} = view;
        const right = actor => actor.x + actor.width;
        return (!category?.visible || (category.width > 0 && right(category) <= view.note.w)) &&
            (!expiry.visible || right(expiry) <= view.note.w) &&
            (!category?.visible || !expiry.visible || right(category) + 1 <= expiry.x) &&
            (!pill.visible || !expiry.visible || right(pill) <= expiry.x) &&
            (!close || (close.x >= 0 && right(close) <= view.note.w)) &&
            (!category?.visible || !close || right(category) <= close.x || right(close) <= category.x) &&
            (!close || !expiry.visible || right(expiry) <= close.x || right(close) <= expiry.x);
    }

    async _run() {
        await until(() => Main.extensionManager.lookup(UUID)?.state === ExtensionState.ACTIVE,
            'notes extension did not become ACTIVE', 15000);
        const instance = Extension.lookupByUUID(UUID);
        const notes = instance._notes;
        Main.overview.hide();
        await pause(500);
        log('CHECK 1: mount');
        this._check(notes.status().notes === 7 && notes._views.size === 8,
            'all seven format fixtures and raw TODO mounted (hidden metadata ignored)');
        const root = notes._byFilename.get('root.md');
        const nested = notes._byFilename.get('projects/2026/note.md');
        const long = notes._byFilename.get('Long category with accents ações/Another long folder/idea.txt');
        const html = notes._byFilename.get('web/safe.html');
        const alpha = notes._byFilename.get('stickers/alpha.png');
        const photo = notes._byFilename.get('stickers/photo.jpg');
        const corrupt = notes._byFilename.get('stickers/corrupt.jpg');
        const todo = [...notes._views.values()].find(view => view.note.kind === 'todo');
        this._check([root, nested, long, html, alpha, photo, corrupt, todo].every(Boolean),
            'every expected format has a mounted view');
        this._check(root.note.format === 'markdown' && long.note.format === 'text' &&
            html.note.format === 'html' && alpha.note.format === 'image' &&
            photo.note.format === 'image' && corrupt.note.format === 'image',
        'file extensions select the expected rendering format');
        const plainSource = '# Literal TXT\n*stars stay literal*\n' +
            '[link](javascript:alert(1))\n- [ ] plain checkbox\n';
        const htmlSource = '<h1>Safe HTML</h1><p onclick="alert(1)">Visible ' +
            '<strong>content</strong>.</p><script>globalThis.PWNED=true</script>' +
            '<iframe src="https://evil.example"></iframe>' +
            '<a href="javascript:alert(2)">Text link</a>\n';
        const home = GLib.get_home_dir();
        this._check(read(`${home}/notes/${long.note.filename}`) === plainSource &&
            long.note.text === plainSource && !long.ribbon,
        'TXT stays byte-for-byte plain and has no Markdown toolbar');
        notes._togglePreview(long);
        const plainMarkup = long.previewRows.map(row => row.pango).join('\n');
        this._check(plainMarkup.includes('# Literal TXT') &&
            plainMarkup.includes('*stars stay literal*') &&
            !plainMarkup.includes('<b>') && !plainMarkup.includes('<i>') &&
            long.previewRows.every(row => row.links.length === 0),
        'TXT preview keeps headings, stars, links and checkboxes literal');
        notes._togglePreview(long);
        const safeHtmlPreview = JSON.stringify(html.previewRows);
        this._check(html.previewMode && html.previewRows.some(row => row.plain === 'Safe HTML') &&
            safeHtmlPreview.includes('Visible') && safeHtmlPreview.includes('content') &&
            safeHtmlPreview.includes('Text link'),
        'safe HTML text and formatting render predictably');
        this._check(!safeHtmlPreview.includes('PWNED') && !safeHtmlPreview.includes('evil.example') &&
            !safeHtmlPreview.includes('javascript:') && !safeHtmlPreview.includes('onclick') &&
            html.previewRows.every(row => row.links.length === 0),
        'HTML preview removes active content, handlers and active URLs');
        this._check(read(`${home}/notes/${html.note.filename}`) === htmlSource &&
            html.note.text === htmlSource && !html.ribbon,
        'HTML source stays unchanged and has no Markdown toolbar');
        this._check(alpha.previewOnly && alpha.previewMode && !alpha.text.visible &&
            !alpha.ribbon && alpha.card.has_style_class_name('image-sticker') &&
            alpha.card.style.includes('transparent'),
        'PNG mounts as an isolated sticker without editor, paper or Markdown toolbar');
        log(`DEBUG alpha.stickerContent: ${JSON.stringify(alpha.stickerContent ? {
            _imageWidget: !!alpha.stickerContent._imageWidget,
            _imageHasAlpha: alpha.stickerContent._imageHasAlpha,
            _imageWidth: alpha.stickerContent._imageWidth,
            _imageHeight: alpha.stickerContent._imageHeight,
        } : null)}`);
        this._check(!!alpha.stickerContent?._imageWidget &&
            alpha.stickerContent._imageHasAlpha === true,
        'PNG preserves alpha channel');
        this._check(alpha.stickerContent._imageWidth >= 1 &&
            alpha.stickerContent._imageHeight >= 1,
        'PNG renders at a positive size');
        this._check(!!photo.stickerContent?._imageWidget &&
            photo.stickerContent._imageHasAlpha === false,
        'JPEG renders as opaque');
        this._check(photo.stickerContent._imageWidth >= 1 &&
            photo.stickerContent._imageHeight >= 1,
        'JPEG renders at a positive size');
        this._check(!corrupt.stickerContent?._imageWidget &&
            corrupt.stickerContent?.has_style_class_name('invalid'),
        'corrupted image uses a safe placeholder without breaking the extension');
        log('CHECK 2: category pill text');
        this._check(nested.categoryPill.accessible_name === '(projects) / (2026)',
            'nested category pills match folder levels');
        log('CHECK 3: no category on root/TODO');
        this._check(!root.categoryPill && !todo.categoryPill, 'root and TODO have no category pill');
        log('CHECK 4: accessible name');
        this._check(long.categoryPill.accessible_name === '(Long category with accents ações) / (Another long folder)',
            'long category retains its full accessible name');
        log('CHECK 4b: close button and header height');
        this._check(!!nested.closeButton && !todo.closeButton,
            'regular notes have a close button; TODO does not');
        this._check(nested.grip.height === 24, 'header height increased to 24');
        const closeOnRight = nested.closeButton.x > nested.note.w / 2;
        this._check(closeOnRight === !notes._closeOnLeft,
            'close button follows the GNOME button-layout side');
        log('CHECK 4c: closing a note deletes it');
        const beforeClose = new Set(notes._views.values());
        notes._create(null);
        const closing = [...notes._views.values()].find(view => !beforeClose.has(view));
        this._check(!!closing, 'a disposable note was created for the close test');
        notes._write();
        const closingFile = `${home}/notes/${closing.note.filename}`;
        this._check(disk(closingFile).query_exists(null),
            'the disposable note file exists before closing');
        closing.closeButton.emit('clicked', 1);
        await pause(40);
        this._check(!notes._views.has(closing.note.id) &&
            !notes._store.notes.includes(closing.note) &&
            !disk(closingFile).query_exists(null),
        'closing a note deletes its source file and removes the view');
        notes._toggle();
        await pause(30);
        this._check(!nested.frame.visible, 'hiding notes hides every note');
        notes._toggle();
        await pause(30);
        this._check(nested.frame.visible, 'showing notes restores every note');
        for (const view of [nested, root]) {
            for (const width of [168, 900, 300]) {
                view.note.w = width;
                view.note.expires = '2099-11-20T18:30';
                notes._layout(view);
                notes._updateExpiryBadge(view);
                await pause(50);
                log(`CHECK width ${width}`);
                this._check(this._headerFits(view), `header fits at width ${width}, category=${!!view.categoryPill}`);
                view.note.expires = null;
                notes._updateExpiryBadge(view);
            }
        }
        long.note.w = 168;
        notes._layout(long);
        const narrow = long.categoryPill.width;
        long.note.w = 500;
        notes._layout(long);
        log('CHECK ellipsis expand');
        this._check(long.categoryPill.width > narrow, 'ellipsized category expands again after widening');
        long.note.w = 300;
        notes._layout(long);
        const geometry = [nested.note.w, nested.note.h, nested.grip.height];
        notes._stepZoom(nested, 100);
        notes._stepZoom(nested, -195);
        log('CHECK zoom');
        this._check(JSON.stringify(geometry) === JSON.stringify([nested.note.w, nested.note.h, nested.grip.height]),
            '5% and 200% content zoom leave note geometry and header unchanged');
        notes._stepZoom(nested, 95);
        alpha.note.w = 168;
        alpha.note.h = 120;
        notes._layout(alpha);
        notes._refreshPreview(alpha);
        this._check(alpha.stickerContent._imageWidth <= 160 &&
            alpha.stickerContent._imageHeight <= 88 &&
            Math.abs(alpha.stickerContent._imageWidth / alpha.stickerContent._imageHeight - 2) < 0.01,
        'image sticker scales down to its resized bounds without distortion');
        alpha.note.w = 260;
        alpha.note.h = 180;
        notes._layout(alpha);
        notes._refreshPreview(alpha);
        for (let index = 0; index < 2; index++) {
            notes._togglePin(nested);
            notes._focus(nested, false);
            log(`CHECK pin ${index}`);
            this._check(nested.frame.visible && nested.frame.get_parent() === notes._layerFor(nested.note),
                `focused category note remains visible on its own layer after pin toggle ${index + 1}`);
        }
        if (nested.previewMode)
            notes._togglePreview(nested);
        notes._focus(nested, true);
        await until(() => global.stage.get_key_focus() === nested.text, 'editor did not receive focus');
        this._keyboard = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, 'pasted acceptance text');
        nested.text.set_selection(0, -1);
        await this._chord(Clutter.KEY_v);
        await until(() => nested.text.text === 'pasted acceptance text', 'native Ctrl+V did not paste');
        log('CHECK ctrl+v');
        this._check(true, 'native Ctrl+V replaces the editor selection');
        await this._chord(Clutter.KEY_a);
        this._check(nested.text.get_selection() === nested.text.text, 'native Ctrl+A selects all editor text');
        await this._chord(Clutter.KEY_c);
        const copied = await new Promise(resolve => clipboard.get_text(St.ClipboardType.CLIPBOARD,
            (_clipboard, text) => resolve(text)));
        this._check(copied === nested.text.text, 'native Ctrl+C copies the editor selection');
        await this._chord(Clutter.KEY_x);
        this._check(nested.text.text === '', 'native Ctrl+X cuts the editor selection');
        await this._chord(Clutter.KEY_v);
        await until(() => nested.text.text === copied, 'paste after cut failed');
        nested.text.set_selection(0, -1);
        await this._chord(Clutter.KEY_c, true);
        this._check(nested.text.text === `\`${copied}\``, 'Ctrl+Shift+C still formats inline code');
        nested.text.set_selection(0, -1);
        await this._chord(Clutter.KEY_x, true);
        this._check(nested.text.text.includes('~~'), 'Ctrl+Shift+X still formats strikethrough');
        const lockedText = nested.text.text;
        nested.note.locked = true;
        notes._paint(nested);
        clipboard.set_text(St.ClipboardType.CLIPBOARD, 'must not overwrite locked text');
        await this._chord(Clutter.KEY_v);
        this._check(nested.text.text === lockedText, 'locked notes reject native clipboard paste');
        nested.note.locked = false;
        notes._paint(nested);
        if (nested.previewMode)
            notes._togglePreview(nested);
        notes._focus(nested, true);
        clipboard.set_text(St.ClipboardType.CLIPBOARD, 'context menu paste');
        nested.text.set_selection(0, -1);
        log('CHECK text edit menu');
        notes._openTextEditMenu(nested, null);
        this._check(notes._menu?.isOpen, 'text editing context menu opens without runtime error');
        await pause(150);
        this._check(notes._menu?.isOpen && !nested.previewMode,
            'editing menu keeps its source visible while it owns key focus');
        const paste = notes._menu._getMenuItems().find(item => item.label?.text === 'Paste');
        await until(() => paste?.sensitive, 'context-menu paste did not become available');
        paste.activate(null);
        await until(() => nested.text.text === 'context menu paste', 'context-menu paste did not replace selection');
        this._check(true, 'context-menu Paste preserves selection and edits text after menu close');
        log('CHECK 4d: editing first H1 renames the note file');
        notes._focus(nested, true);
        await until(() => global.stage.get_key_focus() === nested.text, 'editor did not receive focus');
        nested.text.set_selection(0, -1);
        await this._chord(Clutter.KEY_a);
        await pause(20);
        nested.text.set_text('# Novo título do H1\nConteúdo mantido');
        await pause(200);
        this._check(nested.note.filename.endsWith('Novo-titulo-do-H1.md') ||
            nested.note.filename.includes('Novo-titulo-do-H1-'),
        'first H1 edit renames the .md file (timestamp suffix if conflict)');
        this._check(nested.note.text.startsWith('# Novo título do H1'),
        'note text updated with new H1');
        notes._openMenu(nested);
        this._check(notes._menu?.isOpen, 'ordinary note menu opens without container actions');
        notes._closeMenu();
        const openCases = [
            [root, 'root Markdown'],
            [nested, 'categorized Markdown'],
            [long, 'plain TXT'],
            [html, 'safe HTML'],
            [alpha, 'alpha PNG sticker'],
            [photo, 'JPEG sticker'],
            [corrupt, 'corrupted image placeholder'],
            [todo, 'special TODO'],
        ];
        for (const [view, label] of openCases) {
            notes._openMenu(view);
            this._check(notes._menu?.isOpen, `${label} context menu opens`);
            notes._closeMenu();
        }
        notes._openMenu(long);
        this._check(!!namedButton(notes._menu.box, 'Preview text') &&
            !namedButton(notes._menu.box, 'Preview Markdown'),
        'TXT menu exposes plain-text preview instead of Markdown preview');
        notes._closeMenu();
        notes._openMenu(html);
        this._check(!!namedButton(notes._menu.box, 'Edit HTML source') &&
            !namedButton(notes._menu.box, 'Edit Markdown'),
        'HTML menu exposes sanitized preview/source editing instead of Markdown editing');
        notes._closeMenu();
        notes._openMenu(alpha);
        this._check(!!namedButton(notes._menu.box, 'Edit in') &&
            !namedButton(notes._menu.box, 'Copy note') &&
            !namedButton(notes._menu.box, 'Preview Markdown') &&
            !namedButton(notes._menu.box, 'Lock') &&
            !namedButton(notes._menu.box, 'Zoom in') &&
            !namedButton(notes._menu.box, 'Blossom'),
        'image sticker menu omits text, formatting, color and content zoom actions');
        notes._closeMenu();
        root.note.locked = true;
        notes._paint(root);
        notes._openMenu(root);
        this._check(!!namedButton(notes._menu.box, 'Unlock'), 'locked-note menu opens with Unlock action');
        notes._closeMenu();
        root.note.locked = false;
        notes._paint(root);
        if (!root.previewMode)
            notes._togglePreview(root);
        notes._openMenu(root);
        this._check(!!namedButton(notes._menu.box, 'Edit Markdown'), 'preview-note menu opens with Edit action');
        notes._closeMenu();
        notes._togglePreview(root);
        root.note.w = 168;
        notes._layout(root);
        notes._openMenu(root);
        this._check(notes._menu?.isOpen, 'narrow-note context menu opens');
        notes._closeMenu();
        root.note.w = 300;
        notes._layout(root);

        const activate = async (view, name) => {
            notes._openMenu(view);
            const button = namedButton(notes._menu.box, name);
            this._check(!!button, `${name} action is present`);
            button.emit('clicked', 1);
            await pause(40);
        };

        notes._openMenu(root);
        namedButton(notes._menu.box, 'Blossom').emit('clicked', 1);
        this._check(root.note.color === 1 && notes._menu?.isOpen,
            'color swatch updates the note immediately without closing the menu');
        namedButton(notes._menu.box, 'Custom color').emit('clicked', 1);
        const customEditor = descendants(notes._menu.box).find(actor =>
            actor.has_style_class_name?.('sticky-swatch-editor'));
        this._check(!!customEditor, 'custom-color control expands immediately');
        customEditor._entry.text = 'energia';
        this._check(customEditor._preview.style.includes('#e91c4f'),
            'NameToColor mood preview updates immediately');
        customEditor._applyButton.emit('clicked', 1);
        this._check(root.note.custom_color === 'energia' && root.card.style.includes('#e91c4f'),
            'NameToColor expression applies immediately and preserves the original input');
        notes._closeMenu();

        const beforeNew = new Set(notes._views.values());
        await activate(root, 'New note');
        const created = [...notes._views.values()].find(view => !beforeNew.has(view));
        this._check(!!created && !notes._menu, 'New note executes immediately and closes the menu');
        await activate(created, 'Delete');
        this._check(!notes._views.has(created.note.id), 'Delete executes immediately for a disposable note');

        const beforeDuplicate = new Set(notes._views.values());
        await activate(nested, 'Duplicate');
        const clickedDuplicate = [...notes._views.values()].find(view => !beforeDuplicate.has(view));
        this._check(clickedDuplicate?.note.filename.startsWith('projects/2026/'),
            'Duplicate executes immediately and keeps the category');

        await activate(nested, 'Copy note');
        const copiedNote = await new Promise(resolve => clipboard.get_text(St.ClipboardType.CLIPBOARD,
            (_clipboard, text) => resolve(text)));
        this._check(copiedNote === nested.note.text, 'Copy note updates the clipboard immediately');

        const originalExternalApps = notes._externalAppsForView;
        const originalExternalLaunch = notes._launchExternalEditor;
        const acceptanceApp = {
            get_id: () => 'acceptance-editor.desktop',
            get_display_name: () => 'Acceptance Editor',
            get_icon: () => null,
            should_show: () => true,
            supports_files: () => true,
            supports_uris: () => false,
        };
        let launchedExternally = null;
        notes._externalAppsForView = () => [acceptanceApp];
        notes._launchExternalEditor = (view, app) => {
            launchedExternally = {view, app};
        };
        notes._openMenu(nested);
        namedButton(notes._menu.box, 'Edit in').emit('clicked', 1);
        this._check(notes._menu._externalEditorChooser.visible,
            'Edit in expands the compatible-application list immediately');
        namedButton(notes._menu._externalEditorChooser, 'Acceptance Editor').emit('clicked', 1);
        await pause(40);
        this._check(launchedExternally?.view === nested &&
            launchedExternally?.app === acceptanceApp && !notes._menu,
        'choosing an external editor launches the selected app and closes the menu');
        notes._externalAppsForView = originalExternalApps;
        notes._launchExternalEditor = originalExternalLaunch;

        if (nested.previewMode)
            notes._togglePreview(nested);
        await activate(nested, 'Preview Markdown');
        this._check(nested.previewMode, 'Preview Markdown updates the note immediately');
        await activate(nested, 'Edit Markdown');
        this._check(!nested.previewMode, 'Edit Markdown updates the note immediately');

        const wasPinned = nested.note.pinned;
        await activate(nested, wasPinned ? 'Unpin note' : 'Pin above windows');
        this._check(nested.note.pinned !== wasPinned, 'pin action updates the note immediately');
        await activate(nested, nested.note.pinned ? 'Unpin note' : 'Pin above windows');
        this._check(nested.note.pinned === wasPinned, 'opposite pin action restores the note immediately');

        await activate(nested, 'Lock');
        this._check(nested.note.locked, 'Lock updates the note immediately');
        await activate(nested, 'Unlock');
        this._check(!nested.note.locked, 'Unlock updates the note immediately');

        notes._openMenu(nested);
        namedButton(notes._menu.box, 'Category').emit('clicked', 1);
        await pause(50);
        // Category picker is a separate PopupMenu, find it
        let picker = null;
        for (const m of notes._menuManager._menus) {
            if (m.actor.has_style_class_name('sticky-category-picker')) {
                picker = m;
                break;
            }
        }
        this._check(!!picker && picker.isOpen, 'Category picker opens immediately');
        // Test selecting "(no category)" - picker items might be added async
        await pause(100);
        const items = picker._getMenuItems();
        this._check(items.length > 0, 'Category picker has menu items');
        let noCatItem = null;
        for (const item of items) {
            // Test runs with LC_ALL=C so translation returns the key
            if (item._label?.text === '(no category)' ||
                (item.label?.text === '(no category)') ||
                (item.actor._label?.text === '(no category)')) {
                noCatItem = item;
                break;
            }
        }
        this._check(!!noCatItem, 'No category item exists');
        const originalFilename = nested.note.filename;
        const expectedBase = nested.note.filename.split('/').pop();
        noCatItem.activate(null);
        await pause(40);
        this._check(nested.note.filename === expectedBase && !picker.isOpen,
            'Category picker: selecting (no category) moves note to root and closes picker');
        // Restore original category for subsequent tests
        const parts = originalFilename.split('/').slice(0, -1);
        const originalCategory = parts.join('/');
        if (originalCategory) {
            await notes._applyCategory(nested, originalCategory);
            await pause(40);
        }

        this._check(notes._applyCategory(alpha, 'media/stickers'),
            'image sticker category move executes without conversion');
        await pause(60);
        this._check(alpha.note.filename === 'media/stickers/alpha.png' &&
            photo.note.filename === 'media/stickers/photo.jpg' &&
            corrupt.note.filename === 'media/stickers/corrupt.jpg' &&
            disk(`${home}/notes/media/stickers/alpha.png`).query_exists(null) &&
            disk(`${home}/notes/media/stickers/.alpha.png.sticky-note.json`).query_exists(null) &&
            !disk(`${home}/notes/stickers/alpha.png`).query_exists(null),
        'moving an image category preserves image extensions and moves metadata sidecars');
        this._check(!!alpha.stickerContent?._imageWidget &&
            alpha.note.sourcePath.endsWith('/media/stickers/alpha.png'),
        'moved image sticker reloads from its new category path');

        notes._openMenu(root);
        namedButton(notes._menu.box, 'Expiry').emit('clicked', 1);
        const expiryEditor = notes._menu._expiryEditor;
        this._check(expiryEditor.visible, 'Expiry expands immediately');
        expiryEditor._dateButton.emit('clicked', 1);
        this._check(expiryEditor._calendar.actor.visible, 'expiry button opens the Shell calendar');
        const pickedDay = descendants(expiryEditor._calendar.actor)
            .find(actor => actor instanceof St.Button && actor._date &&
                actor._date.getDate() !== expiryEditor._calendar.selectedDate.getDate());
        pickedDay.emit('clicked', 1);
        const pickedExpiry = root.note.expires;
        this._check(!!pickedExpiry && notes._menu?.isOpen,
            'calendar day selection updates expiry immediately');
        namedButton(expiryEditor._calendar.actor, 'Fifteen minutes later').emit('clicked', 1);
        this._check(root.note.expires !== pickedExpiry, 'calendar time controls update expiry immediately');
        expiryEditor._clearButton.emit('clicked', 1);
        this._check(root.note.expires === null, 'Clear expiry updates the note immediately');
        notes._closeMenu();

        nested.note.zoom = 100;
        await activate(nested, 'Zoom in');
        this._check(nested.note.zoom === 110, 'Zoom in updates immediately');
        await activate(nested, 'Zoom out');
        this._check(nested.note.zoom === 100, 'Zoom out updates immediately');

        todo.note.text = '(B) z task\n(A) a task\n';
        await activate(todo, 'Sort tasks');
        this._check(todo.note.text.indexOf('(A) a task') < todo.note.text.indexOf('(B) z task'),
            'Sort tasks executes immediately');
        notes._openMenu(todo);
        this._check(namedButton(notes._menu.box, 'Duplicate').reactive === false &&
            namedButton(notes._menu.box, 'Delete').reactive === false,
        'TODO keeps destructive note actions disabled');
        notes._closeMenu();

        instance._menu._refresh();
        this._check(instance._menu._deleteAll.sensitive, 'top-bar note menu refresh remains functional');
        const before = notes.status().notes;
        notes._duplicate(nested);
        const duplicate = [...notes._views.values()].find(view => view !== nested &&
            view.note.filename.startsWith('projects/2026/'));
        this._check(notes.status().notes === before + 1 && duplicate?.categoryPill.text === nested.categoryPill.text,
            'duplicated notes keep their category folder');
        notes.create([980, 480]);
        this._check(notes.status().notes === before + 2, 'new-note creation still mounts a real view');
        notes._toggleBoxLineAt(root, 1);
        this._check(root.note.text.includes('[x]'), 'Markdown preview checkbox toggle remains functional');
        notes._toggleTodoAt(todo, 0);
        this._check(todo.note.text.includes('x '), 'special TODO task completion remains functional');
        notes._write();
        this._check(!read(`${home}/todo.txt`).startsWith('---'), 'TODO writes remain raw without frontmatter');
        this._check(read(`${home}/notes/${long.note.filename}`) === plainSource &&
            disk(`${home}/notes/Long category with accents ações/Another long folder/.idea.txt.sticky-note.json`)
                .query_exists(null),
        'TXT save keeps pure source and persists layout only in its sidecar');
        this._check(read(`${home}/notes/${html.note.filename}`) === htmlSource &&
            disk(`${home}/notes/web/.safe.html.sticky-note.json`).query_exists(null),
        'HTML save keeps untrusted source unchanged and persists layout only in its sidecar');
        notes._blur();
        await pause(200);
        const stream = disk(`${GLib.getenv('NOTES_SMOKE_DIR')}/desktop.png`).replace(
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        const [success] = await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
        this._check(success, 'real isolated-shell screenshot saved');
        notes.deleteAll();
        notes._files.scan();
        this._check(notes.status().notes === 0 && disk(`${home}/todo.txt`).query_exists(null),
            'delete-all removes ordinary notes only, retaining special TODO');
        this._check(read(`${home}/notes/projects/2026/.board.md`) === '# Inert legacy metadata\n' &&
            disk(`${home}/notes/projects/2026/unrelated.json`).query_exists(null),
            'category directories, hidden metadata and unrelated files survive delete-all');
        this._check(!disk(`${home}/notes/media/stickers/alpha.png`).query_exists(null) &&
            !disk(`${home}/notes/media/stickers/.alpha.png.sticky-note.json`).query_exists(null) &&
            !disk(`${home}/notes/web/safe.html`).query_exists(null) &&
            !disk(`${home}/notes/web/.safe.html.sticky-note.json`).query_exists(null),
        'delete-all removes each supported source and only its owned sidecar');
        // Do not disable the main extension here; doing so causes the probe
        // extension to be re-enabled by the shell, losing accumulated checks.
        // The harness terminates the shell after result.json is written.
    }
}
