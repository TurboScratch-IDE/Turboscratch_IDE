// Serves the bundled editor from tsc-app://editor/ instead of file://.
// A real origin (not file://) gives the editor working localStorage and
// IndexedDB, a secure context (clipboard, file pickers, camera, crypto) and
// fetch() for its own files, just like the website.

const {net, protocol} = require('electron');
const path = require('path');
const {pathToFileURL} = require('url');
const {APP_SCHEME, APP_HOST} = require('./policy');
const {getMimeType, resolveAppFile} = require('./app-files');

const EDITOR_DIR = path.join(__dirname, '..', 'editor');

// Must run before the app is ready, and Electron allows only one call.
const registerAppScheme = () => {
    protocol.registerSchemesAsPrivileged([{
        scheme: APP_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
            codeCache: true
            // No allowServiceWorkers: the files are already on disk, and the
            // website's service worker would only cache old versions.
        }
    }]);
};

const textResponse = (status, text) => new Response(text, {
    status,
    headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff'
    }
});

const handleRequest = async request => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) {
        return textResponse(404, 'Not found');
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return textResponse(405, 'Method not allowed');
    }

    const filePath = resolveAppFile(EDITOR_DIR, url.pathname);
    if (!filePath) {
        return textResponse(400, 'Bad path');
    }

    let fileResponse;
    try {
        // net.fetch streams the file and can also read inside app.asar
        fileResponse = await net.fetch(pathToFileURL(filePath).toString());
    } catch (e) {
        return textResponse(404, 'Not found');
    }
    if (!fileResponse.ok) {
        return textResponse(404, 'Not found');
    }

    return new Response(request.method === 'HEAD' ? null : fileResponse.body, {
        status: 200,
        headers: {
            'content-type': getMimeType(filePath),
            'x-content-type-options': 'nosniff'
        }
    });
};

// Must run after the app is ready. It is per session, and every app window
// uses the default session.
const handleAppScheme = () => {
    protocol.handle(APP_SCHEME, handleRequest);
};

module.exports = {
    EDITOR_DIR,
    registerAppScheme,
    handleAppScheme
};
