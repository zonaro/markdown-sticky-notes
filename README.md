# Notes — GNOME Shell Sticky Notes + Markdown

A RedClaw GNOME Shell extension rebuilt from [johanan-23/gnome-sticky-notes](https://github.com/johanan-23/gnome-sticky-notes) (GPL-2.0-or-later). The design and editing behavior come from that project; this version makes individual Markdown files the only source of note data. It does **not** run the old Rust/GTK application.

## Features

- Desktop sticky notes with pastel colors, Markdown edit/preview mode, resizing and drag positioning.
- **Pin above windows** / **Unpin note** in each note's right-click menu. Pinned notes are hosted by a separate GNOME Shell chrome layer. Unpinned notes stay below ordinary windows, like the upstream extension. New notes are created pinned by default; the **Pin new notes above windows** preference (Desktop group) turns this off.
- Create, edit, rename or delete Markdown files in `~/notes/`, and GNOME's notes appear, update or disappear automatically. Only direct `.md` and `.markdown` files are watched, not subdirectories.
- The opposite direction also works: new note = new file; edit = update file; delete = **permanently delete file**.
- No recycle bin, no `notes.json` or `.state` files.
- The Markdown body is normal UTF-8 text. Layout, colors, lock and pin state are embedded in namespaced YAML frontmatter. Unrelated frontmatter fields are preserved.
- User-facing interface labels in Brazilian Portuguese (`pt_BR`), English (`en_US`, default), and Spanish (`es`), selected by the GNOME desktop locale.
- Shortcuts, note menus and settings inherited from the upstream UI.

## Markdown support

The note body is plain Markdown and stays that way. The formatting bar edits the Markdown source, not a hidden overlay:

- **Bold**, *Italic* and **Strikethrough** wrap the selection in `**…**`, `*…*` and `~~…~~`; a selection already wrapped is unwrapped. With no selection the bar inserts an empty pair with the caret inside.
- **Underline** wraps the selection in inline HTML (`<u>…</u>`), which most Markdown renderers honor.
- List buttons insert Markdown markers: `- ` for bullets, `- [ ] ` for checkboxes and `N. ` for numbered items. Enter continues the list (incrementing numbers), Backspace on a marker removes only the marker, and Enter on an empty item leaves the list.
- **Insert table** drops a 3×2 pipe-table skeleton at the caret, keeping existing text. The preview renders aligned tables with a bold header.
- Headings, code fences, links and horizontal rules are written as ordinary Markdown source and rendered in **Preview Markdown**.
- The frontmatter is never shown in the note body, in either mode.

The **font size** buttons (A-/A+) are the exception: Markdown has no font size, so they stay visual and live in the frontmatter (`gnome-sticky-sizes`). Notes saved by earlier versions with visual styles (`gnome-sticky-spans`) keep rendering them; the bar does not create new ones.

## Install / update

Requires GNOME Shell 51 on Wayland for the upstream-tested baseline. The extension metadata also targets GNOME 50, which still needs runtime verification.

```bash
bash -c 'set -e; d=$(mktemp -d); trap "rm -rf \"$d\"" EXIT; curl -fsSL https://github.com/zonaro/notes-extension-gnome/archive/refs/heads/master.tar.gz | tar -xz -C "$d"; bash "$d/notes-extension-gnome-master/install.sh"'
```

Copy and paste the single command above to install or update. It downloads the latest `master` archive into a temporary directory, runs the existing installer, then removes the temporary files. Requires `curl`, `tar`, Python 3 and `glib-compile-schemas`. Review the source before executing remote installation commands.

[Documentation and landing page](https://zonaro.github.io/notes-extension-gnome/) · [Source](https://github.com/zonaro/notes-extension-gnome)

The installer installs to `~/.local/share/gnome-shell/extensions/notes@redclaw.com.br/`, compiles schemas and backs up the previous extension install to `~/.local/share/gnome-notes-extension-backups/`. **It never removes or migrates `~/notes/`.**

For the first install, log out and back in, then run:

```bash
gnome-extensions enable notes@redclaw.com.br
gnome-extensions prefs notes@redclaw.com.br
```

If a different version of the extension is active, disable it separately to prevent duplicate sticky notes.

### Quick synchronization check

```bash
mkdir -p ~/notes
printf '# Sync test\nEdit this file with your editor.\n' > ~/notes/sync-test.md
```

Within a moment, a new desktop note should appear. Editing the file should update the note. Changing the note should update the file. Deleting the note should **delete `sync-test.md`**, and deleting a file in the folder should remove its note from the desktop.

Right-click a note to switch between **Edit Markdown** and **Preview Markdown**. The frontmatter remains hidden from the note body in both modes. New notes start pinned above ordinary windows by default; toggle **Pin new notes above windows** in Preferences to change that. To pin or unpin an individual note regardless, use **Pin above windows** / **Unpin note**.

## File format

```markdown
---
title: My own custom title
gnome-sticky-id: 1
gnome-sticky-x: 120
gnome-sticky-y: 90
gnome-sticky-width: 250
gnome-sticky-height: 180
gnome-sticky-expanded-height: 180
gnome-sticky-color: 4
gnome-sticky-font-size: 13
gnome-sticky-workspace: 0
gnome-sticky-pinned: true
gnome-sticky-locked: false
gnome-sticky-spans: []
gnome-sticky-sizes: []
---
# Hello
This is an ordinary Markdown file.
```

Existing Markdown files without frontmatter are accepted and receive default note metadata when the extension saves them. Earlier `gnome-notes-` geometry keys are read for compatibility. Changes are debounced, and self-generated file-monitor notifications are ignored by content comparison. If the file is modified externally just before an extension save, the file has priority to prevent accidental overwrite.

**Deletion is permanent inside this extension.** Consider syncing/backing up `~/notes/` if you need revision history or recovery. The extension does not delete notes when the directory cannot be scanned.

## Development

```bash
npm test
npm run lint:syntax
bash -n install.sh tools/pack.sh
./tools/pack.sh
```

Run actual end-to-end tests inside GNOME Shell, including pinned notes above multiple application windows, Wayland input and focus, overview, monitor changes, the folder monitor and directory rename/delete behavior. Static CI tests cannot replace that runtime validation.

On Wayland, log out and back in to load updated extension JavaScript. Logs:

```bash
journalctl --user -b | grep -i 'notes@redclaw.com.br'
```

## Attribution and license

Based on [Sticky Notes by johanan-23](https://github.com/johanan-23/gnome-sticky-notes), licensed under **GPL-2.0-or-later**. This repository preserves the upstream LICENSE and adds modifications for Markdown synchronization, per-note pinning and interface localization. The former extension implementation remains available in Git history.
