const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/policy');

const EDITOR = 'tsc-app://editor/editor.html';
const PACKAGER = 'https://packager.turbowarp.org/?import_from=tsc-app%3A%2F%2Feditor';

test('the app origin never changes (saved projects and settings depend on it)', () => {
    assert.equal(policy.APP_ORIGIN, 'tsc-app://editor');
    assert.equal(policy.START_URL, 'tsc-app://editor/editor.html');
});

test('recognises app pages by scheme and host, not by text prefix', () => {
    assert.equal(policy.isAppUrl('tsc-app://editor/editor.html'), true);
    assert.equal(policy.isAppUrl('tsc-app://editor/addons.html#editor-devtools'), true);
    assert.equal(policy.isAppUrl('tsc-app://editor'), true);
    assert.equal(policy.isAppUrl('TSC-APP://editor/editor.html'), true);
    assert.equal(policy.isAppUrl('tsc-app://editor.evil.test/editor.html'), false);
    assert.equal(policy.isAppUrl('tsc-app://other/editor.html'), false);
    assert.equal(policy.isAppUrl('tsc-app://user:pw@editor/editor.html'), false);
    assert.equal(policy.isAppUrl('https://editor/editor.html'), false);
    assert.equal(policy.isAppUrl('blob:tsc-app://editor/1234'), false);
    assert.equal(policy.isAppUrl('not a url'), false);
    assert.equal(policy.isAppUrl(''), false);
});

test('window.open from the editor', () => {
    assert.equal(policy.windowOpenAction(EDITOR, 'tsc-app://editor/addons.html'), 'app-window');
    assert.equal(policy.windowOpenAction(EDITOR, 'tsc-app://editor/editor?project_url=https://x.test/a.sb3'),
        'app-window');
    assert.equal(policy.windowOpenAction(EDITOR, PACKAGER), 'packager');
    assert.equal(policy.windowOpenAction(EDITOR, 'https://scratch.mit.edu/discuss/'), 'external');
    assert.equal(policy.windowOpenAction(EDITOR, 'https://example.com'), 'external');
    assert.equal(policy.windowOpenAction(EDITOR, 'http://example.com'), 'external');
    assert.equal(policy.windowOpenAction(EDITOR, 'mailto:someone@example.com'), 'external');
    // The packager over plain http, or a look-alike host, is just a website
    assert.equal(policy.windowOpenAction(EDITOR, 'http://packager.turbowarp.org/'), 'external');
    assert.equal(policy.windowOpenAction(EDITOR, 'https://packager.turbowarp.org.evil.test/'), 'external');
    for (const url of [
        'file:///etc/passwd',
        'javascript:alert(1)',
        'data:text/html,<h1>hi</h1>',
        'blob:tsc-app://editor/1234',
        'steam://run/123',
        'calculator:',
        'tsc-app://other/editor.html',
        'about:blank',
        ''
    ]) {
        assert.equal(policy.windowOpenAction(EDITOR, url), 'deny', url);
    }
});

test('window.open from the packager can only send links to the browser', () => {
    assert.equal(policy.windowOpenAction(PACKAGER, 'tsc-app://editor/editor.html'), 'deny');
    assert.equal(policy.windowOpenAction(PACKAGER, PACKAGER), 'external');
    assert.equal(policy.windowOpenAction(PACKAGER, 'https://docs.turbowarp.org/'), 'external');
    assert.equal(policy.windowOpenAction(PACKAGER, 'file:///etc/passwd'), 'deny');
});

test('navigation inside a window', () => {
    // Moving between app pages is fine
    assert.equal(policy.navigationAction('tsc-app://editor/index.html', 'tsc-app://editor/credits.html'), 'allow');
    assert.equal(policy.navigationAction(EDITOR, 'tsc-app://editor/editor.html?room=abc'), 'allow');
    // The editor window never turns into a website: the link goes to the browser
    assert.equal(policy.navigationAction(EDITOR, 'https://example.com/'), 'external');
    assert.equal(policy.navigationAction(EDITOR, PACKAGER), 'external');
    // Files dropped outside a drop zone and other schemes do nothing
    assert.equal(policy.navigationAction(EDITOR, 'file:///Users/kid/project.sb3'), 'deny');
    assert.equal(policy.navigationAction(EDITOR, 'javascript:alert(1)'), 'deny');
    assert.equal(policy.navigationAction(EDITOR, 'tsc-app://other/editor.html'), 'deny');
    // The packager window may move around the packager site only
    assert.equal(policy.navigationAction(PACKAGER, 'https://packager.turbowarp.org/other'), 'allow');
    assert.equal(policy.navigationAction(PACKAGER, 'https://turbowarp.org/'), 'external');
    assert.equal(policy.navigationAction(PACKAGER, 'tsc-app://editor/editor.html'), 'deny');
    // A window that was just opened loads its first page
    assert.equal(policy.navigationAction('', PACKAGER), 'allow');
    assert.equal(policy.navigationAction('about:blank', PACKAGER), 'allow');
    assert.equal(policy.navigationAction('about:blank', 'https://example.com/'), 'external');
});

test('permissions: the editor gets what it uses, nothing else', () => {
    for (const permission of [
        'clipboard-read', 'clipboard-sanitized-write', 'media', 'fileSystem',
        'fullscreen', 'pointerLock', 'persistent-storage'
    ]) {
        assert.equal(policy.isPermissionAllowed(permission, 'tsc-app://editor'), true, permission);
        assert.equal(policy.isPermissionAllowed(permission, EDITOR), true, permission);
    }
    for (const permission of [
        'geolocation', 'notifications', 'display-capture', 'usb', 'hid', 'serial', 'midi',
        'midiSysex', 'openExternal', 'idle-detection', 'window-management', 'unknown',
        'deprecated-sync-clipboard-read', 'top-level-storage-access'
    ]) {
        assert.equal(policy.isPermissionAllowed(permission, EDITOR), false, permission);
    }
});

test('permissions: other pages get almost nothing', () => {
    assert.equal(policy.isPermissionAllowed('clipboard-sanitized-write', PACKAGER), true);
    assert.equal(policy.isPermissionAllowed('media', PACKAGER), false);
    assert.equal(policy.isPermissionAllowed('clipboard-read', PACKAGER), false);
    for (const origin of ['https://example.com', 'null', '', 'blob:tsc-app://editor/1234', 'file:///']) {
        assert.equal(policy.isPermissionAllowed('media', origin), false, origin);
        assert.equal(policy.isPermissionAllowed('clipboard-sanitized-write', origin), false, origin);
    }
});

test('only web and mail links may leave the app', () => {
    assert.equal(policy.isExternalUrl('https://scratch.mit.edu/'), true);
    assert.equal(policy.isExternalUrl('http://localhost:8601/'), true);
    assert.equal(policy.isExternalUrl('mailto:a@b.test'), true);
    assert.equal(policy.isExternalUrl('file:///Applications/Calculator.app'), false);
    assert.equal(policy.isExternalUrl('smb://server/share'), false);
    assert.equal(policy.isExternalUrl('ms-settings:'), false);
    assert.equal(policy.isExternalUrl('tsc-app://editor/'), false);
});
