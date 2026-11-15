// Pure application-selection rules. Gio itself stays in notes.js so these
// rules can be verified with Node.js and fake AppInfo objects.

export function contentTypesForFilename(filename) {
    const match = typeof filename === 'string' ? filename.toLowerCase().match(/\.([^.]+)$/) : null;
    switch (match?.[1]) {
    case 'md':
    case 'markdown':
        return ['text/markdown', 'text/plain'];
    case 'txt':
        return ['text/plain'];
    case 'html':
    case 'htm':
        return ['text/html', 'text/plain'];
    case 'png':
        return ['image/png'];
    case 'jpg':
    case 'jpeg':
        return ['image/jpeg'];
    default:
        return [];
    }
}

function appValue(app, method, fallback = '') {
    try {
        return app?.[method]?.() ?? fallback;
    } catch {
        return fallback;
    }
}

export function compatibleApps(groups) {
    const unique = new Map();
    for (const app of groups.flat()) {
        if (!app || appValue(app, 'should_show', true) === false)
            continue;
        if (!appValue(app, 'supports_files', false) && !appValue(app, 'supports_uris', false))
            continue;
        const name = appValue(app, 'get_display_name') || appValue(app, 'get_name');
        const key = appValue(app, 'get_id') || appValue(app, 'get_executable') || name;
        if (key && !unique.has(key))
            unique.set(key, app);
    }
    return [...unique.values()].sort((left, right) => {
        const leftName = appValue(left, 'get_display_name') || appValue(left, 'get_name');
        const rightName = appValue(right, 'get_display_name') || appValue(right, 'get_name');
        return leftName.localeCompare(rightName);
    });
}

export function launchExternalApp(app, file, context = null) {
    if (appValue(app, 'supports_files', false))
        return app.launch([file], context);
    if (appValue(app, 'supports_uris', false))
        return app.launch_uris([file.get_uri()], context);
    throw new Error('Application cannot open files or URIs');
}
