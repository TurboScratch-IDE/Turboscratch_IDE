import {test, beforeEach, afterEach, mock} from 'node:test';
import assert from 'node:assert/strict';
import {CollabSession} from '../src/lib/tsc-collab/session.js';
import {getState} from '../src/lib/tsc-collab/store.js';

/**
 * Stands in for the browser's WebSocket and records every connection attempt,
 * so each test decides what the network and the server do.
 */
class FakeWebSocket {
    constructor (url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        FakeWebSocket.created.push(this);
    }

    send (data) {
        this.sent.push(JSON.parse(data));
    }

    close () {
        this.readyState = FakeWebSocket.CLOSED;
    }

    opens () {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen();
    }

    receives (message) {
        this.onmessage({data: JSON.stringify(message)});
    }

    /** The connection ends without a goodbye, like a dropped connection (code 1006). */
    closes () {
        this.readyState = FakeWebSocket.CLOSED;
        if (this.onerror) this.onerror();
        if (this.onclose) this.onclose({code: 1006});
    }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;
FakeWebSocket.created = [];

const lastSocket = () => FakeWebSocket.created[FakeWebSocket.created.length - 1];

globalThis.WebSocket = FakeWebSocket;
// Without fetch, the session skips its "wake up a sleeping server" request.
globalThis.fetch = undefined;

const SERVER = 'wss://rooms.example.test';

/** Lets join() finish its first step and open the first connection. */
const settle = () => new Promise(resolve => setImmediate(resolve));

const join = async () => {
    const session = new CollabSession();
    // join() needs the editor's VM; the connection steps tested here don't use it.
    session.vm = {};
    session.join({serverUrl: SERVER, room: 'room-1', name: 'Alex'});
    await settle();
    return session;
};

beforeEach(() => {
    FakeWebSocket.created = [];
    mock.timers.enable({apis: ['setTimeout', 'setInterval']});
});

afterEach(() => {
    mock.timers.reset();
});

test('a dropped first connection is tried again and can still join', async () => {
    const session = await join();
    assert.equal(FakeWebSocket.created.length, 1);
    assert.equal(FakeWebSocket.created[0].url, SERVER);

    FakeWebSocket.created[0].closes();
    assert.equal(getState().status, 'connecting');
    assert.equal(getState().error, null);

    mock.timers.tick(999);
    assert.equal(FakeWebSocket.created.length, 1);
    mock.timers.tick(1);
    assert.equal(FakeWebSocket.created.length, 2);

    const socket = lastSocket();
    socket.opens();
    assert.equal(socket.sent[0].t, 'hello');
    assert.equal(socket.sent[0].room, 'room-1');
    assert.equal(socket.sent[0].name, 'Alex');
    socket.receives({t: 'welcome', protocol: 1, id: 'abc', color: '#4dabf7', room: 'room-1', peers: []});
    assert.equal(getState().status, 'syncing');
    assert.equal(getState().error, null);
    session.leave();
});

test('gives up with an error after 3 retries', async () => {
    const session = await join();
    FakeWebSocket.created[0].closes();
    for (const delay of [1000, 2000, 3000]) {
        assert.equal(getState().status, 'connecting');
        mock.timers.tick(delay);
        lastSocket().closes();
    }
    assert.equal(FakeWebSocket.created.length, 4);
    assert.equal(getState().status, 'error');
    assert.match(getState().error, /^Couldn't connect to the collaboration server at wss:\/\/rooms\.example\.test\./);

    mock.timers.tick(60000);
    assert.equal(FakeWebSocket.created.length, 4);
    session.leave();
});

test('joining again starts with fresh retries', async () => {
    const session = await join();
    FakeWebSocket.created[0].closes();
    for (const delay of [1000, 2000, 3000]) {
        mock.timers.tick(delay);
        lastSocket().closes();
    }
    assert.equal(getState().status, 'error');

    session.join({serverUrl: SERVER, room: 'room-1', name: 'Alex'});
    await settle();
    assert.equal(FakeWebSocket.created.length, 5);
    lastSocket().closes();
    assert.equal(getState().status, 'connecting');
    mock.timers.tick(1000);
    assert.equal(FakeWebSocket.created.length, 6);
    session.leave();
});

test('a refusal from the server is not retried', async () => {
    const session = await join();
    const socket = FakeWebSocket.created[0];
    socket.opens();
    socket.receives({t: 'error', code: 'origin', message: 'This server does not accept connections from that website'});
    socket.closes();

    mock.timers.tick(60000);
    assert.equal(FakeWebSocket.created.length, 1);
    assert.equal(getState().status, 'error');
    assert.equal(getState().error, 'This server does not accept connections from that website');
    session.leave();
});

test('cancelling while waiting to retry stops trying', async () => {
    const session = await join();
    FakeWebSocket.created[0].closes();
    session.leave();

    mock.timers.tick(60000);
    assert.equal(FakeWebSocket.created.length, 1);
    assert.equal(getState().status, 'idle');
});
