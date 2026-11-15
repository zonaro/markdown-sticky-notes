# GNOME 50/51 runtime QA — Issue #1

**Status:** manual desktop verification required. Static checks and GJS filesystem tests run in GitHub Actions, but those are not a substitute for GNOME Shell 50 and 51 desktop sessions.

## Setup (repeat for each version)
1. Save a copy of any important files from `~/notes/`.
2. Verify version: `gnome-shell --version` and session: `echo "$XDG_SESSION_TYPE"`.
3. Install current `master` with the documented one-liner, or run `bash install.sh --github` from a checkout.
4. Disable `notes@maestroschan.fr` if installed; log out and back in.
5. Enable `notes@redclaw.com.br`; check that preferences open.

## Shell UI
- [ ] Create, edit, move, resize, duplicate, lock, recolor, hide/show and permanently delete a note.
- [ ] Switch between **Edit Markdown** and **Preview Markdown**, checking headings, checklists, and that frontmatter is never shown as note content.
- [ ] Use the formatting bar on a selection: **Bold**, *Italic* and **Strikethrough** wrap it in `**…**`, `*…*` and `~~…~~`; selecting again and pressing the same button unwraps it. **Underline** emits `<u>…</u>`. Check the saved `.md` ends up with the markers.
- [ ] Press the same buttons with nothing selected: an empty pair is inserted and the caret lands inside it; typing stays inside the pair.
- [ ] Bullet, checkbox and numbered list buttons emit `- `, `- [ ] ` and `N. ` in the `.md`. Enter continues a list with the incremented number; Backspace on a marker removes only the marker; Enter on an empty item exits the list.
- [ ] **Insert table** drops a 3×2 pipe-table skeleton at the caret (existing text is kept); **Preview Markdown** renders it with borders, a bold header and aligned columns.
- [ ] Open a note saved by an older version (with `gnome-sticky-spans`); its visually styled text keeps rendering in the editor.
- [ ] Type in a note, then Alt+Tab away: the note renders as preview. Click on another note; the unfocused one becomes preview. Escape also switches the focused note to preview.
- [ ] Double-click the preview: editing mode returns with a usable caret. A single click does nothing. Locked notes do not re-enter editing via double-click.
- [ ] The note menu keeps switching between **Edit Markdown** and **Preview Markdown**.
- [ ] A note just created starts in edit mode and becomes preview only after losing focus.
- [ ] Pin an individual note above app windows and unpin it; test focus, pointer clicks outside the note, and Alt+Tab.
- [ ] With the **Pin new notes above windows** preference on (default) and off, create notes and confirm the layer placement; confirm existing notes keep their pin state.
- [ ] Move between workspaces and test foreground/background ordering.
- [ ] Restart the session and confirm text, position, size, color, lock/pin state and global visibility survive.
- [ ] Use GNOME shortcuts and change options in GTK4/libadwaita preferences.

## Bidirectional synchronization
- [ ] Create `~/notes/reuniao.md` and `~/notes/tarefas.markdown` externally; both appear.
- [ ] Edit both files externally; note bodies update without duplicated notes.
- [ ] Edit a sticky note; the corresponding Markdown file updates.
- [ ] Create a sticky note; a new `note-<timestamp>.md` file appears.
- [ ] Rename `tarefas.markdown` to `novas-tarefas.md`; same note content and metadata remain.
- [ ] Delete a note; *only* its file disappears, without an extension trash.
- [ ] Delete `reuniao.md` externally; the sticky note disappears and the file stays deleted.
- [ ] `.txt`, `.md` and `.markdown` files at any depth are independent notes; hidden files and folders never become notes, including legacy `.board.md` metadata.
- [ ] Disable and enable the extension; verify no duplicates.

## Frontmatter and installer
- [ ] Open a plain Markdown file with no frontmatter; the extension adds defaults without changing the Markdown body.
- [ ] Open an invalid field (`gnome-notes-x: abc`); defaults apply without crashing.
- [ ] Open a file with an unterminated YAML header; literal original text is not discarded.
- [ ] Edit a file with user fields like `title` and `tags`; those fields are preserved.
- [ ] Verify no `.state`, `notes.json`, legacy import or migration is performed.
- [ ] Reinstall and verify the previous extension is backed up while `~/notes/` remains intact.

## TODO note (todo.txt)
- [ ] With `~/todo.txt` present, the note appears; external edits update the note and vice versa, without duplicates.
- [ ] Clicking the checkbox glyph in the editor toggles `x YYYY-MM-DD` and flips ☐/☑; clicking a task row in **Preview tasks** does the same; priority, creation date, projects, contexts and tags survive both.
- [ ] Enter on a task line inserts `YYYY-MM-DD <today>` scaffold; Enter on the scaffold clears it; Backspace at the end of a scaffold peels the date first, then the checkbox.
- [ ] Completing a task with `rec:daily|weekly|monthly` inserts the next occurrence right below, with `due:` (or `t:`) shifted and the creation date set to today.
- [ ] **Sort tasks** (right-click menu) orders active tasks by priority then creation date; completed tasks move to the end; blank lines keep their position; the file remains valid todo.txt.
- [ ] Restart the session; the TODO note's position, size, color, font size, pin/lock and workspace survive via GSettings (`todo-layout`); `~/todo.txt` never gains a frontmatter header.
- [ ] Set `todo-file` to empty in Preferences: the TODO note disappears; set a custom path: it appears there (with `~` resolving to the home directory); clearing the setting again removes the note without touching the file.
- [ ] Delete `~/todo.txt` externally: the note disappears; **TODO note** in the top-bar menu recreates an empty file and reopens the note; the note cannot be deleted or duplicated from inside the extension; **Delete all notes** leaves it untouched.
- [ ] Check the file with `todo.sh ls` / `todo.sh do` if installed: output matches expectations; no ☐/☑ glyph characters ever appear in the file.

