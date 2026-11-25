import {test, beforeEach, afterEach, mock} from 'node:test';
import assert from 'node:assert/strict';
import {CollabSession} from '../src/lib/tsc-collab/session.js';
import {getState} from '../src/lib/tsc-collab/store.js';
import {fetchRoomList} from '../src/lib/tsc-collab/room-list.js';

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

    /** Remembers how the session closed it: a reconnect says so with a code. */
    close (...args) {
        if (!this.closeArgs) this.closeArgs = args;
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

/** Stands in for the browser's localStorage, so tests can look at everything saved. */
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key)
    }
});

// saveServer() asks which default server this website has.
globalThis.location = {protocol: 'https:', hostname: 'editor.example.test', href: 'https://editor.example.test/'};

const SERVER = 'wss://rooms.example.test';

/** Lets join() finish its first step and open the first connection. */
const settle = () => new Promise(resolve => setImmediate(resolve));

const join = async extra => {
    const session = new CollabSession();
    // join() needs the editor's VM; the connection steps tested here don't use it.
    session.vm = {};
    // Just enough of vm-sync for the session to go live (no project changes here).
    session.sync = {
        setCapturing () {},
        hasPendingOutgoing: () => false,
        uninstall () {}
    };
    session.join(Object.assign({serverUrl: SERVER, room: 'room-1', name: 'Alex'}, extra));
    await settle();
    return session;
};

/** The server lets this connection into the room (a new server: it knows room passwords). */
const welcome = (socket, extra) => socket.receives(Object.assign({
    t: 'welcome',
    protocol: 1,
    id: 'me-1',
    name: 'Alex',
    color: '#4dabf7',
    room: 'room-1',
    peers: [],
    hasProject: true,
    listed: false,
    title: null,
    locked: false,
    resume: 'token-1'
}, extra));

/** The room's project has arrived: the session is live (settings can be changed). */
const goLive = async socket => {
    socket.receives({t: 'caught-up', seq: 0});
    await settle();
    assert.equal(getState().status, 'connected');
};

/** The connection drops and the session connects again (first retry after 1 second). */
const reconnect = socket => {
    socket.closes();
    assert.equal(getState().status, 'reconnecting');
    mock.timers.tick(1000);
    const next = lastSocket();
    assert.notEqual(next, socket);
    next.opens();
    return next;
};

/** Someone changed the room's settings; the server tells everyone the room as it is now. */
const roomInfo = (socket, fields) => socket.receives(Object.assign({
    t: 'room-info',
    listed: false,
    title: null,
    locked: false
}, fields));

