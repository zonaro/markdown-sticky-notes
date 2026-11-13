// Run with: gjs -m tests/filesync-gjs.test.js
// Exercising Gio.FileMonitor and filesystem writes without GNOME Shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {NoteFiles, isNoteRelpath, isBoardFilePath, normalizeRelpath} from '../extension/filesync.js';

function assert(test, message) {
    if (!test)
        throw new Error(message);
}
assert(normalizeRelpath('a/b/c.md') === 'a/b/c.md', 'relpaths normalize');
assert(normalizeRelpath('../escape.md') === null, 'dot segments are rejected');
assert(normalizeRelpath('/abs.md') === null, 'absolute paths are rejected');
assert(normalizeRelpath('a\\b.md') === 'a/b.md', 'backslashes become slashes');
assert(normalizeRelpath('./a.md') === null, 'dot segments are rejected');
assert(isNoteRelpath('a/b.txt'), '.txt files are notes');
assert(isNoteRelpath('a/b.markdown'), '.markdown files are notes');
assert(!isNoteRelpath('a/.board.md'), '.board.md is never a note');
assert(isBoardFilePath('projetos/sub/.board.md'), '.board.md anywhere is a board marker');

const root = GLib.dir_make_tmp('gnome-sticky-notes-test-XXXXXX');
const events = [];
const removed = [];
const boardScans = [];
const sync = new NoteFiles(
    (filename, doc) => events.push({filename, doc}),
    filename => removed.push(filename),
    root,
    present => boardScans.push(new Map(present)));

function file(name) {
    return Gio.File.new_for_path(GLib.build_filenamev([root, name]));
}
function write(name, value) {
    const parent = GLib.path_get_dirname(name);
    if (parent !== '.')
        GLib.mkdir_with_parents(GLib.build_filenamev([root, parent]), 0o755);
    file(name).replace_contents(new TextEncoder().encode(value), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}
function awaitChange(condition, message) {
    if (condition())
        return;
    const loop = GLib.MainLoop.new(null, false);
    const check = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
        if (condition()) {
            loop.quit();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
    let timedOut = false;
    const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
        timedOut = true;
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
    if (!timedOut)
        GLib.Source.remove(timeout);
    else
        GLib.Source.remove(check);
    assert(!timedOut, message);
}

function rmRecursive(file) {
    if (!file.query_exists(null))
        return;
    if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY) {
        const child = file.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = child.next_file(null)) !== null)
            rmRecursive(file.get_child(info.get_name()));
        child.close(null);
    }
    file.delete(null);
}