## Preview, links, images and diagrams
- [ ] In **Preview Markdown**, click a `- [ ]` / `- [x]` task item: the marker flips in the source file (no edit mode needed), including on locked notes; the cursor changes to a pointer over interactive rows; the checkbox state survives a session restart.
- [ ] A **Copy note** item appears in the note context menu and copies exactly the Markdown body (no frontmatter; for the TODO note, the todo.txt without ☐/☑ glyphs).
- [ ] Click a Markdown link `[text](https://…)` in the preview: the default browser/app opens it; relative links resolve against the note's folder inside `~/notes/`; `javascript:` URLs are not clickable.
- [ ] A note with `![alt](~/file.png)` shows the image inline in the preview (width fits the note, aspect preserved); a broken or missing file shows the alt text instead, never an empty box.
- [ ] An `http(s)://` image downloads once into `~/.cache/markdown-sticky-notes/images/` and renders on later views; a non-image response or network failure falls back to the alt text.
- [ ] A fenced block with info `dot` (graphviz installed) renders the diagram in the preview; with graphviz unavailable it renders as code plus an install hint; ` ```mermaid ` renders when `mmdc` is on PATH, otherwise code plus a hint; an invalid diagram body never breaks the preview.
- [ ] Fenced blocks with any other info string keep rendering as monospace code.
- [ ] Tiny and huge zoom levels: **A-**/**A+** (ribbon), **Zoom in/out** (context menu) and `Ctrl+Scroll` scale only the written editor/preview content from 5% to 200%; frame size/position, grip/header, ribbon, buttons and resize handle do not move or resize; the note menu shows the current value; the zoom survives a session restart (`gnome-sticky-zoom`; the TODO note keeps it in `todo-layout`); `gnome-sticky-font-size` is no longer changed by these controls.

- [ ] Expiring notes: "In 1 hour" on a note sets `gnome-sticky-expires` in its frontmatter, the `⌛` badge shows in the grip; after the hour passes the note disappears and its file is removed without any user interaction; "Clear expiry" removes the field and the badge; editing the frontmatter externally to a past/future time is honored on the next sweep (file wins); the special TODO note has no expiration option and never expires; a note already expired at load time is gone on the first sweep.

## Keyboard, mouse and colors
- [ ] In edit mode: `Ctrl+B/I/U` bold/italic/underline; `Ctrl+Shift+X` strikethrough; `Ctrl+Shift+C` inline code; `Ctrl+Shift+7/8/9` numbered/bullet/checkbox lists (including shifted glyphs on US/ABNT keyboards); `Ctrl+C/X/V/A` copy/cut/paste/select all; right-click on the text shows **Cut**, **Copy**, **Paste**, **Select All** and **Note menu**, while right-click outside editing keeps the note menu; locked notes and non-editing state are unaffected.
- [ ] With the note focused and not in edit mode: `Ctrl+C` copies; `Ctrl+Delete` deletes (the note disappears and the file is removed); `Ctrl+Scroll` zooms 5–200%; `Middle click` copies; `Ctrl+Middle click` duplicates; in editing mode none of these steal typing or selection.
- [ ] The last swatch (+) opens the custom color picker; typing `#RRGGBB`/`#RGB` updates the preview live; Enter or ✓ applies and persists in `gnome-sticky-color-custom`; invalid values are ignored; dark colors keep legible light ink; picking a preset clears the custom color.

## Folder categories
- [ ] Create `~/notes/projetos/2026/ideia.md` without marker files: an independent desktop note appears with **(projetos / 2026)** in its header. A root note and the special TODO note have no category pill.
- [ ] Names with spaces, accents, `&` and `<` render literally, without markup interpretation. Long category paths ellipsize and expose the complete label to accessibility tools.
- [ ] Resize to the minimum width, set/clear expiration, change custom colors and zoom to 5%/200%: category, drag affordance and expiry badge never overlap; header geometry does not scale with content.
- [ ] Focus and edit a nested note repeatedly, including after a monitor save and a pin/unpin: it remains visible on its desktop layer. Each note moves independently; no container or folder window appears.
- [ ] Move a note to a different folder, then rename that folder: the pill follows the complete new path and the Markdown body is preserved. Duplicate basenames in different folders stay distinct.
- [ ] Duplicate a categorized note: the copy stays in that category. New notes from the top-bar menu start at the root.
- [ ] Existing hidden `.board.md` files remain byte-for-byte unchanged and invisible. Their ordinary sibling notes still load with category pills. Hidden directories are ignored.
- [ ] Deleting one note removes only its file. **Delete all notes** removes all ordinary notes but preserves category folders, hidden metadata, unrelated files and the special TODO file. No folder-deletion or container-creation actions remain in menus.
- [ ] Restart the session: notes retain position, size, content zoom, colors, pin/lock and workspace; categories are re-derived from their paths. No JS ERROR appears on startup, creation, menu opening or teardown.

## Diagnostics
- [ ] Run `sh tests/shell-smoke.sh` for isolated real-Shell regression checks. Record the command exit code and the printed artifacts directory (`result.json`, `desktop.png`, `shell.log`). This uses disposable fixtures only; it does not validate the active desktop's personal notes or replace post-login acceptance.
Run these commands and attach the output only if there is a failure:

```bash
gnome-shell --version
echo "$XDG_SESSION_TYPE"
gnome-extensions info notes@redclaw.com.br
journalctl --user -b --no-pager | grep -Ei 'notes@redclaw.com.br|Sticky Notes'
```

**Acceptance:** Do not close issue #1 until both desktop versions have the complete checklist verified. Automated tests and a successful CI run are necessary but not sufficient for these UX and compositor scenarios.
