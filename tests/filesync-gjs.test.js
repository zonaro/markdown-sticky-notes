// Run with: gjs -m tests/filesync-gjs.test.js
// Exercising Gio.FileMonitor and filesystem writes without GNOME Shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    NoteFiles,
    isNoteRelpath,
    normalizeRelpath,
    noteSidecarRelpath,
} from '../extension/filesync.js';

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
assert(isNoteRelpath('a/page.html'), '.html files are notes');
assert(isNoteRelpath('a/page.htm'), '.htm files are notes');
assert(isNoteRelpath('a/sticker.png'), '.png files are notes');
assert(isNoteRelpath('a/photo.jpg'), '.jpg files are notes');
assert(isNoteRelpath('a/photo.jpeg'), '.jpeg files are notes');
assert(!isNoteRelpath('a/archive.png.exe'), 'supported extension must be final');
assert(!isNoteRelpath('a/.board.md'), 'legacy hidden metadata is never a note');
assert(!isNoteRelpath('.hidden/note.md'), 'hidden folders are not note categories');
assert(!isNoteRelpath('a/.metadata.txt'), 'hidden files are not notes');

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
    const parent = GLib.path_get_dirname(name);
    if (parent !== '.')
        GLib.mkdir_with_parents(GLib.build_filenamev([root, parent]), 0o755);
    file(name).replace_contents(new TextEncoder().encode(value), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}