const lastChat = () => {
    const chat = getState().chat;
    return chat.length ? chat[chat.length - 1].text : null;
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

// ---- room passwords and room names ---------------------------------------

test('no password is sent when none was typed', async () => {
    const session = await join();
    const socket = lastSocket();
    socket.opens();
    assert.equal(socket.sent[0].t, 'hello');
    assert.equal('password' in socket.sent[0], false);
    session.leave();
});

test('the room password is sent in hello, and again after a dropped connection', async () => {
    const session = await join({password: 'secret-1'});
    let socket = lastSocket();
    socket.opens();
    assert.equal(socket.sent[0].t, 'hello');
    assert.equal(socket.sent[0].password, 'secret-1');

    welcome(socket, {locked: true});
    assert.equal(getState().locked, true);
    assert.equal(getState().lockSupported, true);

    socket = reconnect(socket);
    assert.equal(socket.sent[0].t, 'hello');
    assert.equal(socket.sent[0].password, 'secret-1');
    assert.equal(socket.sent[0].resume, 'token-1');
    session.leave();
});

test('the password is never saved in localStorage or in the shared state', async () => {
    storage.clear();
    const session = await join({password: 'secret-2'});
    const socket = lastSocket();
    socket.opens();
    welcome(socket, {locked: true});
    await goLive(socket);
    assert.equal(session.setRoomPassword('secret-3'), true);
    roomInfo(socket, {locked: true, by: 'me-1', changed: 'password-set'});

    // The name and server were saved, so this looked at the right storage.
    assert.ok(storage.size > 0);
    for (const value of storage.values()) {
        assert.equal(value.includes('secret-'), false);
    }
    assert.equal(JSON.stringify(getState()).includes('secret-'), false);

    session.leave();
    assert.equal(session.joinParams.password, null);
});

test('password errors end the session without trying again', async () => {
    for (const code of ['password-needed', 'wrong-password', 'too-many-tries', 'bad-password']) {
        FakeWebSocket.created = [];
        const session = await join({password: code === 'password-needed' ? '' : 'not-it'});
        const socket = lastSocket();
        socket.opens();
        socket.receives({t: 'error', code, message: `Refused: ${code}`});
        socket.closes();

        mock.timers.tick(60000);
        assert.equal(FakeWebSocket.created.length, 1, code);
        assert.equal(getState().status, 'error', code);
        assert.equal(getState().error, `Refused: ${code}`);
        assert.equal(getState().errorCode, code);
        session.leave();
    }
});

test('a password error while reconnecting ends the session too', async () => {
    const session = await join({password: 'secret-1'});
    let socket = lastSocket();
    socket.opens();
    welcome(socket, {locked: true});

    socket = reconnect(socket);
    socket.receives({t: 'error', code: 'wrong-password', message: 'Wrong password for this room.'});
    socket.closes();

    mock.timers.tick(60000);
    assert.equal(FakeWebSocket.created.length, 2);
    assert.equal(getState().status, 'error');
    assert.equal(getState().error, 'Wrong password for this room.');
    assert.equal(getState().errorCode, 'wrong-password');
    session.leave();
});

test('a refusal keeps the server\'s error code until the next join', async () => {
    const session = await join();
    const socket = lastSocket();
    socket.opens();
    socket.receives({t: 'error', code: 'room-full', message: 'This room is full'});
    assert.equal(getState().status, 'error');
    assert.equal(getState().errorCode, 'room-full');

    // Joining again starts without the old error.
    session.join({serverUrl: SERVER, room: 'room-1', name: 'Alex'});
    assert.equal(getState().errorCode, null);
    session.leave();
});

test('no warning on an older server when no password was typed', async () => {
    const session = await join();
    const socket = lastSocket();
    socket.opens();
    socket.receives({t: 'welcome', protocol: 1, id: 'me-1', color: '#4dabf7', room: 'room-1', peers: []});
    assert.equal(getState().lockSupported, false);
    assert.equal(getState().chat.some(line => /password/.test(line.text)), false);
    session.leave();
});

test('room-info: renames, password changes and Open rooms by someone else', async () => {
    const session = await join();
    const socket = lastSocket();
    socket.opens();
    welcome(socket, {peers: [{id: 'p-2', name: 'Sam', color: '#ff6680'}]});
    await goLive(socket);

    roomInfo(socket, {title: 'Platformer team', by: 'p-2', changed: 'title'});
    assert.equal(getState().title, 'Platformer team');
    assert.equal(session.joinParams.title, 'Platformer team');
    assert.equal(lastChat(), 'Sam renamed the room to "Platformer team"');

    roomInfo(socket, {by: 'p-2', changed: 'title'});
    assert.equal(getState().title, null);
    assert.equal(session.joinParams.title, null);
    assert.equal(lastChat(), 'Sam removed the room\'s name');

    roomInfo(socket, {locked: true, by: 'p-2', changed: 'password-set'});
    assert.equal(getState().locked, true);
    assert.equal(lastChat(), 'Sam set a new password for this room. Ask them for it: ' +
        'you\'ll need it if you get disconnected.');
    // Only our own changes give us a password to reconnect with.
    assert.equal(session.joinParams.password, null);

    roomInfo(socket, {by: 'p-2', changed: 'password-removed'});
    assert.equal(getState().locked, false);
    assert.equal(lastChat(), 'Sam removed the room\'s password. Anyone with the room code can join now.');

    roomInfo(socket, {listed: true, by: 'p-2', changed: 'listed'});
    assert.equal(getState().listed, true);
    assert.match(lastChat(), /^Sam put this room in Open rooms/);

    // Older servers: no "changed" and no "locked".
    socket.receives({t: 'room-info', listed: false, title: null, by: 'p-2'});
    assert.equal(getState().listed, false);
    assert.equal(getState().locked, false);
    assert.match(lastChat(), /^Sam hid this room from Open rooms/);
    session.leave();
});

test('renaming the room sends the new name', async () => {
    const session = await join();
    const socket = lastSocket();
    socket.opens();
    welcome(socket);
    // Not in the room yet: nothing is sent.
    assert.equal(session.renameRoom('Too early'), false);
    await goLive(socket);

    assert.equal(session.renameRoom('  Platformer team  '), true);
    assert.deepEqual(socket.sent[socket.sent.length - 1], {t: 'room-settings', title: 'Platformer team'});
    roomInfo(socket, {title: 'Platformer team', by: 'me-1', changed: 'title'});
    assert.equal(lastChat(), 'You renamed the room to "Platformer team"');
    session.leave();
});

test('your own password change is used when reconnecting, and removing it too', async () => {
    const session = await join();
    let socket = lastSocket();
    socket.opens();
    welcome(socket);
    await goLive(socket);

    // Too short or too long: not sent.
    assert.equal(session.setRoomPassword('abc'), false);
    assert.equal(session.setRoomPassword('x'.repeat(101)), false);
    assert.equal(session.setRoomPassword('new-secret'), true);
    assert.deepEqual(socket.sent[socket.sent.length - 1], {t: 'room-settings', password: 'new-secret'});
    // Not confirmed yet: a refused change must not lock us out.
    assert.equal(session.joinParams.password, null);

    roomInfo(socket, {locked: true, by: 'me-1', changed: 'password-set'});
    assert.equal(getState().locked, true);
    assert.equal(session.joinParams.password, 'new-secret');
    assert.match(lastChat(), /^You set a new password for this room/);

    socket = reconnect(socket);
    assert.equal(socket.sent[0].password, 'new-secret');
    welcome(socket, {id: 'me-2', locked: true, resume: 'token-2'});
    await goLive(socket);

    assert.equal(session.setRoomPassword(null), true);
    assert.deepEqual(socket.sent[socket.sent.length - 1], {t: 'room-settings', password: null});
    roomInfo(socket, {by: 'me-2', changed: 'password-removed'});
    assert.equal(getState().locked, false);
    assert.equal(session.joinParams.password, null);
    assert.equal(lastChat(), 'You removed the room\'s password. Anyone with the room code can join now.');

    socket = reconnect(socket);
    assert.equal('password' in socket.sent[0], false);
    session.leave();
});

test('a refused new password while in the room keeps the session going', async () => {
    const session = await join({password: 'secret-1'});
    const socket = lastSocket();
    socket.opens();
    welcome(socket, {locked: true});
    await goLive(socket);

    assert.equal(session.setRoomPassword('another-one'), true);
    socket.receives({t: 'error', code: 'bad-password', message: 'Room passwords can be at most 100 characters'});
    assert.equal(getState().status, 'connected');
    assert.equal(lastChat(), 'Room passwords can be at most 100 characters');
    // The refused password is never used for reconnecting. (A password-set
    // that we can't match to a password we sent means the old one is wrong
    // now, so there's none to reconnect with.)
    roomInfo(socket, {locked: true, by: 'me-1', changed: 'password-set'});
    assert.equal(session.joinParams.password, null);
    session.leave();
});

test('the room list keeps whether a room has a password', async () => {
    const answer = {rooms: [
        {room: 'open-room', title: 'Open', people: 1, names: ['Sam']},
        {room: 'locked-room', title: 'Secret', people: 2, names: ['Kim', 'Lee'], locked: true},
        {room: 'odd-room', title: null, people: 1, names: [], locked: 'yes'}
    ]};
    globalThis.fetch = url => {
        assert.equal(url, 'https://rooms.example.test/rooms');
        return Promise.resolve({
            status: 200,
            ok: true,
            json: () => Promise.resolve(answer)
        });
    };
    try {
        const rooms = await fetchRoomList(SERVER, null);
        assert.deepEqual(rooms.map(room => [room.room, room.locked]), [
            ['open-room', false],
            ['locked-room', true],
            ['odd-room', false]
        ]);
    } finally {
        globalThis.fetch = undefined;
    }
});

test('an own password change confirmed after a removal is still used for reconnecting', async () => {
    const session = await join();
    let socket = lastSocket();
    socket.opens();
    welcome(socket);
    await goLive(socket);

    // The server takes a moment to scramble a new password, so a removal sent
    // a moment later can be applied first.
    assert.equal(session.setRoomPassword('slow-secret'), true);
    assert.equal(session.setRoomPassword(null), true);
    roomInfo(socket, {by: 'me-1', changed: 'password-removed'});
    roomInfo(socket, {locked: true, by: 'me-1', changed: 'password-set'});
    assert.equal(getState().locked, true);
    assert.equal(session.joinParams.password, 'slow-secret');

    socket = reconnect(socket);
    assert.equal(socket.sent[0].password, 'slow-secret');
    session.leave();
});

// ---- password changes, and rooms the server forgot -----------------------

const SAM = {id: 'p-2', name: 'Sam', color: '#ff6680'};
const toastTexts = () => getState().toasts.map(toast => toast.text);

test('after someone else sets a new password, reconnects send no old password', async () => {
    const session = await join({password: 'old-secret'});
    let socket = lastSocket();
    socket.opens();
    // A typed password: the room must have one.
    assert.equal(socket.sent[0].expectLocked, true);
    welcome(socket, {locked: true, peers: [SAM]});
    await goLive(socket);

    roomInfo(socket, {locked: true, by: 'p-2', changed: 'password-set'});
    // The old password is wrong now: sending it would count as a wrong guess.
    assert.equal(session.joinParams.password, null);

    socket = reconnect(socket);
    const hello = socket.sent[0];
    assert.equal(hello.t, 'hello');
    assert.equal('password' in hello, false);
    assert.equal(hello.expectLocked, true);
    assert.equal(hello.resume, 'token-1');
    session.leave();
});

test('a room seen with a password is expected to have one when reconnecting', async () => {
    const session = await join();
    let socket = lastSocket();
    socket.opens();
    welcome(socket, {peers: [SAM]});
    await goLive(socket);
    socket = reconnect(socket);
    assert.equal('expectLocked' in socket.sent[0], false);
    welcome(socket, {peers: [SAM], resume: 'token-2'});
    await goLive(socket);

    roomInfo(socket, {locked: true, by: 'p-2', changed: 'password-set'});
    socket = reconnect(socket);
    assert.equal(socket.sent[0].expectLocked, true);
    assert.equal('password' in socket.sent[0], false);
    // The server forgot the room: it isn't made again without the password.
    socket.receives({t: 'error', code: 'password-needed', message: 'This room has a password. Type it to join.'});
    assert.equal(getState().status, 'error');
    assert.equal(getState().errorCode, 'password-needed');

    // Trying the same room again from the join form still says so...
    session.join({serverUrl: SERVER, room: 'room-1', name: 'Alex'});
    await settle();
    lastSocket().opens();
    assert.equal(lastSocket().sent[0].expectLocked, true);
    // ...but another room starts fresh.
    session.join({serverUrl: SERVER, room: 'room-2', name: 'Alex'});
    await settle();
    lastSocket().opens();
    assert.equal('expectLocked' in lastSocket().sent[0], false);
    session.leave();
});

test('leaving forgets that the room has a password', async () => {
    const session = await join({password: 'secret-1'});
    lastSocket().opens();
    welcome(lastSocket(), {locked: true});
    session.leave();

    session.join({serverUrl: SERVER, room: 'room-1', name: 'Alex'});
    await settle();
    lastSocket().opens();
    assert.equal('expectLocked' in lastSocket().sent[0], false);
    session.leave();
});

test('once the password is removed, reconnects don\'t expect one', async () => {
    const session = await join({password: 'secret-1'});
    let socket = lastSocket();
    socket.opens();
    welcome(socket, {locked: true, peers: [SAM]});
    await goLive(socket);

    roomInfo(socket, {by: 'p-2', changed: 'password-removed'});
    socket = reconnect(socket);
    assert.equal('expectLocked' in socket.sent[0], false);
    assert.equal('password' in socket.sent[0], false);
    session.leave();
});

const UNLOCKED = 'This room came back without its password, so you were taken out of it to keep your ' +
    'project private. Join again if you expected this.';
const NOT_IN_ROOM = 'You\'re not in the room any more: click Collaborate to join again.';

/**
 * Gives the session just enough of a project to upload it when the server asks.
 * @param {CollabSession} session the session
 * @returns {Array<number>} filled with the room's number each time a project is made for upload
 */
const withUploads = session => {
    const uploads = [];
    session.vm = {runtime: {getTargetForStage: () => ({})}};
    session.sync = {
        setCapturing () {},
        hasPendingOutgoing: () => false,
        uninstall () {},
        saveSnapshot: getSeq => {
            uploads.push(getSeq());
            return Promise.resolve({seq: getSeq(), hash: 'h', data: new Uint8Array([0x50, 0x4b, 3, 4]).buffer});
        }
    };
    return uploads;
};

test('a room that came back without its password is left before anything is shared', async () => {
    const session = await join({password: 'secret-1'});
    const uploads = withUploads(session);
    let socket = lastSocket();
    socket.opens();
    welcome(socket, {locked: true, listed: true, title: 'Team'});
    await goLive(socket);

    // The server forgot the room, and an outsider without the password made
    // it again: it lets us in as a room without one.
    socket = reconnect(socket);
    assert.equal(socket.sent[0].password, 'secret-1');
    assert.equal(socket.sent[0].expectLocked, true);
    welcome(socket, {
        locked: false,
        listed: true,
        title: 'Team',
        hasProject: false,
        resume: 'token-2',
        peers: [{id: 'x-1', name: 'Outsider', color: '#000000'}]
    });

    assert.equal(getState().status, 'error');
    assert.equal(getState().error, UNLOCKED);
    assert.equal(getState().errorCode, 'room-unlocked');
    // Nothing more from that connection is used: the outsider's request for
    // our project never reaches the session.
    assert.equal(socket.onmessage, null);
    // A plain close: we left, so the server doesn't keep our place.
    assert.deepEqual(socket.closeArgs, []);
    await settle();
    assert.deepEqual(uploads, []);
    assert.equal(socket.sent.some(message => message.t === 'snapshot' || message.t === 'presence'), false);
    assert.deepEqual(getState().peers, []);
    // Said in red, also outside the dialog.
    const notice = `${UNLOCKED} ${NOT_IN_ROOM}`;
    assert.ok(getState().toasts.some(toast => toast.text === notice && toast.color === '#e5484d'));
    assert.equal(lastChat(), notice);
    // Not tried again on its own.
    mock.timers.tick(60000);
    assert.equal(lastSocket(), socket);
    // Still expected to have a password, and the password is forgotten.
    assert.equal(session.expectLocked, true);
    assert.equal(session.joinParams.password, null);
    session.leave();
});

test('joining again by hand after that is the person\'s choice', async () => {
    const session = await join({password: 'secret-1'});
    let socket = lastSocket();
    socket.opens();
    welcome(socket, {locked: true});
    await goLive(socket);
    socket = reconnect(socket);
    welcome(socket, {locked: false, resume: 'token-2'});
    assert.equal(getState().errorCode, 'room-unlocked');

    // The same room again: a room the server forgot still isn't made open...
    session.join({serverUrl: SERVER, room: 'room-1', name: 'Alex'});
    await settle();
    socket = lastSocket();
    socket.opens();
    assert.equal(socket.sent[0].expectLocked, true);
    assert.equal('password' in socket.sent[0], false);
    // ...but they chose to join the room as it is now.
    welcome(socket, {locked: false, resume: 'token-3'});
    assert.equal(getState().status, 'syncing');
    assert.equal(getState().locked, false);
    await goLive(socket);
    socket = reconnect(socket);
    assert.equal('expectLocked' in socket.sent[0], false);
    session.leave();
});

test('only that one join accepts a room without its password', async () => {
    const session = await join();
    let socket = lastSocket();
    socket.opens();
    welcome(socket, {peers: [SAM]});
    await goLive(socket);
    roomInfo(socket, {locked: true, by: 'p-2', changed: 'password-set'});
    socket = reconnect(socket);
    socket.receives({t: 'error', code: 'password-needed', message: 'This room has a password. Type it to join.'});
    assert.equal(getState().errorCode, 'password-needed');

    // Joining again after another error still leaves a room that has no
    // password any more (say, it was removed meanwhile)...
    session.join({serverUrl: SERVER, room: 'room-1', name: 'Alex'});
    await settle();
    socket = lastSocket();
    socket.opens();
    assert.equal(socket.sent[0].expectLocked, true);
    welcome(socket, {locked: false, resume: 'token-2'});
    assert.equal(getState().errorCode, 'room-unlocked');
    // (They never got in with this join: the join form says it, no extra notice.)
    assert.equal(toastTexts().includes(`${UNLOCKED} ${NOT_IN_ROOM}`), false);
    assert.equal(getState().chat.some(line => line.text.endsWith(NOT_IN_ROOM)), false);

    // Then the person chooses to join it anyway.
    session.join({serverUrl: SERVER, room: 'room-1', name: 'Alex'});
    await settle();
    socket = lastSocket();
    socket.opens();
    welcome(socket, {locked: false, resume: 'token-3'});
    assert.equal(getState().status, 'syncing');
    assert.equal(getState().errorCode, null);
    session.leave();
});

test('an older server without room passwords is left too when reconnecting', async () => {
    const session = await join({password: 'secret-1'});
    let socket = lastSocket();
    socket.opens();
    welcome(socket, {locked: true});
    await goLive(socket);

    socket = reconnect(socket);
    // Older servers don't send "locked".
    socket.receives({t: 'welcome', protocol: 1, id: 'me-2', room: 'room-1', peers: [], listed: false});
    assert.equal(getState().status, 'error');
    assert.equal(getState().errorCode, 'room-unlocked');
    assert.equal(socket.onmessage, null);
    session.leave();
});

test('a connection that looks dead is closed with the "reconnecting" code', async () => {
    const session = await join();
    let socket = lastSocket();
    socket.opens();
    welcome(socket);
    await goLive(socket);

    // Nothing heard for longer than the server ever stays quiet.
    session.lastMessageAt = Date.now() - 46000;
    mock.timers.tick(15000);
    assert.deepEqual(socket.closeArgs, [4000, 'reconnecting']);
    assert.equal(getState().status, 'reconnecting');
    mock.timers.tick(1000);
    socket = lastSocket();
    socket.opens();
    assert.equal(socket.sent[0].resume, 'token-1');

    // Leaving is a plain close, so the server doesn't keep the place.
    session.leave();
    assert.deepEqual(socket.closeArgs, []);
});

test('a reconnect refused because of the password says so outside the dialog', async () => {
    for (const code of ['password-needed', 'too-many-tries']) {
        FakeWebSocket.created = [];
        const session = await join({password: 'secret-1'});
        let socket = lastSocket();
        socket.opens();
        welcome(socket, {locked: true, peers: [SAM]});
        await goLive(socket);
        roomInfo(socket, {locked: true, by: 'p-2', changed: 'password-set'});

        socket = reconnect(socket);
        const message = `Refused: ${code}`;
        socket.receives({t: 'error', code, message});
        assert.equal(getState().status, 'error', code);
        assert.equal(getState().errorCode, code);
        const notice = `${message} ${NOT_IN_ROOM}`;
        assert.ok(getState().toasts.some(toast => toast.text === notice && toast.color === '#e5484d'), code);
        assert.equal(lastChat(), notice, code);
        session.leave();
    }
});

test('a join refused before getting in shows no extra notice', async () => {
    const session = await join();
    const socket = lastSocket();
    socket.opens();
    socket.receives({t: 'error', code: 'wrong-password', message: 'Wrong password for this room.'});
    assert.equal(getState().status, 'error');
    assert.equal(toastTexts().some(text => text.includes(NOT_IN_ROOM)), false);
    assert.equal(getState().chat.some(line => line.text.includes(NOT_IN_ROOM)), false);
    session.leave();
});

test('a room with a password put in Open rooms says the password is still needed', async () => {
    const session = await join({password: 'secret-1'});
    const socket = lastSocket();
    socket.opens();
    welcome(socket, {locked: true, peers: [SAM]});
    await goLive(socket);

    roomInfo(socket, {listed: true, locked: true, by: 'p-2', changed: 'listed'});
    assert.equal(lastChat(), 'Sam put this room in Open rooms. People on this server can find it there, ' +
        'but they need the password to join.');
    roomInfo(socket, {listed: false, locked: true, by: 'p-2', changed: 'listed'});
    roomInfo(socket, {listed: true, locked: false, by: 'me-1', changed: 'listed'});
    assert.equal(lastChat(), 'You put this room in Open rooms. Anyone on this server can join.');
    session.leave();
});

test('a refused room-settings change is shown, and the session goes on', async () => {
    const session = await join();
    const socket = lastSocket();
    socket.opens();
    welcome(socket);
    await goLive(socket);

    assert.equal(session.setRoomPassword('new-secret'), true);
    const busy = 'The server is busy right now. Try again in a minute.';
    socket.receives({t: 'error', code: 'busy', for: 'room-settings', message: busy});
    assert.equal(getState().status, 'connected');
    assert.equal(lastChat(), busy);
    assert.ok(toastTexts().includes(busy));
    assert.equal(session.pendingPassword, null);

    assert.equal(session.setRoomPassword('other-secret'), true);
    socket.receives({t: 'error', code: 'bad-password', for: 'room-settings', message: 'Not that one'});
    assert.equal(getState().status, 'connected');
    assert.equal(lastChat(), 'Not that one');
    // A refused password is never used for reconnecting.
    roomInfo(socket, {locked: true, by: 'me-1', changed: 'password-set'});
    assert.equal(session.joinParams.password, null);

    // A connection that drops soon after isn't blamed on it.
    socket.closes();
    assert.equal(getState().status, 'reconnecting');
    assert.ok(toastTexts().some(text => text.startsWith('Connection lost.')));
    assert.equal(toastTexts().some(text => text.startsWith(busy) && text !== busy), false);
    session.leave();
});

test('a busy answer to a password change from a server without "for" is shown too', async () => {
    const session = await join();
    const socket = lastSocket();
    socket.opens();
    welcome(socket);
    await goLive(socket);

    assert.equal(session.setRoomPassword('new-secret'), true);
    socket.receives({t: 'error', code: 'busy', message: 'The server is busy right now.'});
    assert.equal(getState().status, 'connected');
    assert.equal(lastChat(), 'The server is busy right now.');
    assert.equal(session.pendingPassword, null);
    assert.equal(session.lastServerError, null);
    session.leave();
});

// ---- typed passwords, joining by choice, and busy servers ----------------

const NO_PASSWORD = 'This room has no password, so you weren\'t let in, to keep your project private. ' +
    'To join it anyway, empty the password box and join again.';
const NO_PASSWORDS_ON_SERVER = 'This server doesn\'t support room passwords yet, so you weren\'t let in. ' +
    'Empty the password box to join without one.';
const NO_PROJECT = 'This room has no project and no password. It may not be your friends\' room, ' +
    'so your project wasn\'t shared.';
const OUTSIDER = {id: 'x-1', name: 'Outsider', color: '#000000'};
// Older servers don't send "locked".
const OLD_SERVER_WELCOME = {t: 'welcome', protocol: 1, id: 'me-1', room: 'room-1', peers: [], listed: false};
const BUSY = 'The server is busy right now. Try again in a minute.';

/**
 * Joins the same room again from the join form.
 * @param {CollabSession} session the session
 * @param {string} password what's in the password box
 * @returns {FakeWebSocket} the new connection, open
 */
const joinAgain = async (session, password) => {
    session.join({serverUrl: SERVER, room: 'room-1', name: 'Alex', password});
    await settle();
    const socket = lastSocket();
    socket.opens();
    return socket;
};

test('a typed password for a room without one: not let in, and nothing is shared', async () => {
    const session = await join({password: 'secret-1'});
    const uploads = withUploads(session);
    const socket = lastSocket();
    socket.opens();
    // A typed password: only a room with a password may let us in.
    assert.equal(socket.sent[0].password, 'secret-1');
    assert.equal(socket.sent[0].expectLocked, true);
    // Someone made a room with this code without a password, and wants our project.
    welcome(socket, {locked: false, hasProject: false, peers: [OUTSIDER]});

    assert.equal(getState().status, 'error');
    assert.equal(getState().error, NO_PASSWORD);
    assert.equal(getState().errorCode, 'room-unlocked');
    // Nothing more from that connection is used, and we left (plain close).
    assert.equal(socket.onmessage, null);
    assert.deepEqual(socket.closeArgs, []);
    await settle();
    assert.deepEqual(uploads, []);
    assert.equal(socket.sent.some(message => message.t === 'snapshot' || message.t === 'presence'), false);
    // They never got in: the join form says it, no extra notice.
    assert.equal(toastTexts().some(text => text.includes(NO_PASSWORD)), false);
    assert.equal(getState().chat.some(line => line.text.includes(NO_PASSWORD)), false);
    mock.timers.tick(60000);
    assert.equal(lastSocket(), socket);
    session.leave();
});

test('a typed password on a server without room passwords: not let in', async () => {
    const session = await join({password: 'secret-1'});
    const uploads = withUploads(session);
    let socket = lastSocket();
    socket.opens();
    assert.equal(socket.sent[0].expectLocked, true);
    socket.receives(OLD_SERVER_WELCOME);
    assert.equal(getState().status, 'error');
    assert.equal(getState().error, NO_PASSWORDS_ON_SERVER);
    assert.equal(getState().errorCode, 'room-unlocked');
    assert.equal(socket.onmessage, null);

    // With the box empty they're let in, and as the message promised, a new
    // room there gets their project (that server never had passwords).
    socket = await joinAgain(session, '');
    assert.equal('expectLocked' in socket.sent[0], false);
    socket.receives(OLD_SERVER_WELCOME);
    assert.equal(getState().status, 'syncing');
    socket.receives({t: 'need-snapshot', seq: 0});
    await settle();
    assert.deepEqual(uploads, [0]);
    assert.equal(getState().status, 'connected');
    session.leave();
});

test('a typed password makes a new room with it, and shares the project there', async () => {
    const session = await join({password: 'secret-1'});
    const uploads = withUploads(session);
    const socket = lastSocket();
    socket.opens();
    assert.equal(socket.sent[0].expectLocked, true);
    welcome(socket, {locked: true, hasProject: false});
    socket.receives({t: 'need-snapshot', seq: 0});
    await settle();
    assert.deepEqual(uploads, [0]);
    assert.equal(socket.sent[socket.sent.length - 1].t, 'snapshot');
    assert.equal(getState().status, 'connected');
    session.leave();
});

test('a typed password expects a room with a password only for that join', async () => {
    const session = await join({password: 'secret-1'});
    lastSocket().opens();
    lastSocket().receives({t: 'error', code: 'wrong-password', message: 'Wrong password for this room.'});

    // The same room again with the box empty is a normal join.
    const socket = await joinAgain(session, '');
    assert.equal('expectLocked' in socket.sent[0], false);
    welcome(socket, {locked: false});
    assert.equal(getState().status, 'syncing');
    session.leave();
});

test('joining that room again with the password still typed is refused again', async () => {
    const session = await join({password: 'secret-1'});
    lastSocket().opens();
    welcome(lastSocket(), {locked: false});
    assert.equal(getState().errorCode, 'room-unlocked');

    const socket = await joinAgain(session, 'secret-1');
    assert.equal(socket.sent[0].expectLocked, true);
    welcome(socket, {locked: false});
    assert.equal(getState().status, 'error');
    assert.equal(getState().error, NO_PASSWORD);
    assert.equal(socket.onmessage, null);
    session.leave();
});

test('joined by choice, a room without a project never gets ours', async () => {
    const session = await join({password: 'secret-1'});
    const uploads = withUploads(session);
    lastSocket().opens();
    welcome(lastSocket(), {locked: false, hasProject: false, peers: [OUTSIDER]});
    assert.equal(getState().error, NO_PASSWORD);

    // They empty the password box and join again: let in...
    const socket = await joinAgain(session, '');
    assert.equal('password' in socket.sent[0], false);
    welcome(socket, {locked: false, hasProject: false, peers: [OUTSIDER], resume: 'token-2'});
    assert.equal(getState().status, 'syncing');
    // ...but when the room asks for our project (its maker left), we leave.
    socket.receives({t: 'need-snapshot', seq: 0});
    assert.equal(getState().status, 'error');
    assert.equal(getState().error, NO_PROJECT);
    assert.equal(getState().errorCode, 'room-unlocked');
    assert.equal(socket.onmessage, null);
    assert.deepEqual(socket.closeArgs, []);
    await settle();
    assert.deepEqual(uploads, []);
    assert.equal(socket.sent.some(message => message.t === 'snapshot'), false);
    // They were in the room for a moment: said outside the dialog too.
    assert.ok(toastTexts().includes(`${NO_PROJECT} ${NOT_IN_ROOM}`));
    mock.timers.tick(60000);
    assert.equal(lastSocket(), socket);
    session.leave();
});

test('the same after being taken out of a room while reconnecting', async () => {
    const session = await join({password: 'secret-1'});
    const uploads = withUploads(session);
    let socket = lastSocket();
    socket.opens();
    welcome(socket, {locked: true});
    await goLive(socket);
    socket = reconnect(socket);
    welcome(socket, {locked: false, hasProject: false, resume: 'token-2'});
    assert.equal(getState().error, UNLOCKED);

    socket = await joinAgain(session, '');
    // (A room the server forgot still isn't made again open.)
    assert.equal(socket.sent[0].expectLocked, true);
    welcome(socket, {locked: false, hasProject: false, resume: 'token-3'});
    assert.equal(getState().status, 'syncing');
    socket.receives({t: 'need-snapshot', seq: 0});
    assert.equal(getState().error, NO_PROJECT);
    await settle();
    assert.deepEqual(uploads, []);
    session.leave();
});

test('joined by choice, once the room\'s project is received it may be sent back after a restart', async () => {
    const session = await join({password: 'secret-1'});
    const uploads = withUploads(session);
    session.sync.loadSnapshot = () => Promise.resolve();
    lastSocket().opens();
    welcome(lastSocket(), {locked: false});

    let socket = await joinAgain(session, '');
    welcome(socket, {locked: false});
    // 'UEsDBA==' is the start of a project file.
    socket.receives({t: 'snapshot', seq: 3, data: 'UEsDBA=='});
    await goLive(socket);
    assert.equal(session.appliedSeq, 3);

    // The server forgot the room and asks us for the project: it is the
    // room's own project now, so it is sent back.
    socket = reconnect(socket);
    welcome(socket, {locked: false, hasProject: false, resume: 'token-2'});
    socket.receives({t: 'need-snapshot', seq: 0});
    await settle();
    assert.deepEqual(uploads, [0]);
    assert.equal(getState().status, 'connected');
    uploads.length = 0;

    // A new join starts fresh: a new room gets our project as usual.
    session.join({serverUrl: SERVER, room: 'room-2', name: 'Alex'});
    await settle();
    socket = lastSocket();
    socket.opens();
    welcome(socket, {room: 'room-2', locked: false, hasProject: false});
    socket.receives({t: 'need-snapshot', seq: 0});
    await settle();
    assert.deepEqual(uploads, [0]);
    assert.equal(getState().status, 'connected');
    session.leave();
});

test('a join answered "busy" is tried again after 1, 2 and 4 seconds before it fails', async () => {
    const session = await join({password: 'secret-1'});
    let socket = lastSocket();
    for (const delay of [1000, 2000, 4000]) {
        socket.opens();
        socket.receives({t: 'error', code: 'busy', message: BUSY});
        // Still "Connecting…", and nothing more from that connection is used.
        assert.equal(getState().status, 'connecting');
        assert.equal(getState().error, null);
        assert.equal(socket.onmessage, null);
        assert.deepEqual(socket.closeArgs, []);
        // (The server closes it too.)
        socket.closes();
        mock.timers.tick(delay - 1);
        assert.equal(lastSocket(), socket);
        mock.timers.tick(1);
        assert.notEqual(lastSocket(), socket);
        socket = lastSocket();
    }
    socket.opens();
    // The same hello each time.
    assert.equal(socket.sent[0].password, 'secret-1');
    assert.equal(socket.sent[0].expectLocked, true);
    socket.receives({t: 'error', code: 'busy', message: BUSY});
    assert.equal(getState().status, 'error');
    assert.equal(getState().error, BUSY);
    assert.equal(getState().errorCode, 'busy');
    mock.timers.tick(60000);
    assert.equal(FakeWebSocket.created.length, 4);

    // A new join gets its own retries.
    session.join({serverUrl: SERVER, room: 'room-1', name: 'Alex'});
    await settle();
    lastSocket().opens();
    lastSocket().receives({t: 'error', code: 'busy', message: BUSY});
    assert.equal(getState().status, 'connecting');
    session.leave();
});

test('after "busy" the join can still get in, and Cancel stops the retries', async () => {
    let session = await join();
    lastSocket().opens();
    lastSocket().receives({t: 'error', code: 'busy', message: BUSY});
    mock.timers.tick(1000);
    assert.equal(FakeWebSocket.created.length, 2);
    lastSocket().opens();
    welcome(lastSocket());
    assert.equal(getState().status, 'syncing');
    session.leave();

    FakeWebSocket.created = [];
    session = await join();
    lastSocket().opens();
    lastSocket().receives({t: 'error', code: 'busy', message: BUSY});
    // Cancel, in the "Connecting…" box.
    session.leave();
    mock.timers.tick(60000);
    assert.equal(FakeWebSocket.created.length, 1);
    assert.equal(getState().status, 'idle');
});

test('"busy" while reconnecting still just reconnects', async () => {
    const session = await join();
    let socket = lastSocket();
    socket.opens();
    welcome(socket);
    await goLive(socket);
    socket = reconnect(socket);
    socket.receives({t: 'error', code: 'busy', message: BUSY});
    assert.equal(getState().status, 'reconnecting');
    socket.closes();
    assert.equal(getState().status, 'reconnecting');
    assert.ok(toastTexts().includes(`${BUSY} Reconnecting…`));
    session.leave();
});
