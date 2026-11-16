# Markdown Sticky Notes

A RedClaw GNOME Shell extension — **Markdown Sticky Notes** — rebuilt from [johanan-23/gnome-sticky-notes](https://github.com/johanan-23/gnome-sticky-notes) (GPL-2.0-or-later). The design and editing behavior come from that project; this version makes individual Markdown files the only source of note data. It does **not** run the old Rust/GTK application.

## Features

- Desktop sticky notes with pastel colors, Markdown edit/preview mode, resizing and drag positioning. A note that loses focus switches to **Preview Markdown** automatically; double-click it or choose **Edit Markdown** from the menu to edit again.
- **Pin above windows** / **Unpin note** in each note's right-click menu. Pinned notes are hosted by a separate GNOME Shell chrome layer. Unpinned notes stay below ordinary windows, like the upstream extension. New notes are created pinned by default; the **Pin new notes above windows** preference (Desktop group) turns this off.
- Create, edit, rename or delete Markdown files anywhere in `~/notes/` (recursive) and GNOME's notes appear, update or disappear automatically. `.md`, `.markdown` and `.txt` files are followed at any depth; hidden files and folders are ignored.
- **Folder categories**: every note is an independent desktop window. Its header shows a category pill such as **(projects / 2026)**, derived from its folder path. Root-level notes have no category pill. See [Folder categories](#folder-categories).
- The **zoom** controls (A-/A+ on the bar or **Zoom in/out** on the menu) scale only the written editor/preview content from **5% to 200%**. The frame, header, toolbar and resize handle stay fixed. The per-note zoom is stored in `gnome-sticky-zoom` (`todo-layout` for the TODO note); `gnome-sticky-font-size` is no longer changed by these controls. Legacy selection sizes (`gnome-sticky-sizes`) still render; the bar no longer creates new ones.
- The note context menu has **Copy note**, copying the Markdown body (no frontmatter) to the clipboard.
- **Preview links** open in the default app; **images** (`![alt](src)`, local or `http(s)` with cache) render in the preview; **dot/Graphviz and Mermaid** fenced blocks render as diagrams when the tools are installed (`dot`, or `mmdc` from `@mermaid-js/mermaid-cli`), with a code fallback and an install hint otherwise.
- **Expiring notes**: pick a deadline from the note's context menu (**In 1 hour**, **Tomorrow 09:00**, **In 1 week**, or a custom `YYYY-MM-DD HH:MM`); the note deletes itself — permanently — after that time. The deadline persists in the frontmatter (`gnome-sticky-expires`); edit it externally and the extension follows. A small `⌛` badge shows the deadline in the note's grip. The special TODO note never expires.
- Task list items (`- [ ]`) toggle directly from the **Preview**, without entering edit mode — locked notes included.
- **TODO note** mirrored to a pure [todo.txt](https://todotxt.in/blog/todo-txt-format-complete-guide) file (default `~/todo.txt`): click-to-complete, recurrence and sorting. See [TODO note](#todo-note-todotxt).
- The opposite direction also works: new note = new file; edit = update file; delete = **permanently delete file**.
- No recycle bin, no `notes.json` or `.state` files.
- The Markdown body is normal UTF-8 text. Layout, colors, lock and pin state are embedded in namespaced YAML frontmatter. Unrelated frontmatter fields are preserved.
- User-facing interface labels in Brazilian Portuguese (`pt_BR`), English (`en_US`, default), and Spanish (`es`), selected by the GNOME desktop locale.
- Shortcuts, note menus and settings inherited from the upstream UI.

## Keyboard and mouse shortcuts

**In edit mode** (note focused, editing active):

- `Ctrl+B` / `Ctrl+I` / `Ctrl+U` — Bold / Italic / Underline
- `Ctrl+Shift+X` — Strikethrough · `Ctrl+Shift+C` — inline code
- `Ctrl+Shift+7/8/9` — numbered / bullet / checkbox lists (US and ABNT shifted glyphs `&`, `*`, `(` also work)
- `Ctrl+C` / `Ctrl+X` / `Ctrl+V` / `Ctrl+A` — Copy / Cut / Paste / Select all. Right-clicking the text opens the same editing actions.
- `Escape` — blur to preview · `Enter` — continue list · `Backspace` — delete marker first

**Focused but not editing** (e.g. locked note, or focus on the frame):

- `Middle click` — Copy note · `Ctrl+Middle click` — Duplicate the note
- `Ctrl+C` — Copy note to the clipboard
- `Ctrl+Scroll` — zoom out / in (±10%, 5–200%)
- `Ctrl+Delete` — delete the note (permanent)

**Colors:** the note color swatches now include a final `+` ball for an arbitrary color — type `#RRGGBB` (or `#RGB`), see a live preview and apply with Enter or the ✓ button. It is stored in `gnome-sticky-color-custom`; choosing a preset swatch clears it. Dark custom colors switch the text to a light ink automatically.

## Markdown support

The note body is plain Markdown and stays that way. The formatting bar edits the Markdown source, not a hidden overlay:

- **Bold**, *Italic* and **Strikethrough** wrap the selection in `**…**`, `*…*` and `~~…~~`; a selection already wrapped is unwrapped. With no selection the bar inserts an empty pair with the caret inside.
- **Underline** wraps the selection in inline HTML (`<u>…</u>`), which most Markdown renderers honor.
- List buttons insert Markdown markers: `- ` for bullets, `- [ ] ` for checkboxes and `N. ` for numbered items. Enter continues the list (incrementing numbers), Backspace on a marker removes only the marker, and Enter on an empty item leaves the list.
- **Insert table** drops a 3×2 pipe-table skeleton at the caret, keeping existing text. The preview renders aligned tables with a bold header.
- Headings, code fences, links and horizontal rules are written as ordinary Markdown source and rendered in **Preview Markdown**.
- Task list items can be toggled with a click **in the preview**, no edit mode needed.
- `[label](https://…)` renders underlined and opens on click; relative paths resolve against the note's folder. `javascript:` and other unknown schemes are not clickable.
- `![alt](src)` renders the image on its own line, scaled to the note width. Local files load directly; `http(s)` images are downloaded once into the cache directory and not re-fetched; a missing or broken image renders the alt text.
- Fenced code blocks with info `dot`, `graphviz` or `mermaid` render as diagrams in the preview when the matching tool is installed (dot/Graphviz, or `mmdc`). Otherwise the block renders as code with a one-line install hint, and the preview never breaks. The note's file always keeps the original source — images and diagrams are preview-only.
- The frontmatter is never shown in the note body, in either mode.

The **zoom** controls (A-/A+ on the bar, **Zoom in/out** in the context menu, or `Ctrl+Scroll` outside editing) scale only the **written content** in the editor/preview from 5% to 200%. The frame geometry, grip/header, toolbar, buttons and resize handle remain unchanged. Unlike the retired font-size controls, zoom does not touch the font-size paths: the base font is derived from the zoom factor, and the note stores `gnome-sticky-zoom`. Notes saved by earlier versions with visual styles (`gnome-sticky-spans`) keep rendering them; the bar does not create new ones.

## Expiring notes

A **soon-to-be-gone note** — set an expiration from the note's context menu:

- **In 1 hour**, **Tomorrow 09:00** or **In 1 week** apply immediately; the inline editor also accepts `YYYY-MM-DD HH:MM` for anything else.
- The deadline persists in the frontmatter (`gnome-sticky-expires`); edit the file externally and the extension follows it.
- When the deadline passes, the note is **deleted permanently** — same semantics as the **Delete** menu action (file removed, no undo, no trash).
- A small `⌛` badge with the date/time shows the deadline in the note's grip; it disappears with the note.
- The special TODO note never expires; locked notes keep their deadline too.

## Folder categories

Folders and subfolders under `~/notes/` define categories; they do not create container windows or need marker files. For example, `~/notes/projects/2026/idea.md` appears as an independent note with **(projects / 2026)** in its header. `~/notes/idea.md` has no category pill. Long categories are ellipsized to fit the header; their full path remains available to accessibility tools.

- Create or rename folders with your file manager. Moving a note between folders updates its category automatically; the category is not stored in frontmatter.
- New notes from the top-bar menu start at the root. Duplicating a categorized note keeps the copy in that folder.
- Each note keeps its own desktop position, size, pin/lock and workspace. Clicking or focusing it never reparents it into a folder window. Stored `x/y` coordinates are interpreted as desktop coordinates and clamped to a visible monitor.
- Legacy `.board.md` files are ignored like other hidden files. They are not deleted, rewritten or displayed. Notes within their folders still load normally.
- **Delete all notes → Permanently delete every Markdown note** deletes the note files, not their category folders or unrelated hidden metadata. Deletion is permanent; the special TODO file is unaffected.

## Install / update

Requires GNOME Shell 51 on Wayland for the upstream-tested baseline. The extension metadata also targets GNOME 50, which still needs runtime verification.

```bash
bash -c 'set -e; d=$(mktemp -d); trap "rm -rf \"$d\"" EXIT; curl -fsSL https://github.com/zonaro/markdown-sticky-notes/archive/refs/heads/master.tar.gz | tar -xz -C "$d"; bash "$d/markdown-sticky-notes-master/install.sh"'
```

Copy and paste the single command above to install or update. It downloads the latest `master` archive into a temporary directory, runs the existing installer, then removes the temporary files. Requires `curl`, `tar`, Python 3 and `glib-compile-schemas`. Review the source before executing remote installation commands.

[Documentation and landing page](https://zonaro.github.io/markdown-sticky-notes/) · [Source](https://github.com/zonaro/markdown-sticky-notes)

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
gnome-sticky-zoom: 100
gnome-sticky-expires: "2026-11-20T18:30"
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

## TODO note (todo.txt)

The extension mirrors a plain [todo.txt](https://todotxt.in/blog/todo-txt-format-complete-guide) file as a special desktop note dedicated to tasks. The file stays a **pure** todo.txt — no YAML frontmatter, no extension metadata — readable and writable by any compatible tool, such as `todo.sh`.

- Open or create it from the top-bar menu: **TODO note**. The file is created empty on first use.
- Configure it in **Preferences → TODO notes** with the `todo-file` setting. It accepts `~/todo.txt` (default), absolute paths, or paths relative to the home directory. **An empty value disables the TODO note.**
- **Syntax**: lines follow the todo.txt format — `(A)`–`(Z)` priority, optional `YYYY-MM-DD` creation date (after the priority), `x YYYY-MM-DD ` completion prefix, `+project`, `@context`, and `key:value` tags such as `due:YYYY-MM-DD`, `t:YYYY-MM-DD`, `rec:daily|weekly|monthly` and `est:2h`.
- **Toggle a task** (`x YYYY-MM-DD` is added or removed for you) by clicking the checkbox glyph in the editor, or by clicking the task row in **Preview tasks**. Completed tasks keep their priority, dates and tags.
- **Recurrence**: completing a task with `rec:daily|weekly|monthly` inserts the next occurrence right below it: `due:` (or `t:`) is shifted forward and the new task is dated today.
- **Sort tasks** (right-click menu) reorders the file in place: active tasks by priority then creation date, completed tasks at the end, blank lines where they are.
- **Layout and appearance** (position, size, color, zoom, pin/lock, workspace) live in **GSettings** under `todo-layout` — never in the file — and survive session restarts.
- **Can be deleted from the extension.** The close button in the header and **Delete** in the note menu remove the configured `todo.txt` file permanently and close the note — the same permanent semantics as every other note. **TODO note** in the menu recreates an empty file and reopens the note. External edits update the note and vice versa; the filesystem wins on conflicts.
- **Task actions**: **Insert task above**, **Insert task below** and **Remove task** appear in the note menu when the TODO note is focused. Each inserts or removes a single line, scaffolding a dated task with today's creation date. Lines are validated as todo.txt: a bare description is fine, but malformed dates, empty `+`/`@` markers and unknown `rec:` values are not treated as tasks and cannot be toggled or sorted.
- Ordinary `.txt` files inside `~/notes/` are Markdown notes. Only the single path configured as `todo-file` (default `~/todo.txt`) receives the special todo.txt parser and task behavior.

The editor scaffolds new tasks with today's date when you press Enter on a task line; Enter on an empty scaffold clears it. Backspace at the end of a scaffold peels the date, then the checkbox. Task lines pasted from elsewhere work like any other task for the preview toggle; inline checkbox clicks exist on lines loaded from the file or scaffolded with Enter.

## Development

```bash
npm test
npm run lint:syntax
gjs -m tests/filesync-gjs.test.js
bash tests/install.test.sh
bash -n install.sh tools/pack.sh
./tools/pack.sh
```

Run actual end-to-end tests inside GNOME Shell, including pinned notes above multiple application windows, Wayland input and focus, overview, monitor changes, the folder monitor and directory rename/delete behavior. Static CI tests cannot replace that runtime validation.

For a reproducible local smoke test with a headless renderer, run `sh tests/shell-smoke.sh` (GNOME Shell 50/51, GJS, dconf and Node required). It starts a separate Shell with disposable HOME, settings and note fixtures under `/tmp/opencode/`, asserts real mounted notes, category layout, virtual-key clipboard operations and teardown, and saves a JSON report, screenshot and logs there. It never reads or modifies your notes or enables test extensions in your active desktop session. This does not replace acceptance in your own desktop session after installation.

On Wayland, log out and back in to load updated extension JavaScript. Logs:

```bash
journalctl --user -b | grep -i 'notes@redclaw.com.br'
```

## Attribution and license

Based on [Sticky Notes by johanan-23](https://github.com/johanan-23/gnome-sticky-notes), licensed under **GPL-2.0-or-later**. This repository preserves the upstream LICENSE and adds modifications for Markdown synchronization, per-note pinning and interface localization. The former extension implementation remains available in Git history.
