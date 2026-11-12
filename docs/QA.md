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
- [ ] Check that `.txt` and nested Markdown files do not produce notes.
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

## Diagnostics
Run these commands and attach the output only if there is a failure:

```bash
gnome-shell --version
echo "$XDG_SESSION_TYPE"
gnome-extensions info notes@redclaw.com.br
journalctl --user -b --no-pager | grep -Ei 'notes@redclaw.com.br|Sticky Notes'
```

**Acceptance:** Do not close issue #1 until both desktop versions have the complete checklist verified. Automated tests and a successful CI run are necessary but not sufficient for these UX and compositor scenarios.