function writeBytes(name, value) {
    const parent = GLib.path_get_dirname(name);
    if (parent !== '.')
        GLib.mkdir_with_parents(GLib.build_filenamev([root, parent]), 0o755);
    file(name).replace_contents(new Uint8Array(value), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}
function bytes(name) {
    return [...file(name).load_contents(null)[1]];
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
    assert(events.find(e => e.filename === 'notas.txt').doc.format === 'text',
        '.txt is delivered as plain text');
    assert(events.find(e => e.filename === 'notas.txt').doc.body === '# Plain text with markdown\n',
        '.txt content is never parsed as frontmatter or Markdown');
    write('pagina.html', '<h1>Safe source</h1><script>not executed</script>\n');
    awaitChange(() => events.some(e => e.filename === 'pagina.html'), '.html should be recognized');
    assert(events.find(e => e.filename === 'pagina.html').doc.format === 'html',
        '.html is delivered with its own format');
    const pngBytes = [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ];
    writeBytes('assets/sticker.png', pngBytes);
    awaitChange(() => events.some(e => e.filename === 'assets/sticker.png'),
        '.png should be discovered recursively');
    const stickerEvent = events.find(e => e.filename === 'assets/sticker.png');
    assert(stickerEvent.doc.format === 'image' && stickerEvent.doc.body === '',
        'binary image is delivered as an image note without text decoding');
    writeBytes('assets/corrupt.jpg', [0xde, 0xad, 0xbe, 0xef]);
    awaitChange(() => events.some(e => e.filename === 'assets/corrupt.jpg'),
        'corrupted image files remain isolated discoverable notes');
    write('reuniao.md', '# Reunião alterada\n');
    awaitChange(() => events.some(e => e.doc.body.includes('alterada')), 'external edit should update the note');

    // Category folders work without marker files; hidden metadata is inert.
    write('projetos/ideia.md', '# ideia\n');
    const legacyMetadata = '---\ntitle: Projetos\n---\nLegacy metadata\n';
    write('projetos/.board.md', legacyMetadata);
    write('projetos/2026/plano.txt', 'plano\n');
    write('projetos/2026/.board.md', '---\ntitle: 2026\n---\n');
    write('outro/2026/plano.txt', 'same basename, different category\n');
    write('.hidden/note.md', 'hidden\n');
    sync.scan();
    assert(events.some(e => e.filename === 'projetos/ideia.md'), 'nested .md must become a note');
    assert(events.some(e => e.filename === 'projetos/2026/plano.txt'), 'nested .txt must become a note');
    assert(events.some(e => e.filename === 'outro/2026/plano.txt'), 'duplicate basenames stay distinct');
    assert(!events.some(e => e.filename.split('/').some(part => part.startsWith('.'))),
        'all hidden files and folders must be ignored');
    write('projetos/2026/plano.txt', 'edited nested task\n');
    awaitChange(() => events.some(e => e.filename === 'projetos/2026/plano.txt' &&
        e.doc.body === 'edited nested task\n'), 'nested file monitors remain active');

    file('projetos/ideia.md').move(file('outro/ideia.md'), Gio.FileCopyFlags.NONE, null, null);
    awaitChange(() => removed.includes('projetos/ideia.md') &&
        events.some(e => e.filename === 'outro/ideia.md'), 'moving a note updates its category path');

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

    // Non-Markdown sources keep their bytes/content untouched by metadata.
    const plainSource = '# Literal heading\n*literal stars*\n';
    write('literal.txt', plainSource);
    sync.scan();
    const plain = {
        ...local,
        filename: 'literal.txt',
        id: 30,
        text: plainSource,
        custom_color: 'calma',
    };
    assert(sync.save(plain), 'plain text metadata save must succeed');
    assert(new TextDecoder().decode(file('literal.txt').load_contents(null)[1]) === plainSource,
        'plain text metadata must not inject frontmatter');
    const plainSidecar = noteSidecarRelpath('literal.txt');
    assert(file(plainSidecar).query_exists(null), 'plain text layout uses a hidden sidecar');
    assert(new TextDecoder().decode(file(plainSidecar).load_contents(null)[1]).includes('"id": 30'),
        'plain text sidecar persists layout identity');
    const htmlSource = '<p onclick="ignored()">Original <b>HTML</b></p>\n';
    write('safe.html', htmlSource);
    sync.scan();
    assert(sync.save({...local, filename: 'safe.html', id: 31, text: htmlSource}),
        'HTML metadata save must succeed');
    assert(new TextDecoder().decode(file('safe.html').load_contents(null)[1]) === htmlSource,
        'HTML metadata must not rewrite or sanitize the source file');
    assert(file(noteSidecarRelpath('safe.html')).query_exists(null),
        'HTML layout uses a hidden sidecar');
    const stickerBefore = bytes('assets/sticker.png');
    assert(sync.save({...local, filename: 'assets/sticker.png', id: 32, text: 'must not be written'}),
        'image metadata save must succeed');
    assert(JSON.stringify(bytes('assets/sticker.png')) === JSON.stringify(stickerBefore),
        'image metadata save leaves binary bytes untouched');
    assert(file(noteSidecarRelpath('assets/sticker.png')).query_exists(null),
        'image layout uses a hidden sidecar');

    // Saving into a subfolder creates parent dirs on demand.
    const nestedLocal = {...local, filename: 'projetos/2026/nova.md', text: '# nova\n'};
    assert(sync.save(nestedLocal), 'saving inside a category folder must succeed');
    assert(file('projetos/2026/nova.md').query_exists(null), 'nested file must exist');

    assert(new TextDecoder().decode(file('projetos/.board.md').load_contents(null)[1]) === legacyMetadata,
        'sync leaves legacy hidden metadata unchanged');

    // Deleting a note never deletes its category or unrelated files.
    assert(sync.remove(nestedLocal.filename), 'deleting a categorized note must succeed');
    assert(file('projetos/2026').query_exists(null), 'the category directory survives note deletion');
    assert(file('projetos/2026/.board.md').query_exists(null), 'hidden metadata survives note deletion');

    // External folder deletion removes its notes from the UI, but not others.
    write('fora.md', '# fora\n');
    write('projetos/nota.md', '# dentro\n');
    write('projetos/2026/profunda.txt', '# funda\n');
    sync.scan();
    assert(events.some(e => e.filename === 'projetos/nota.md'), 'category contents discovered before deletion');
    const beforeFolderDelete = removed.length;
    rmRecursive(file('projetos'));
    assert(!GLib.file_test(GLib.build_filenamev([root, 'projetos']), GLib.FileTest.EXISTS),
        'externally deleted category folder must be gone');
    sync.scan();
    assert(removed.includes('projetos/nota.md'), 'category contents disappear as notes');
    assert(removed.includes('projetos/2026/profunda.txt'), 'nested category contents disappear as notes');
    assert(!removed.includes('fora.md'), 'the folder root is never touched');
    assert(removed.length >= beforeFolderDelete + 2, 'everything inside the folder is removed');

    file('tarefas.markdown').move(file('novas-tarefas.md'), Gio.FileCopyFlags.NONE, null, null);
    awaitChange(() => removed.includes('tarefas.markdown') &&
        events.some(e => e.filename === 'novas-tarefas.md'), 'renaming must emit removal and addition');

    file('reuniao.md').delete(null);
    awaitChange(() => removed.includes('reuniao.md'), 'external deletion must remove the note');
    assert(!sync.save(local), 'external deletion must not be undone by a pending save');

    const newName = sync.newFilename('projetos/');
    assert(/^projetos\/note-\d+(?:-\d+)?\.md$/.test(newName), 'new filenames preserve category prefixes');
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

// Extension-initiated moves create target folders and refuse overwrites.
    write('oldcat/mover.md', '# mover\n');
    sync.scan();
    assert(sync.move('oldcat/mover.md', 'newcat/sub/mover.md'), 'extension move must succeed');
    assert(!file('oldcat/mover.md').query_exists(null), 'old path must be gone after move');
    assert(file('newcat/sub/mover.md').query_exists(null), 'target path must exist after move');
    assert(!sync.move('newcat/sub/mover.md', 'collision.md'), 'move must not overwrite an existing note');
    assert(!sync.move('newcat/sub/mover.md', '../escape.md'), 'move must reject traversal');
    assert(sync.remove('newcat/sub/mover.md'), 'moved note must remain removable');

    // Moves and deletion preserve format and move/remove its metadata sidecar.
    assert(sync.move('assets/sticker.png', 'archive/sticker.png'),
        'image category move must succeed');
    assert(file('archive/sticker.png').query_exists(null), 'moved image keeps its source extension');
    assert(file(noteSidecarRelpath('archive/sticker.png')).query_exists(null),
        'image sidecar follows category moves');
    assert(!file(noteSidecarRelpath('assets/sticker.png')).query_exists(null),
        'old image sidecar path is gone after move');
    assert(sync.remove('archive/sticker.png'), 'moved image remains removable');
    assert(!file('archive/sticker.png').query_exists(null), 'image source is deleted');
    assert(!file(noteSidecarRelpath('archive/sticker.png')).query_exists(null),
        'owned image sidecar is deleted with the image');
    assert(sync.remove('safe.html'), 'HTML remains removable');
    assert(!file(noteSidecarRelpath('safe.html')).query_exists(null),
        'owned HTML sidecar is removed with the source');

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
    print('PASS: Gio file-monitor, Markdown/TXT sync, categories, moves, hidden metadata, no trash, conflict protection');
} finally {
    sync.stop();
    rmRecursive(Gio.File.new_for_path(root));
}
