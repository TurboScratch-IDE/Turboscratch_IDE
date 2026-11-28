import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {
    defaultServerUrl,
    isDesktopApp,
    loadSavedServer,
    makeInviteLink,
    readInviteFromUrl,
    saveServer
} from '../src/lib/tsc-collab/settings.js';

/** Stands in for the browser's localStorage, so tests can see and change what's saved. */
const storage = new Map();
let storageBroken = false;
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
        getItem: key => {
            if (storageBroken) throw new Error('storage is disabled');
            return storage.has(key) ? storage.get(key) : null;
        },
        setItem: (key, value) => {
            if (storageBroken) throw new Error('storage is disabled');
            storage.set(key, String(value));
        },
        removeItem: key => storage.delete(key)
    }
});

const SERVER_KEY = 'tsc:collab-server';
const WEBSITE_SERVER = 'wss://collab.example.test';
const OWN_SERVER = 'wss://my-own-server.example.test';

// Where the editor is opened from.
const openedAt = (protocol, hostname) => {
    globalThis.location = {protocol, hostname, href: `${protocol}//${hostname}/`};
};

// Opened at this exact address (with its ?query and #hash), like a real page.
const openedAtAddress = address => {
    const url = new URL(address);
    globalThis.location = {
        protocol: url.protocol,
        hostname: url.hostname,
        href: url.href,
        search: url.search
    };
};

// The server the website was built with (TSC_COLLAB_SERVER), or none.
const builtWith = server => {
    if (server) {
        process.env.TSC_COLLAB_SERVER = server;
    } else {
        delete process.env.TSC_COLLAB_SERVER;
    }
};

// The website page the desktop app was built with (TSC_WEBSITE_URL), or none.
const builtWithWebsite = address => {
    if (address) {
        process.env.TSC_WEBSITE_URL = address;
    } else {
        delete process.env.TSC_WEBSITE_URL;
    }
};

// The desktop app's own page (tsc-app://editor), with some settings in it.
const DESKTOP_APP_PAGE = 'tsc-app://editor/editor.html?fps=60#123';
const WEBSITE_EDITOR = 'https://turboscratch-ide.github.io/Turboscratch_IDE/editor.html';
const ROOM = 'happy-cats-123';

beforeEach(() => {
    storage.clear();
    storageBroken = false;
    builtWith(null);
    builtWithWebsite(null);
    openedAt('https:', 'editor.example.test');
});

test('the default server: the website\'s own, or the one next to a local editor, or none', () => {
    assert.equal(defaultServerUrl(), '');
    builtWith(WEBSITE_SERVER);
    assert.equal(defaultServerUrl(), WEBSITE_SERVER);
    builtWith(null);
    openedAt('http:', '192.168.1.20');
    assert.equal(defaultServerUrl(), 'ws://192.168.1.20:8090');
});

test('nothing saved: nothing to load', () => {
    assert.equal(loadSavedServer(), null);
});

test('a saved server is used again while the website\'s default stays the same', () => {
    saveServer(OWN_SERVER);
    assert.equal(loadSavedServer(), OWN_SERVER);

    builtWith(WEBSITE_SERVER);
    storage.clear();
    saveServer(OWN_SERVER);
    assert.equal(loadSavedServer(), OWN_SERVER);
});

test('when the website gets a default server, it wins over one typed before, once', () => {
    // Typed in while the website had no server of its own.
    saveServer(OWN_SERVER);
    builtWith(WEBSITE_SERVER);
    assert.equal(loadSavedServer(), null);

    // Picked again after that: it's kept from now on.
    saveServer(OWN_SERVER);
    assert.equal(loadSavedServer(), OWN_SERVER);

    // The website changes its server again: the new one wins again.
    builtWith('wss://new-collab.example.test');
    assert.equal(loadSavedServer(), null);
});