try {
    sync.start();
    write('reuniao.md', '# Reunião\n');
    awaitChange(() => events.some(e => e.filename === 'reuniao.md'), 'new .md should trigger a monitor notification');
    write('tarefas.markdown', '- [ ] Tarefa\n');
    awaitChange(() => events.some(e => e.filename === 'tarefas.markdown'), '.markdown should be recognized');
    write('notas.txt', '# Plain text with markdown\n');
    awaitChange(() => events.some(e => e.filename === 'notas.txt'), '.txt files are notes now');
    write('reuniao.md', '# Reunião alterada\n');
    awaitChange(() => events.some(e => e.doc.body.includes('alterada')), 'external edit should update the note');

    // Nested folders are notes by relpath; .board.md is config, never a note.
    write('projetos/ideia.md', '# ideia\n');
    write('projetos/.board.md', '---\ntitle: Projetos\n---\nBoard body\n');
    write('projetos/2026/plano.txt', 'plano\n');
    write('projetos/2026/.board.md', '---\ntitle: 2026\n---\n');
    sync.scan();
    assert(events.some(e => e.filename === 'projetos/ideia.md'), 'nested .md must become a note');
    assert(events.some(e => e.filename === 'projetos/2026/plano.txt'), 'nested .txt must become a note');
    assert(!events.some(e => e.filename === 'projetos/.board.md'), '.board.md must not become a note');
    assert(!events.some(e => e.filename === 'projetos/2026/.board.md'), 'nested .board.md must not become a note');
    assert(boardScans.length > 0, 'boards callback must fire');
    const lastBoards = boardScans[boardScans.length - 1];
    assert(lastBoards.has('projetos'), 'projetos board detected');
    assert(lastBoards.has('projetos/2026'), 'nested board detected');
    assert(lastBoards.get('projetos').document.body.includes('Board body'), 'board body is exposed');

    // Simulate the shell saving the file, then observing its own monitor event.
    const local = {filename: 'reuniao.md', id: 22, text: '# Local\n',
        x: 10, y: 20, w: 230, h: 180, expanded_h: 180, color: 0, size: 13,
        workspace: 0, pinned: false, locked: false, spans: [], sizes: []};
    assert(sync.save(local), 'saving a local note must succeed');
    assert(new TextDecoder().decode(file('reuniao.md').load_contents(null)[1]).includes('# Local'),
        'local edit must reach disk');
    const previousCount = events.length;
    sync.scan();
    assert(events.length === previousCount, 'own writes must not loop back into the UI');

    // Saving into a subfolder creates parent dirs on demand.
    const nestedLocal = {...local, filename: 'projetos/2026/nova.md', text: '# nova\n'};
    assert(sync.save(nestedLocal), 'saving inside a board folder must succeed');
    assert(file('projetos/2026/nova.md').query_exists(null), 'nested file must exist');

    // Board save roundtrip and external-change protection.
    assert(sync.saveBoard('projetos', '---\ntitle: Projetos renamed\n---\nbody\n'),
        'board save must succeed');
    assert(new TextDecoder().decode(file('projetos/.board.md').load_contents(null)[1]).includes('Projetos renamed'),
        'board save must reach disk');

    // A folder deleted recursively (board deletion from the menu) removes
    // everything beneath it; anything outside the folder survives.
    write('fora.md', '# fora\n');
    write('projetos/nota.md', '# dentro\n');
    write('projetos/2026/profunda.txt', '# funda\n');
    write('projetos/.board.md', '---\ntitle: Projetos\n---\n');
    sync.scan();
    assert(events.some(e => e.filename === 'projetos/nota.md'), 'board contents discovered before deletion');
    const beforeFolderDelete = removed.length;
    assert(sync.removeFolder('projetos'), 'recursive folder deletion must succeed');
    assert(!GLib.file_test(GLib.build_filenamev([root, 'projetos']), GLib.FileTest.EXISTS),
        'board folder must be gone');
    sync.scan();
    assert(removed.includes('projetos/nota.md'), 'board contents disappear as notes');
    assert(removed.includes('projetos/2026/profunda.txt'), 'nested board contents disappear as notes');
    assert(!removed.includes('fora.md'), 'the folder root is never touched');
    assert(removed.length >= beforeFolderDelete + 2, 'everything inside the folder is removed');

    file('tarefas.markdown').move(file('novas-tarefas.md'), Gio.FileCopyFlags.NONE, null, null);
    awaitChange(() => removed.includes('tarefas.markdown') &&
        events.some(e => e.filename === 'novas-tarefas.md'), 'renaming must emit removal and addition');

    // Deleting a whole nested board folder removes every note beneath it.
    // (Covered above by removeFolder; the monitor sees the same events as an
    // external "rm -rf".)
    file('reuniao.md').delete(null);
    awaitChange(() => removed.includes('reuniao.md'), 'external deletion must remove the note');
    assert(!sync.save(local), 'external deletion must not be undone by a pending save');

    const newName = sync.newFilename('projetos/');
    assert(/^projetos\/note-\d+(?:-\d+)?\.md$/.test(newName), 'new filenames with a board prefix');
    const rootName = sync.newFilename('');
    assert(/^note-\d+(?:-\d+)?\.md$/.test(rootName), 'new filenames stay bare at the root');
    assert(sync.save({...local, filename: rootName}), 'creating a note must create the corresponding Markdown file');
    assert(file(rootName).query_exists(null), 'created file must exist');
    assert(sync.remove(rootName), 'deleting the note must delete the file');
    assert(!file(rootName).query_exists(null), 'file must be gone without a trash folder');

    // Pending changes from another editor win over UI saves.
    sync.scan();
    write('collision.md', '# First\n');
    sync.scan();
    write('collision.md', '# External newer\n');
    assert(!sync.save({...local, filename: 'collision.md', text: '# Older UI\n'}),
        'saving over a newer external file must be rejected');
    assert(new TextDecoder().decode(file('collision.md').load_contents(null)[1]).includes('External newer'),
        'external update should be preserved');

    // Raw todo.txt mode: single file, no frontmatter, filesystem wins.
    const todoPath = GLib.build_filenamev([root, 'todo.txt']);
    write('todo.txt', '(A) 2026-11-01 Buy milk +store @corner\n');
    const todoEvents = [];
    const todoRemoved = [];
    const todo = new NoteFiles(
        (filename, doc) => todoEvents.push({filename, doc}),
        filename => todoRemoved.push(filename),
        {file: todoPath});
    try {
        todo.start();
        assert(todoEvents.length === 1 && todoEvents[0].doc.raw === true,
            'raw mode must deliver the untouched file text');
        assert(todoEvents[0].doc.body === '(A) 2026-11-01 Buy milk +store @corner\n',
            'raw body must be byte-for-byte the file content');
        todo.save({filename: 'todo.txt', rawText: '(B) Revised task\n'});
        assert(new TextDecoder().decode(file('todo.txt').load_contents(null)[1]) === '(B) Revised task\n',
            'raw save must write exactly the given text');
        write('todo.txt', 'x 2026-11-12 (B) Revised task\n');
        assert(!todo.save({filename: 'todo.txt', rawText: '(C) Unexpected UI\n'}),
            'raw save over a newer external file must be rejected');
        file('todo.txt').delete(null);
        todo.scan();
        assert(todoRemoved.includes('todo.txt'), 'external deletion of the TODO file must remove the note');
    } finally {
        todo.stop();
    }

    print('PASS: raw todo.txt single-file mode');
    print('PASS: Gio file-monitor, Markdown/TXT sync, recursion, boards, rename, no trash, conflict protection');
} finally {
    sync.stop();
    rmRecursive(Gio.File.new_for_path(root));
}
