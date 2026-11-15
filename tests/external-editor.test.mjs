import test from 'node:test';
import assert from 'node:assert/strict';

import {
    compatibleApps,
    contentTypesForFilename,
    launchExternalApp,
} from '../extension/external-editor.js';

function app({
    id,
    name,
    files = true,
    uris = false,
    visible = true,
    launch = () => true,
    launchUris = () => true,
}) {
    return {
        get_id: () => id,
        get_display_name: () => name,
        get_executable: () => id,
        should_show: () => visible,
        supports_files: () => files,
        supports_uris: () => uris,
        launch,
        launch_uris: launchUris,
    };
}

test('note extensions map to the correct MIME candidates', () => {
    assert.deepEqual(contentTypesForFilename('idea.md'), ['text/markdown', 'text/plain']);
    assert.deepEqual(contentTypesForFilename('idea.MARKDOWN'), ['text/markdown', 'text/plain']);
    assert.deepEqual(contentTypesForFilename('plain.txt'), ['text/plain']);
    assert.deepEqual(contentTypesForFilename('safe.html'), ['text/html', 'text/plain']);
    assert.deepEqual(contentTypesForFilename('sticker.png'), ['image/png']);
    assert.deepEqual(contentTypesForFilename('photo.JPEG'), ['image/jpeg']);
    assert.deepEqual(contentTypesForFilename('unknown.bin'), []);
});

test('compatible applications are visible, launchable, deduplicated and sorted', () => {
    const beta = app({id: 'beta.desktop', name: 'Beta'});
    const alpha = app({id: 'alpha.desktop', name: 'Alpha', files: false, uris: true});
    const hidden = app({id: 'hidden.desktop', name: 'Hidden', visible: false});
    const inert = app({id: 'inert.desktop', name: 'Inert', files: false});
    assert.deepEqual(compatibleApps([[beta, alpha], [beta, hidden, inert]]), [alpha, beta]);
});

test('launch prefers files and falls back to URIs', () => {
    const file = {get_uri: () => 'file:///tmp/note.txt'};
    let received = null;
    const fileApp = app({id: 'files', name: 'Files', launch: files => {
        received = files;
        return true;
    }});
    assert.equal(launchExternalApp(fileApp, file), true);
    assert.deepEqual(received, [file]);

    const uriApp = app({
        id: 'uris',
        name: 'URIs',
        files: false,
        uris: true,
        launchUris: uris => {
            received = uris;
            return true;
        },
    });
    assert.equal(launchExternalApp(uriApp, file), true);
    assert.deepEqual(received, ['file:///tmp/note.txt']);
});

test('launch rejects applications that cannot receive the note', () => {
    const inert = app({id: 'inert', name: 'Inert', files: false});
    assert.throws(() => launchExternalApp(inert, {get_uri: () => 'file:///tmp/note.txt'}),
        /cannot open files or URIs/);
});
