const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {getMimeType, resolveAppFile} = require('../src/app-files');

const POSIX_ROOT = '/Applications/TurboScratch IDE.app/Contents/Resources/app.asar/editor';
const WIN_ROOT = 'C:\\Users\\kid\\AppData\\Local\\Programs\\TurboScratch IDE\\resources\\app.asar\\editor';

// What Electron's request.url gives us: the pathname is still percent-encoded
const pathnameOf = url => new URL(url).pathname;

const posix = pathname => resolveAppFile(POSIX_ROOT, pathname, path.posix);
const win = pathname => resolveAppFile(WIN_ROOT, pathname, path.win32);

test('serves normal editor files', () => {
    assert.equal(posix('/editor.html'), `${POSIX_ROOT}/editor.html`);
    assert.equal(posix('/static/blocks-media/default/green-flag.svg'),
        `${POSIX_ROOT}/static/blocks-media/default/green-flag.svg`);
    assert.equal(win('/js/pentapod/gui.js'), `${WIN_ROOT}\\js\\pentapod\\gui.js`);
});

test('decodes file names with spaces', () => {
    const pathname = pathnameOf('tsc-app://editor/js/pentapod/extension worker.9130e44d.js');
    assert.equal(pathname, '/js/pentapod/extension%20worker.9130e44d.js');
    assert.equal(posix(pathname), `${POSIX_ROOT}/js/pentapod/extension worker.9130e44d.js`);
    assert.equal(win(pathname), `${WIN_ROOT}\\js\\pentapod\\extension worker.9130e44d.js`);
});

test('the start page and extensionless page names work like the website', () => {
    assert.equal(posix('/'), `${POSIX_ROOT}/index.html`);
    assert.equal(posix('/editor'), `${POSIX_ROOT}/editor.html`);
    assert.equal(posix('/addons/'), `${POSIX_ROOT}/addons.html`);
    assert.equal(posix(pathnameOf('tsc-app://editor/editor?project_url=https://x.test/a.sb3')),
        `${POSIX_ROOT}/editor.html`);
});

test('refuses plain and encoded ".." (both operating systems)', () => {
    const attempts = [
        '/../secret.txt',
        '/js/../../secret.txt',
        '/%2e%2e/secret.txt',
        '/%2E%2E/%2e%2e/secret.txt',
        '/..%2fsecret.txt',
        '/..%2f..%2f..%2fetc%2fpasswd',
        '/js/%2e%2e%2f%2e%2e%2fsecret.txt',
        '/%2e%2e%2f',
        '/..',
        '/js/..'
    ];
    for (const attempt of attempts) {
        assert.equal(posix(attempt), null, attempt);
        assert.equal(win(attempt), null, attempt);
    }
});

test('the URL parser already removes simple ".." before we see it', () => {
    // Belt and braces: even when the parser cleans the path, we stay inside
    assert.equal(pathnameOf('tsc-app://editor/js/../../../etc/secret.txt'), '/etc/secret.txt');
    assert.equal(posix(pathnameOf('tsc-app://editor/js/../../../etc/secret.txt')), `${POSIX_ROOT}/etc/secret.txt`);
    // But encoded slashes survive parsing, and are refused after decoding
    assert.equal(pathnameOf('tsc-app://editor/..%2f..%2fetc/passwd'), '/..%2f..%2fetc/passwd');
    assert.equal(posix(pathnameOf('tsc-app://editor/..%2f..%2fetc/passwd')), null);
});

test('refuses backslashes, raw or encoded (Windows folder separators)', () => {
    const attempts = [
        '/..\\..\\secret.txt',
        '/..%5c..%5csecret.txt',
        '/%5c%5cserver%5cshare%5cfile.txt',
        '/js%5c..%5c..%5csecret.txt',
        '/static\\file.svg'
    ];
    for (const attempt of attempts) {
        assert.equal(win(attempt), null, attempt);
        assert.equal(posix(attempt), null, attempt);
    }
});

test('refuses absolute paths and drive letters', () => {
    const attempts = [
        '/C:/Windows/win.ini',
        '/C:%5cWindows%5cwin.ini',
        '/c%3a/Windows/win.ini',
        '/%2fetc%2fpasswd',
        '//etc/passwd',
        'C:/Windows/win.ini',
        'etc/passwd',
        ''
    ];
    for (const attempt of attempts) {
        const winResult = win(attempt);
        assert.ok(winResult === null || winResult.startsWith(`${WIN_ROOT}\\`), `${attempt} -> ${winResult}`);
        const posixResult = posix(attempt);
        assert.ok(posixResult === null || posixResult.startsWith(`${POSIX_ROOT}/`), `${attempt} -> ${posixResult}`);
    }
    assert.equal(win('/C:/Windows/win.ini'), null);
    assert.equal(win('/c%3a/Windows/win.ini'), null);
    assert.equal(posix('C:/Windows/win.ini'), null);
    assert.equal(posix(''), null);
    // A doubled slash is just an empty folder name, so it stays inside
    assert.equal(posix('//etc/secret.txt'), `${POSIX_ROOT}/etc/secret.txt`);
    assert.equal(posix('/%2fetc%2fsecret.txt'), `${POSIX_ROOT}/etc/secret.txt`);
    assert.equal(win('//etc/secret.txt'), `${WIN_ROOT}\\etc\\secret.txt`);
});

test('refuses NUL bytes, broken escapes and Windows tricks', () => {
    const attempts = [
        '/editor.html%00.png',
        '/editor.html\0',
        '/%E0%A4%A',
        '/%',
        '/.. /secret.txt',
        '/..%20/secret.txt',
        '/editor.html.',
        '/editor.html%20',
        '/CON',
        '/nul.html',
        '/js/com1.js',
        '/LPT9.txt',
        '/editor.html:stream'
    ];
    for (const attempt of attempts) {
        assert.equal(win(attempt), null, attempt);
        assert.equal(posix(attempt), null, attempt);
    }
});

test('refuses things that are not a path', () => {
    assert.equal(resolveAppFile(POSIX_ROOT, undefined, path.posix), null);
    assert.equal(resolveAppFile(POSIX_ROOT, null, path.posix), null);
    assert.equal(resolveAppFile(POSIX_ROOT, 42, path.posix), null);
});

test('works with the real path module of this computer', () => {
    const root = path.join(__dirname, 'fake-editor');
    assert.equal(resolveAppFile(root, '/editor.html'), path.join(root, 'editor.html'));
    assert.equal(resolveAppFile(root, '/%2e%2e/package.json'), null);
});

test('content types', () => {
    assert.equal(getMimeType('/x/editor.html'), 'text/html; charset=utf-8');
    assert.equal(getMimeType('/x/gui.5f3a.js'), 'text/javascript; charset=utf-8');
    assert.equal(getMimeType('/x/icon.SVG'), 'image/svg+xml');
    assert.equal(getMimeType('/x/font.woff2'), 'font/woff2');
    assert.equal(getMimeType('/x/meow.wav'), 'audio/wav');
    assert.equal(getMimeType('/x/pop.mp3'), 'audio/mpeg');
    assert.equal(getMimeType('/x/manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
    assert.equal(getMimeType('/x/firmware.hex'), 'application/octet-stream');
    assert.equal(getMimeType('/x/unknown.xyz'), 'application/octet-stream');
    assert.equal(getMimeType('C:\\x\\style.css'), 'text/css; charset=utf-8');
});
