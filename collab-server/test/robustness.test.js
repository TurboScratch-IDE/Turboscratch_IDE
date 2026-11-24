'use strict';

/**
 * The collaboration server must survive anything one person can send, keep
 * other rooms working, and never lose or corrupt a room's saved project.
 */

const {test, after} = require('node:test');
const assert = require('node:assert');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ZIP_START = 'PK\u0003\u0004';
const fakeSb3 = text => Buffer.from(ZIP_START + text).toString('base64');
const projectText = base64 => Buffer.from(base64, 'base64').toString()
    .slice(ZIP_START.length);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const servers = [];

/** Starts a server of its own (own free port and data folder) with extra settings. */
const startServer = async (env = {}) => {
    let port = 0;
    const dataDir = env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-robust-'));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, SNAPSHOT_IDLE_MS: '200', ...env},
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => {
        output += chunk;
    });
    child.stderr.on('data', chunk => {
        output += chunk;
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10000);
        child.stdout.on('data', () => {
            const listening = /listening on ws:\/\/[^:]+:(\d+)/.exec(output);
            if (listening) {
                port = Number(listening[1]);
                clearTimeout(timer);
                resolve();
            }
        });
        child.on('exit', code => reject(new Error(`server exited (${code}):\n${output}`)));
    });
    const server = {
        port,
        dataDir,
        child,
        output: () => output,
        alive: () => child.exitCode === null && child.signalCode === null,
        health: async () => (await fetch(`http://127.0.0.1:${port}/health`)).json(),
        stop: () => new Promise(resolve => {
            if (!server.alive()) return resolve();
            child.once('exit', resolve);
            child.kill('SIGINT');
        }),
        crash: () => new Promise(resolve => {
            child.once('exit', resolve);
            child.kill('SIGKILL');
        })
    };
    servers.push(server);
    return server;
};

after(async () => {
    for (const server of servers) {
        await server.stop();
        fs.rmSync(server.dataDir, {recursive: true, force: true});
    }
});

const WebSocketClient = require('ws');

class Client {
    constructor (server, room, name, extra = {}, origin) {
        this.messages = [];
        this.waiters = [];
        this.closed = new Promise(resolve => {
            this.resolveClosed = resolve;
        });
        this.ws = new WebSocketClient(`ws://127.0.0.1:${server.port}`, origin ? {origin} : {});
        this.ws.on('message', data => {
            const message = JSON.parse(data.toString());
            this.messages.push(message);
            this.waiters = this.waiters.filter(w => {
                if (w.match(message)) {
                    w.resolve(message);
                    return false;
                }
                return true;
            });
        });
        this.ws.on('close', code => this.resolveClosed(code));
        this.ws.on('error', () => {});
        this.opened = new Promise(resolve => this.ws.on('open', resolve));
        if (room) this.opened.then(() => this.send({t: 'hello', protocol: 1, room, name, ...extra}));
    }
    send (message) {
        this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
    next (type, predicate = () => true, timeout = 3000) {
        const existing = this.messages.find(m => m.t === type && predicate(m) && !m._seen);
        if (existing) {
            existing._seen = true;
            return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeout);
            this.waiters.push({
                match: m => m.t === type && predicate(m),
                resolve: m => {
                    clearTimeout(timer);
                    m._seen = true;
                    resolve(m);
                }
            });
        });
    }
    count (type) {
        return this.messages.filter(m => m.t === type).length;
    }
    close () {
        this.ws.close();
    }
    /** Cuts the connection without a goodbye, like Wi-Fi dropping. */
    drop () {
        this.ws.terminate();
    }
}

/** A room with a project, ready for edits. */
const openRoom = async (server, room, name = 'Owner', text = 'project') => {
    const owner = new Client(server, room, name);
    await owner.next('need-snapshot');
    owner.send({t: 'snapshot', seq: 0, data: fakeSb3(text)});
    await sleep(50);
    return owner;
};

