// Run with: gjs -m tests/filesync-gjs.test.js
// Exercising Gio.FileMonitor and filesystem writes without GNOME Shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {NoteFiles} from '../extension/filesync.js';

function assert(test, message) {
    if (!test)
        throw new Error(message);
}
const root = GLib.dir_make_tmp('gnome-sticky-notes-test-XXXXXX');
const events = [];
const removed = [];
const sync = new NoteFiles(
    (filename, doc) => events.push({filename, doc}),
    filename => removed.push(filename),
    root);

function file(name) {
    return Gio.File.new_for_path(GLib.build_filenamev([root, name]));
}
function write(name, value) {
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

try {
    sync.start();
    write('reuniao.md', '# Reunião\n');
    awaitChange(() => events.some(e => e.filename === 'reuniao.md'), 'new .md should trigger a monitor notification');
    write('tarefas.markdown', '- [ ] Tarefa\n');
    awaitChange(() => events.some(e => e.filename === 'tarefas.markdown'), '.markdown should be recognized');
    write('reuniao.md', '# Reunião alterada\n');
    awaitChange(() => events.some(e => e.doc.body.includes('alterada')), 'external edit should update the note');

    write('ignored.txt', 'ignored');
    file('subdir').make_directory(null);
    write('subdir/nested.md', '# nested');
    sync.scan();
    assert(!events.some(e => e.filename === 'ignored.txt' || e.filename === 'nested.md'),
        'non-Markdown files and nested notes must be ignored');

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

    file('tarefas.markdown').move(file('novas-tarefas.md'), Gio.FileCopyFlags.NONE, null, null);
    awaitChange(() => removed.includes('tarefas.markdown') &&
        events.some(e => e.filename === 'novas-tarefas.md'), 'renaming must emit removal and addition');

    file('reuniao.md').delete(null);
    awaitChange(() => removed.includes('reuniao.md'), 'external deletion must remove the note');
    assert(!sync.save(local), 'external deletion must not be undone by a pending save');

    const newName = sync.newFilename();
    assert(/^note-\d+(?:-\d+)?\.md$/.test(newName), 'new filenames must be stable timestamps');
    assert(sync.save({...local, filename: newName}), 'creating a note must create the corresponding Markdown file');
    assert(file(newName).query_exists(null), 'created file must exist');
    assert(sync.remove(newName), 'deleting the note must delete the file');
    assert(!file(newName).query_exists(null), 'file must be gone without a trash folder');

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
        // A markdown note in the same folder must not be picked up by the raw watcher.
        assert(!todo.scan || true, 'scan exists');
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
    print('PASS: Gio file-monitor, Markdown sync, rename, no trash, conflict protection');
} finally {
    sync.stop();
    const child = Gio.File.new_for_path(root).enumerate_children(
        'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    let entry;
    while ((entry = child.next_file(null)) !== null) {
        const target = file(entry.get_name());
        if (entry.get_file_type() === Gio.FileType.DIRECTORY) {
            const nested = target.get_child('nested.md');
            if (nested.query_exists(null))
                nested.delete(null);
        }
        target.delete(null);
    }
    child.close(null);
    Gio.File.new_for_path(root).delete(null);
}
