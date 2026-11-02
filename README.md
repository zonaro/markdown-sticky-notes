# Notes — GNOME Shell extension

Sticky notes for GNOME Shell with editable Markdown files and a built-in preview.

![Notes screenshot](notes@maestroschan.fr/screenshots/about_picture.png)

This fork targets **GNOME Shell 50 and 51**. It uses modern GNOME Shell ECMAScript
modules and GTK4/libadwaita preferences. GNOME 44 and older are **not** supported
by this branch; the older release is available in the Git history.

## Install / update

Requires GNOME Shell 50 or 51, `glib-compile-schemas` and either `curl` or `git`.
Fedora usually ships the required GLib tooling already.

Run the installer directly from a checkout:

```bash
git clone https://github.com/zonaro/notes-extension-gnome.git
cd notes-extension-gnome
./install.sh
```

Or download the installer first and ask it to fetch the latest source from the
repository (review the script before running it):

```bash
curl -fLsS https://raw.githubusercontent.com/zonaro/notes-extension-gnome/master/install.sh -o install-notes.sh
bash install-notes.sh --github
```

The installer targets the current user (no `sudo`), compiles GSettings schemas,
and backs up any previous extension installation under
`~/.local/share/gnome-notes-extension-backups/`.

**Log out and log back in** to load the new extension under Wayland. Then run:

```bash
gnome-extensions enable notes@maestroschan.fr
gnome-extensions prefs notes@maestroschan.fr
```

If enabling fails, check the GNOME Shell logs:

```bash
journalctl --user -b | grep -i 'notes@maestroschan.fr'
```

## Markdown and note storage

Each note is saved as a normal UTF-8 Markdown file in **`~/notes/`**:

- `0.md`, `1.md`, etc.: note content in Markdown.
- `.0.state`, `.1.state`, etc.: position, color, dimensions, and font size.
- `.gnome-notes-migrated`: one-time migration record (if old notes existed).

Edit notes normally, or click the preview button (page icon) on a note to switch
between raw Markdown and a formatted preview. The preview supports headings,
paragraphs, lists, blockquotes, horizontal rules, code blocks, inline code,
**bold**, *italic*, ~~strikethrough~~ and visible link text. Links in the
preview are display-only, not clickable. Markdown files themselves remain
plain text and can be edited with your favorite editor.

When this version is first enabled, notes from
`~/.local/share/notes@maestroschan.fr` are **copied**, including their saved
positions and formatting metadata, into `~/notes/`. Existing `~/notes/` files
are not overwritten, and the original note data is never deleted by migration.
Back up `~/notes/` periodically if you keep important information there.

## Other features

- Toggle notes from the top panel or a configurable keyboard shortcut.
- Create/delete notes, resize and move notes, adjust colors and font size.
- Choose foreground, background, or a three-state cycle.
- GTK4/libadwaita preferences, including a button to open `~/notes/`.
- Languages shipped: English, Spanish, French, Croatian, Dutch, Brazilian
  Portuguese, Turkish, and Chinese (new strings may initially appear in English).

## Build a ZIP

```bash
./build-a-zip.sh
```

The ZIP is rebuilt from the current source; the previously tracked ZIP in older
commits should not be used for GNOME 50/51.

## Validation

Syntax and packaging can be checked without a running Shell; full integration
must be checked on GNOME 50 and GNOME 51, including note rendering, focus,
background mode, keyboard shortcut, and migration.

## License and upstream

GPL-3.0. Original extension by [Romain F. T.](https://github.com/maoschanz/notes-extension-gnome).
