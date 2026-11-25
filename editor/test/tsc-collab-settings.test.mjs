import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {defaultServerUrl, loadSavedServer, saveServer} from '../src/lib/tsc-collab/settings.js';

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

// The server the website was built with (TSC_COLLAB_SERVER), or none.
const builtWith = server => {
    if (server) {
        process.env.TSC_COLLAB_SERVER = server;
    } else {
        delete process.env.TSC_COLLAB_SERVER;
    }
};

beforeEach(() => {
    storage.clear();
    storageBroken = false;
    builtWith(null);
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
