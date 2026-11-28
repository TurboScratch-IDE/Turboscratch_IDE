// Turns a tsc-app://editor/... URL path into a file inside the bundled editor
// folder. This is the only thing standing between web pages (and project or
// extension code running in them) and the rest of the disk, so it refuses
// anything it is not sure about instead of guessing.
//
// It has no Electron imports so the unit tests can run it with plain Node,
// including with Windows path rules on a Mac (pass path.win32 as pathApi).

const path = require('path');

// Content types for every kind of file in the editor build. Unknown kinds are
// sent as plain bytes so the browser never guesses (we also send nosniff).
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'text/xml; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.cur': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.wasm': 'application/wasm',
    '.hex': 'application/octet-stream'
};

const getMimeType = filePath => (
    MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
);

/**
 * @param {string} rootDir absolute path of the bundled editor folder
 * @param {string} urlPathname URL pathname, still percent-encoded (e.g. from new URL(...).pathname)
 * @param {object} [pathApi] path module to use (path.win32 or path.posix in tests)
 * @returns {string|null} absolute file path inside rootDir, or null to refuse
 */
const resolveAppFile = (rootDir, urlPathname, pathApi = path) => {
    if (typeof urlPathname !== 'string' || !urlPathname.startsWith('/')) {
        return null;
    }

    let decoded;
    try {
        // Real file names contain spaces ("extension worker.js" arrives as %20),
        // so decoding is needed. It also turns %2f, %5c and %2e back into
        // characters, which is why every check below runs AFTER decoding.
        decoded = decodeURIComponent(urlPathname);
    } catch (e) {
        // Broken escapes like %E0%A4
        return null;
    }

    // Backslashes are folder separators on Windows and NUL ends strings in C.
    // Colons mean drive letters ("C:") or hidden NTFS streams on Windows.
    // No file in the editor build needs any of them.
    if (/[\\\0:]/.test(decoded)) {
        return null;
    }

    // Refuse ".." anywhere instead of trusting path.join to cancel it out.
    // Windows quietly drops dots and spaces at the end of a name (so ".. "
    // can act like ".."), and names like CON or NUL are devices there, not
    // files. No file in the build looks like that, so refuse those too.
    const parts = decoded.split('/').filter(part => part !== '' && part !== '.');
    if (parts.some(part => (
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part)
    ))) {
        return null;
    }

    // tsc-app://editor/ shows the home page, like the website does
    if (parts.length === 0) {
        parts.push('index.html');
    }

    // The website (GitHub Pages) also answers "editor" with editor.html, and the
    // editor links to pages that way (for example "editor?project_url=...").
    // Every real file in the build has an extension, so this never hides one.
    const last = parts[parts.length - 1];
    if (!last.includes('.')) {
        parts[parts.length - 1] = `${last}.html`;
    }

    const root = pathApi.resolve(rootDir);
    const filePath = pathApi.join(root, ...parts);

    // Final safety net: the result must still be inside the editor folder.
    const relative = pathApi.relative(root, filePath);
    if (
        relative === '' ||
        relative === '..' ||
        relative.startsWith(`..${pathApi.sep}`) ||
        pathApi.isAbsolute(relative)
    ) {
        return null;
    }

    return filePath;
};

module.exports = {
    getMimeType,
    resolveAppFile
};