/** Sends raw bytes as a WebSocket frame-level attack (no WebSocket library). */
const rawSocket = (port, origin) => new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
            `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
            `${origin ? `Origin: ${origin}\r\n` : ''}\r\n`
        );
    });
    socket.once('data', () => resolve(socket));
    socket.on('error', () => {});
});

test('one deeply nested message or ref only closes that connection; the server and other rooms keep going', async () => {
    const server = await startServer();
    const bystander = await openRoom(server, 'bystander-room', 'Bystander');
    const attacker = await openRoom(server, 'attack-room', 'Attacker');

    const deep = `{"t":"op","op":${'{"a":'.repeat(20000)}1${'}'.repeat(20000)}}`;
    attacker.send(deep);
    const error = await attacker.next('error');
    assert.strictEqual(error.code, 'bad-op');
    await attacker.closed;

    const sneaky = await openRoom(server, 'attack-room-2', 'Sneaky');
    sneaky.send(`{"t":"op","op":{"kind":"x"},"ref":${'['.repeat(20000)}${']'.repeat(20000)}}`);
    const ack = await sneaky.next('ack');
    assert.strictEqual(ack.ref, null);

    assert.ok(server.alive(), server.output());
    bystander.send({t: 'op', ref: 1, op: {kind: 'blocks'}});
    assert.strictEqual((await bystander.next('ack')).seq, 1);
    bystander.close();
    sneaky.close();
});

test('with ALLOWED_ORIGINS, broken frames from a refused website do not crash the server', async () => {
    const server = await startServer({ALLOWED_ORIGINS: 'https://turboscratch-ide.github.io'});
    for (const frame of [
        Buffer.from([0x83, 0x80, 0, 0, 0, 0]), // reserved opcode
        Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]), // not masked
        Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff, 0, 0, 0, 0]) // giant length
    ]) {
        const socket = await rawSocket(server.port, 'https://evil.example');
        socket.write(frame);
        await sleep(150);
        socket.destroy();
    }
    await sleep(200);
    assert.ok(server.alive(), server.output());
    const allowed = new Client(server, 'fine-room', 'Fine', {}, 'https://turboscratch-ide.github.io');
    await allowed.next('welcome');
    allowed.close();
});

test('repeated resync requests are answered at most every few seconds', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'resync-room', 'Owner', 'x'.repeat(100000));
    const greedy = new Client(server, 'resync-room', 'Greedy');
    await greedy.next('caught-up');
    const before = greedy.count('snapshot');
    for (let i = 0; i < 50; i++) greedy.send({t: 'resync'});
    await sleep(1500);
    // The first request may be answered right away; the rest wait.
    assert.ok(greedy.count('snapshot') - before <= 1, `got ${greedy.count('snapshot') - before} snapshots`);
    owner.close();
    greedy.close();
});

test('a room whose project is never saved stops taking edits instead of growing forever', async () => {
    const server = await startServer({MAX_OP_LOG_OPS: '500'});
    const owner = await openRoom(server, 'hoard-room', 'Hoarder');
    // The owner ignores every request for a snapshot and keeps editing.
    for (let i = 0; i < 600; i++) owner.send({t: 'op', ref: i, op: {kind: 'blocks', n: i}});
    const error = await owner.next('error', m => m.code === 'too-many-edits', 10000);
    assert.ok(error);
    await owner.closed;
    assert.ok(server.alive());
});

test('empty or non-project snapshots are refused, and the server asks again', async () => {
    const server = await startServer();
    const owner = new Client(server, 'empty-room', 'Owner');
    await owner.next('need-snapshot');
    owner.send({t: 'snapshot', seq: null, data: ''});
    assert.strictEqual((await owner.next('error')).code, 'bad-snapshot');
    owner.send({t: 'snapshot', seq: 0, data: Buffer.from('not a zip').toString('base64')});
    assert.strictEqual((await owner.next('error')).code, 'bad-snapshot');
    owner.send({t: 'snapshot', seq: 0, data: fakeSb3('real one')});
    owner.send({t: 'op', ref: 1, op: {kind: 'blocks'}});
    await owner.next('ack');
    await owner.next('request-snapshot');
    owner.send({t: 'snapshot', seq: 1, data: ''});
    await owner.next('error');
    // A refused snapshot is asked for again, without waiting for another edit.
    await owner.next('request-snapshot', () => true, 3000);
    owner.close();
});

test('a colour someone already has is not handed out again', async () => {
    const server = await startServer();
    const red = new Client(server, 'colour-room', 'Red', {color: '#ff6b6b'});
    assert.strictEqual((await red.next('welcome')).color, '#ff6b6b');
    const copycat = new Client(server, 'colour-room', 'Copycat', {color: '#FF6B6B'});
    const welcome = await copycat.next('welcome');
    assert.notStrictEqual(welcome.color.toLowerCase(), '#ff6b6b');
    red.close();
    copycat.close();
});

test('names: invisible characters and text-direction tricks are removed; emoji are never cut in half', async () => {
    const server = await startServer();
    const ghost = new Client(server, 'name-room', '​​​');
    assert.strictEqual((await ghost.next('welcome')).id.length > 0, true);
    const rtl = new Client(server, 'name-room', '‮ecilA');
    await rtl.next('welcome');
    const join = await ghost.next('peer-join');
    assert.strictEqual(join.peer.name, 'ecilA');
    const emoji = new Client(server, 'name-room', `${'a'.repeat(23)}😀`);
    const emojiJoin = await ghost.next('peer-join', m => m.peer.name.startsWith('aaa'));
    assert.strictEqual(emojiJoin.peer.name, 'a'.repeat(23));
    const peersSeenByRtl = rtl.messages.find(m => m.t === 'welcome').peers;
    assert.strictEqual(peersSeenByRtl[0].name, 'Guest');
    ghost.close();
    rtl.close();
    emoji.close();
});

test('a connection that never says which room it wants is closed', async () => {
    const server = await startServer({HELLO_TIMEOUT_MS: '300'});
    const silent = new Client(server, null, null);
    await silent.opened;
    const code = await Promise.race([silent.closed, sleep(3000).then(() => 'still open')]);
    assert.notStrictEqual(code, 'still open');
});

test('a room creator whose connection drops before the project arrives gets their place back', async () => {
    const server = await startServer({CREATOR_GRACE_MS: '2000'});
    const creator = new Client(server, 'grace-room', 'Creator');
    const welcome = await creator.next('welcome');
    await creator.next('need-snapshot');
    const friend = new Client(server, 'grace-room', 'Friend');
    await friend.next('welcome');
    // The creator's Wi-Fi drops (no close handshake).
    creator.drop();
    await friend.next('peer-leave');
    await sleep(300);
    assert.strictEqual(friend.count('need-snapshot'), 0, 'the friend must not be asked yet');

    const back = new Client(server, 'grace-room', 'Creator', {resume: welcome.resume});
    await back.next('need-snapshot');
    back.send({t: 'snapshot', seq: 0, data: fakeSb3('creator project')});
    const snapshot = await friend.next('snapshot');
    assert.strictEqual(projectText(snapshot.data), 'creator project');
    assert.strictEqual(friend.count('need-snapshot'), 0);
    back.close();
    friend.close();
});

test('if the creator does not come back in time, the next person provides the project', async () => {
    const server = await startServer({CREATOR_GRACE_MS: '300'});
    const creator = new Client(server, 'grace-room-2', 'Creator');
    await creator.next('need-snapshot');
    const friend = new Client(server, 'grace-room-2', 'Friend');
    await friend.next('welcome');
    creator.drop();
    await friend.next('need-snapshot', () => true, 3000);
    friend.close();
});

test('people waiting for a new room\'s first project are told if it never comes', async () => {
    const server = await startServer({FIRST_SNAPSHOT_TIMEOUT_MS: '400'});
    const creator = new Client(server, 'stuck-room', 'Creator');
    await creator.next('need-snapshot');
    const friend = new Client(server, 'stuck-room', 'Friend');
    await friend.next('welcome');
    const error = await friend.next('error', () => true, 3000);
    assert.strictEqual(error.code, 'no-project');
    creator.close();
});

test('a server that is full refuses new rooms but keeps existing ones working', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-robust-'));
    const first = await startServer({DATA_DIR: dataDir});
    const owner = await openRoom(first, 'kept-room', 'Owner', 'y'.repeat(5000));
    owner.close();
    await sleep(300);
    await first.stop();

    const server = await startServer({DATA_DIR: dataDir, MAX_ROOM_STORAGE_MB: '0.001'});
    const newcomer = new Client(server, 'new-room', 'New');
    assert.strictEqual((await newcomer.next('error')).code, 'server-full');
    const returning = new Client(server, 'kept-room', 'Back');
    await returning.next('caught-up');
    returning.close();
    assert.strictEqual((await server.health()).rooms <= 1, true);
});

test('joining and leaving an unchanged room does not rewrite its project file', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'still-room', 'Owner', 'z'.repeat(10000));
    owner.close();
    await sleep(300);
    const sb3 = fs.readdirSync(server.dataDir).find(name => name.startsWith('still-room.') && name.endsWith('.sb3'));
    const before = fs.statSync(path.join(server.dataDir, sb3)).mtimeMs;
    for (let i = 0; i < 5; i++) {
        const visitor = new Client(server, 'still-room', 'Visitor');
        await visitor.next('caught-up');
        visitor.close();
        await visitor.closed;
        await sleep(50);
    }
    await sleep(300);
    assert.strictEqual(fs.statSync(path.join(server.dataDir, sb3)).mtimeMs, before);
});

test('edits are saved within a moment, and survive a crash', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'crash-room', 'Owner');
    owner.send({t: 'op', ref: 1, op: {kind: 'blocks', n: 1}});
    owner.send({t: 'op', ref: 2, op: {kind: 'blocks', n: 2}});
    await owner.next('ack', m => m.seq === 2);
    await sleep(600);
    await server.crash();
    const again = await startServer({DATA_DIR: server.dataDir});
    const visitor = new Client(again, 'crash-room', 'Visitor');
    await visitor.next('caught-up');
    const ops = visitor.messages.filter(m => m.t === 'op').map(m => m.op.n);
    assert.deepStrictEqual(ops, [1, 2]);
    visitor.close();
});

test('a person whose editor reconnects before their old connection is noticed keeps their place and colour', async () => {
    const server = await startServer();
    const ann = await openRoom(server, 'zombie-room', 'Ann');
    const annWelcome = ann.messages.find(m => m.t === 'welcome');
    const bob = new Client(server, 'zombie-room', 'Bob');
    await bob.next('caught-up');
    // Ann's Wi-Fi changed: her editor connects again, the old connection is still open here.
    const again = new Client(server, 'zombie-room', 'Ann', {color: annWelcome.color, resume: annWelcome.resume});
    const welcome = await again.next('welcome');
    assert.strictEqual(welcome.color, annWelcome.color);
    assert.deepStrictEqual(welcome.peers.map(p => p.name), ['Bob']);
    const left = await bob.next('peer-leave');
    assert.strictEqual(left.id, annWelcome.id);
    const joined = await bob.next('peer-join');
    assert.strictEqual(joined.peer.color, annWelcome.color);
    await ann.closed;
    // A wrong token is just a new person.
    const stranger = new Client(server, 'zombie-room', 'Ann', {color: annWelcome.color, resume: 'nope'});
    assert.notStrictEqual((await stranger.next('welcome')).color, annWelcome.color);
    again.close();
    bob.close();
    stranger.close();
});

test('a room creator reconnecting before their old connection is noticed still provides the project', async () => {
    const server = await startServer({CREATOR_GRACE_MS: '300'});
    const creator = new Client(server, 'zombie-creator', 'Creator');
    const welcome = await creator.next('welcome');
    await creator.next('need-snapshot');
    const friend = new Client(server, 'zombie-creator', 'Friend');
    await friend.next('welcome');
    const back = new Client(server, 'zombie-creator', 'Creator', {resume: welcome.resume});
    await back.next('need-snapshot');
    await creator.closed;
    await sleep(600);
    assert.strictEqual(friend.count('need-snapshot'), 0, 'the friend must not be asked');
    back.send({t: 'snapshot', seq: 0, data: fakeSb3('creator project')});
    assert.strictEqual(projectText((await friend.next('snapshot')).data), 'creator project');
    back.close();
    friend.close();
});

test('nothing more is used from a connection after one of its edits was refused', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'refused-room', 'Owner');
    const watcher = new Client(server, 'refused-room', 'Watcher');
    await watcher.next('caught-up');
    owner.send(`{"t":"op","op":${'['.repeat(200)}${']'.repeat(200)}}`);
    owner.send({t: 'op', ref: 1, op: {kind: 'blocks', after: 'refused'}});
    owner.send({t: 'chat', text: 'still here?'});
    assert.strictEqual((await owner.next('error')).code, 'bad-op');
    await owner.closed;
    await sleep(200);
    assert.strictEqual(watcher.count('op'), 0);
    assert.strictEqual(watcher.count('chat'), 0);
    watcher.close();
});

test('one big edit fits even when it is bigger than the edit list allows; a full list refuses the next one', async () => {
    const server = await startServer({MAX_OP_LOG_MB: '1'});
    const owner = await openRoom(server, 'big-op-room', 'Owner');
    owner.send({t: 'op', ref: 1, op: {kind: 'project', sb3: 'x'.repeat(1.5 * 1024 * 1024)}});
    assert.strictEqual((await owner.next('ack', () => true, 5000)).seq, 1);
    owner.send({t: 'op', ref: 2, op: {kind: 'blocks'}});
    assert.strictEqual((await owner.next('error')).code, 'too-many-edits');
    await owner.closed;
});

test('after a full edit list, the person coming back is asked for the project right away', async () => {
    const server = await startServer({MAX_OP_LOG_OPS: '50'});
    const owner = await openRoom(server, 'full-room', 'Owner');
    // The owner keeps editing and never answers a request for the project.
    for (let i = 0; i < 60; i++) owner.send({t: 'op', ref: i, op: {kind: 'blocks', n: i}});
    assert.strictEqual((await owner.next('error', () => true, 5000)).code, 'too-many-edits');
    await owner.closed;
    // Their editor reconnects: it is asked for the project as soon as it has caught up.
    const back = new Client(server, 'full-room', 'Owner');
    await back.next('caught-up');
    assert.ok(await back.next('request-snapshot', () => true, 3000));
    back.send({t: 'snapshot', seq: 50, data: fakeSb3('saved')});
    await sleep(100);
    back.send({t: 'op', ref: 1, op: {kind: 'blocks'}});
    assert.strictEqual((await back.next('ack')).seq, 51);
    back.close();
});

test('people waiting for a new room are not turned away while its project is still arriving', async () => {
    const server = await startServer({FIRST_SNAPSHOT_TIMEOUT_MS: '1000'});
    const creator = new Client(server, 'slow-room', 'Creator');
    await creator.next('need-snapshot');
    const friend = new Client(server, 'slow-room', 'Friend');
    await friend.next('welcome');
    // A slow upload: one message, sent in pieces over about 3 seconds.
    const message = Buffer.from(JSON.stringify({t: 'snapshot', seq: 0, data: fakeSb3('slow '.repeat(60000))}));
    const pieces = 8;
    const size = Math.ceil(message.length / pieces);
    for (let i = 0; i < pieces; i++) {
        const last = i === pieces - 1;
        await new Promise(resolve => creator.ws.send(message.subarray(i * size, (i + 1) * size), {binary: false, fin: last}, resolve));
        if (!last) await sleep(400);
    }
    const snapshot = await friend.next('snapshot', () => true, 3000);
    assert.ok(projectText(snapshot.data).startsWith('slow slow'));
    assert.strictEqual(friend.count('error'), 0);
    creator.close();
    friend.close();
});

test('names and chats that would show nothing are replaced or dropped; emoji joiners are kept', async () => {
    const server = await startServer();
    const watcher = await openRoom(server, 'blank-room', 'Watcher');
    const names = {};
    const people = [];
    for (const [key, name] of Object.entries({
        filler: 'ㅤ',
        braille: '⠀⠀',
        padded: 'Hostㅤ',
        coder: 'Sam \u{1F469}‍\u{1F4BB}',
        persian: 'می‌را',
        heart: 'Love ❤️'
    })) {
        const client = new Client(server, 'blank-room', name);
        people.push(client);
        names[key] = (await client.next('welcome')).name;
        if (key === 'filler') {
            await client.next('caught-up');
            client.send({t: 'chat', text: '​​'});
            client.send({t: 'chat', text: '‍‌'});
            client.send({t: 'chat', text: 'hi'});
        }
    }
    assert.deepStrictEqual(names, {
        filler: 'Guest',
        braille: 'Guest',
        padded: 'Host',
        coder: 'Sam \u{1F469}‍\u{1F4BB}',
        persian: 'می‌را',
        heart: 'Love ❤️'
    });
    const chat = await watcher.next('chat');
    assert.strictEqual(chat.text, 'hi');
    await sleep(100);
    assert.strictEqual(watcher.count('chat'), 1);
    watcher.close();
    for (const client of people) client.close();
});

test('a room whose files cannot be read right now is refused, not replaced', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'locked-room', 'Owner', 'precious');
    owner.close();
    await owner.closed;
    await server.stop();
    // Make the settings file unreadable (like "too many open files").
    const json = path.join(server.dataDir, 'locked-room.json');
    fs.renameSync(json, `${json}.real`);
    fs.mkdirSync(json);
    const again = await startServer({DATA_DIR: server.dataDir});
    const visitor = new Client(again, 'locked-room', 'Visitor');
    assert.strictEqual((await visitor.next('error')).code, 'busy');
    assert.strictEqual(visitor.count('need-snapshot'), 0);
    await visitor.closed;
    // Readable again: the room is still there, with its project.
    fs.rmdirSync(json);
    fs.renameSync(`${json}.real`, json);
    const later = new Client(again, 'locked-room', 'Later');
    assert.strictEqual(projectText((await later.next('snapshot')).data), 'precious');
    later.close();
    assert.ok(!fs.readdirSync(server.dataDir).some(name => name.includes('damaged')));
});

test('edits saved after a crash cut off the last saved edit are not lost', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'torn-room', 'Owner');
    owner.send({t: 'op', ref: 1, op: {kind: 'blocks', n: 1}});
    await owner.next('ack');
    await sleep(400);
    await server.crash();
    // The crash happened in the middle of writing edit 2.
    fs.appendFileSync(path.join(server.dataDir, 'torn-room.ops'), '{"seq":2,"from":"x","op":{"ki');
    const second = await startServer({DATA_DIR: server.dataDir});
    const editor = new Client(second, 'torn-room', 'Editor');
    await editor.next('caught-up');
    editor.send({t: 'op', ref: 1, op: {kind: 'blocks', n: 2}});
    editor.send({t: 'op', ref: 2, op: {kind: 'blocks', n: 3}});
    await editor.next('ack', m => m.seq === 3);
    editor.close();
    await editor.closed;
    await second.stop();
    const third = await startServer({DATA_DIR: server.dataDir});
    const visitor = new Client(third, 'torn-room', 'Visitor');
    await visitor.next('caught-up');
    assert.deepStrictEqual(visitor.messages.filter(m => m.t === 'op').map(m => m.op.n), [1, 2, 3]);
    visitor.close();
});

test('opening a room counts as using it, so it is not deleted as unused', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'visited-room', 'Owner');
    owner.close();
    await owner.closed;
    await server.stop();
    const tenDaysAgo = (Date.now() - (10 * 24 * 60 * 60 * 1000)) / 1000;
    for (const name of fs.readdirSync(server.dataDir)) {
        if (name.startsWith('visited-room')) fs.utimesSync(path.join(server.dataDir, name), tenDaysAgo, tenDaysAgo);
    }
    const again = await startServer({DATA_DIR: server.dataDir, ROOM_EXPIRE_DAYS: '30'});
    const visitor = new Client(again, 'visited-room', 'Visitor');
    await visitor.next('caught-up');
    visitor.close();
    const age = Date.now() - fs.statSync(path.join(server.dataDir, 'visited-room.json')).mtimeMs;
    assert.ok(age < 60000, `the room still looks ${Math.round(age / 86400000)} days old`);
});

test('a huge flat edit is checked quickly', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'wide-room', 'Owner');
    const started = Date.now();
    owner.send(`{"t":"op","ref":1,"op":{"kind":"blocks","a":[${'0,'.repeat(3000000)}0]}}`);
    await owner.next('ack', () => true, 10000);
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
    assert.ok(server.alive());
    owner.close();
});

test('many new rooms opened at the same moment cannot get past the storage limit', async () => {
    const server = await startServer({MAX_ROOM_STORAGE_MB: '0.05'});
    const creators = [];
    for (let i = 0; i < 6; i++) creators.push(new Client(server, `rush-${i}`, 'Rusher'));
    await Promise.all(creators.map(c => c.next('need-snapshot')));
    for (const c of creators) c.send({t: 'snapshot', seq: 0, data: fakeSb3('r'.repeat(20000))});
    await sleep(500);
    const refused = creators.filter(c => c.messages.some(m => m.t === 'error' && m.code === 'server-full')).length;
    assert.ok(refused >= 3, `only ${refused} of 6 were refused`);
    const saved = fs.readdirSync(server.dataDir).filter(name => /^rush-\d\.0\.sb3$/.test(name)).length;
    assert.strictEqual(saved, 6 - refused);
    for (const c of creators) c.close();
});
