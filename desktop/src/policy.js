// Rules for which links and permissions the app allows. No Electron imports,
// so the unit tests can check every rule with plain Node.

// Never change these after the first release: the editor's saved settings,
// restore points, backpack and sign-in all live in storage that belongs to
// this exact origin.
const APP_SCHEME = 'tsc-app';
const APP_HOST = 'editor';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const START_URL = `${APP_ORIGIN}/editor.html`;

// "Package project" opens the TurboWarp Packager, which sends a message back
// to the editor window that opened it to ask for the project. That only works
// when it opens as a child window inside the app.
const PACKAGER_HOST = 'packager.turbowarp.org';

// Links that may go to the system browser or mail app
const EXTERNAL_PROTOCOLS = ['http:', 'https:', 'mailto:'];

const parseUrl = url => {
    try {
        return new URL(url);
    } catch (e) {
        return null;
    }
};

// Node's URL gives "null" as the origin of custom schemes, so compare the
// parts instead of url.origin.
const isAppUrl = url => {
    const parsed = parseUrl(url);
    return !!parsed &&
        parsed.protocol === `${APP_SCHEME}:` &&
        parsed.host === APP_HOST &&
        parsed.username === '' &&
        parsed.password === '';
};

const isPackagerUrl = url => {
    const parsed = parseUrl(url);
    return !!parsed &&
        parsed.protocol === 'https:' &&
        parsed.host === PACKAGER_HOST &&
        parsed.username === '' &&
        parsed.password === '';
};

const isExternalUrl = url => {
    const parsed = parseUrl(url);
    return !!parsed && EXTERNAL_PROTOCOLS.includes(parsed.protocol);
};

/**
 * What to do when a page calls window.open() or a link has target=_blank.
 * Only app pages may open app windows or the packager. Other pages (the
 * packager itself) can only send web links to the system browser.
 * @param {string} openerUrl the page that wants to open a window
 * @param {string} url the page it wants to open
 * @returns {'app-window'|'packager'|'external'|'deny'}
 */
const windowOpenAction = (openerUrl, url) => {
    if (isAppUrl(openerUrl)) {
        if (isAppUrl(url)) return 'app-window';
        if (isPackagerUrl(url)) return 'packager';
    }
    if (isExternalUrl(url)) return 'external';
    return 'deny';
};

/**
 * What to do when a window tries to load a new page in itself.
 * App pages may move between app pages, and the packager window may move
 * around the packager site. Everything else stays where it is, and web links
 * go to the system browser instead.
 * @param {string} currentUrl the page the window shows now ('' or about:blank
 * for a window that was just opened)
 * @param {string} targetUrl the page it wants to load
 * @returns {'allow'|'external'|'deny'}
 */
const navigationAction = (currentUrl, targetUrl) => {
    const isNewWindow = !currentUrl || currentUrl === 'about:blank';
    if (isAppUrl(targetUrl) && (isNewWindow || isAppUrl(currentUrl))) return 'allow';
    if (isPackagerUrl(targetUrl) && (isNewWindow || isPackagerUrl(currentUrl))) return 'allow';
    if (isExternalUrl(targetUrl)) return 'external';
    return 'deny';
};

// What the editor really uses: copy and paste, camera and microphone (video
// sensing, sound recording), Save to the same file (File System Access),
// full screen, pointer lock (some extensions), keeping restore points from
// being cleaned up, the system font list (custom fonts), and collaboration
// servers on this computer or the home network.
// Everything else (location, notifications, USB, screen sharing...) is refused.
const APP_PERMISSIONS = [
    'clipboard-read',
    'clipboard-sanitized-write',
    'media',
    'fileSystem',
    'fullscreen',
    'pointerLock',
    'persistent-storage',
    'local-fonts',
    'local-network',
    'local-network-access',
    'loopback-network'
];

// The packager only needs to copy text, preview in full screen and save files
const PACKAGER_PERMISSIONS = [
    'clipboard-sanitized-write',
    'fullscreen',
    'fileSystem'
];

/**
 * Since Electron 45, 'media' only means camera and microphone: screen
 * sharing is a separate 'display-capture' permission, which stays refused.
 * @param {string} permission Electron permission name
 * @param {string} requestingUrl URL or origin of the page that asks
 * @returns {boolean}
 */
const isPermissionAllowed = (permission, requestingUrl) => {
    if (isAppUrl(requestingUrl)) {
        return APP_PERMISSIONS.includes(permission);
    }
    if (isPackagerUrl(requestingUrl)) {
        return PACKAGER_PERMISSIONS.includes(permission);
    }
    return false;
};

module.exports = {
    APP_SCHEME,
    APP_HOST,
    APP_ORIGIN,
    START_URL,
    isAppUrl,
    isPackagerUrl,
    isExternalUrl,
    windowOpenAction,
    navigationAction,
    isPermissionAllowed
};