test('a server saved by an older editor counts as saved under the page\'s own default', () => {
    // Older editors only saved the server, not the website's default.
    storage.set(SERVER_KEY, OWN_SERVER);
    // https website without a server of its own: still the same, so kept.
    assert.equal(loadSavedServer(), OWN_SERVER);
    // The https website now has one: that wins.
    builtWith(WEBSITE_SERVER);
    assert.equal(loadSavedServer(), null);

    // An editor on your own computer never had another default: kept.
    builtWith(null);
    openedAt('http:', 'localhost');
    assert.equal(loadSavedServer(), OWN_SERVER);
});

test('without localStorage, nothing is saved or loaded, and nothing breaks', () => {
    storageBroken = true;
    saveServer(OWN_SERVER);
    assert.equal(loadSavedServer(), null);
});

test('only the desktop app counts as the desktop app', () => {
    assert.equal(isDesktopApp(), false);
    openedAt('http:', 'localhost');
    assert.equal(isDesktopApp(), false);
    openedAtAddress(DESKTOP_APP_PAGE);
    assert.equal(isDesktopApp(), true);
});

test('the desktop app has no server next to it: it uses the built-in one, or asks', () => {
    openedAtAddress(DESKTOP_APP_PAGE);
    // Not ws://editor:8090: "editor" is no computer.
    assert.equal(defaultServerUrl(), '');
    builtWith(WEBSITE_SERVER);
    assert.equal(defaultServerUrl(), WEBSITE_SERVER);
});

test('invite links made in the desktop app open the website, with only the room and server', () => {
    openedAtAddress(DESKTOP_APP_PAGE);
    // Built without TSC_WEBSITE_URL: the normal website.
    assert.equal(
        makeInviteLink(ROOM, WEBSITE_SERVER),
        `${WEBSITE_EDITOR}?room=${ROOM}&collab_server=wss%3A%2F%2Fcollab.example.test`
    );
    // Built with it: that page.
    builtWithWebsite('https://my-site.example.test/tsc/editor.html');
    assert.equal(
        makeInviteLink(ROOM, WEBSITE_SERVER),
        `https://my-site.example.test/tsc/editor.html?room=${ROOM}&collab_server=wss%3A%2F%2Fcollab.example.test`
    );
    // Never the app's own address, even when the build has a broken one.
    for (const broken of ['not a web address', 'tsc-app://editor/editor.html', 'javascript:alert(1)']) {
        builtWithWebsite(broken);
        const link = makeInviteLink(ROOM, WEBSITE_SERVER);
        assert.ok(link.startsWith(`${WEBSITE_EDITOR}?`), `${broken} gave ${link}`);
    }
});

test('the website understands invite links made in the desktop app', () => {
    openedAtAddress(DESKTOP_APP_PAGE);
    const link = makeInviteLink(ROOM, WEBSITE_SERVER);
    // A friend opens the link on the website.
    openedAtAddress(link);
    assert.equal(isDesktopApp(), false);
    assert.deepEqual(readInviteFromUrl(), {room: ROOM, serverUrl: WEBSITE_SERVER});
});

test('on the website, invite links still open the same page (built website ignored)', () => {
    builtWithWebsite('https://my-site.example.test/tsc/editor.html');
    openedAtAddress('https://editor.example.test/Turboscratch_IDE/editor.html?fps=60#123');
    assert.equal(
        makeInviteLink(ROOM, WEBSITE_SERVER),
        'https://editor.example.test/Turboscratch_IDE/editor.html?fps=60' +
            `&room=${ROOM}&collab_server=wss%3A%2F%2Fcollab.example.test`
    );
    openedAtAddress('http://192.168.1.20:8601/editor.html?room=old-room');
    assert.equal(
        makeInviteLink(ROOM, 'ws://192.168.1.20:8090'),
        `http://192.168.1.20:8601/editor.html?room=${ROOM}&collab_server=ws%3A%2F%2F192.168.1.20%3A8090`
    );
});
