import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {getApiBase} from '../src/lib/tsc-community/api.js';

// Where the editor is opened from.
const openedAt = (protocol, hostname) => {
    globalThis.location = {protocol, hostname, href: `${protocol}//${hostname}/`};
};

// The server the website (or desktop app) was built with (TSC_COLLAB_SERVER), or none.
const builtWith = server => {
    if (server) {
        process.env.TSC_COLLAB_SERVER = server;
    } else {
        delete process.env.TSC_COLLAB_SERVER;
    }
};

beforeEach(() => {
    builtWith(null);
    openedAt('https:', 'editor.example.test');
});

test('the account server is the built-in one, as a normal web address', () => {
    assert.equal(getApiBase(), null);
    builtWith('wss://rooms.example.test/');
    assert.equal(getApiBase(), 'https://rooms.example.test');
    openedAt('tsc-app:', 'editor');
    assert.equal(getApiBase(), 'https://rooms.example.test');
});

test('an editor on your own computer uses the server next to it', () => {
    openedAt('http:', '192.168.1.20');
    assert.equal(getApiBase(), 'http://192.168.1.20:8090');
});

test('the desktop app never finds a server "next to it"', () => {
    openedAt('tsc-app:', 'editor');
    assert.equal(getApiBase(), null);
});

test('passwords never go unencrypted from the https website or the desktop app', () => {
    builtWith('ws://rooms.example.test');
    assert.equal(getApiBase(), null);
    openedAt('tsc-app:', 'editor');
    assert.equal(getApiBase(), null);
    // An editor on your own computer (http) is not a secure page anyway.
    openedAt('http:', 'localhost');
    assert.equal(getApiBase(), 'http://rooms.example.test');
});
