'use strict';

const {test, before, after} = require('node:test');
const assert = require('node:assert');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The first start picks a free port; restarts reuse it.
let PORT = 0;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-collab-'));
let serverProcess;

const startServer = () => new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, SNAPSHOT_IDLE_MS: '200'},
        stdio: ['ignore', 'pipe', 'inherit']
    });
    serverProcess.stdout.on('data', chunk => {
        const listening = /listening on ws:\/\/[^:]+:(\d+)/.exec(chunk.toString());
        if (listening) {
            PORT = Number(listening[1]);
            resolve();
        }
    });
    serverProcess.on('error', reject);
});

const stopServer = () => new Promise(resolve => {
    serverProcess.once('exit', resolve);
    serverProcess.kill('SIGINT');
});

class TestClient {
    constructor (room, name) {
        this.messages = [];
        this.waiters = [];
        this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        this.ws.addEventListener('message', e => {
            const message = JSON.parse(e.data);
            this.messages.push(message);
            this.waiters = this.waiters.filter(w => {
                if (w.match(message)) {
                    w.resolve(message);
                    return false;
                }
                return true;
            });
        });
        this.opened = new Promise(resolve => this.ws.addEventListener('open', resolve));
        this.opened.then(() => this.send({t: 'hello', protocol: 1, room, name}));
    }
    send (message) {
        this.ws.send(JSON.stringify(message));
    }
    next (type, predicate = () => true) {
        const existing = this.messages.find(m => m.t === type && predicate(m) && !m._seen);
        if (existing) {
            existing._seen = true;
            return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000);
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
    close () {
        this.ws.close();
    }
}

/** Uploaded projects must look like .sb3 files (zip files start with "PK"). */
const ZIP_START = 'PK\u0003\u0004';
const fakeSb3 = text => Buffer.from(ZIP_START + text).toString('base64');
const projectText = base64 => Buffer.from(base64, 'base64').toString()
    .slice(ZIP_START.length);

before(startServer);
after(async () => {
    await stopServer();
    fs.rmSync(DATA_DIR, {recursive: true, force: true});
});

test('first person provides the project, second person receives it and edits flow both ways', async () => {
    const alice = new TestClient('demo-room', 'Alice');
    const welcomeA = await alice.next('welcome');
    assert.strictEqual(welcomeA.peers.length, 0);
    assert.strictEqual(welcomeA.hasProject, false);
    const need = await alice.next('need-snapshot');
    assert.strictEqual(need.seq, 0);

    const project = Buffer.from('PK\u0003\u0004pretend this is an sb3 file');
    alice.send({t: 'snapshot', seq: 0, data: project.toString('base64')});

    alice.send({t: 'op', ref: 1, op: {kind: 'blocks', event: {type: 'create', blockId: 'a'}}});
    const ack = await alice.next('ack');
    assert.strictEqual(ack.seq, 1);
    assert.strictEqual(ack.ref, 1);

    const bob = new TestClient('demo-room', 'Bob');
    const welcomeB = await bob.next('welcome');
    assert.strictEqual(welcomeB.peers.length, 1);
    assert.strictEqual(welcomeB.peers[0].name, 'Alice');
    const join = await alice.next('peer-join');
    assert.strictEqual(join.peer.name, 'Bob');

    const snapshot = await bob.next('snapshot');
    assert.strictEqual(Buffer.from(snapshot.data, 'base64').toString(), project.toString());
    const replayed = await bob.next('op');
    assert.strictEqual(replayed.seq, 1);
    assert.strictEqual(replayed.op.event.blockId, 'a');
    await bob.next('caught-up');

    bob.send({t: 'op', ref: 7, op: {kind: 'renameSprite', from: 'Sprite1', to: 'Cat'}});
    const fromBob = await alice.next('op', m => m.seq === 2);
    assert.strictEqual(fromBob.op.to, 'Cat');
    assert.strictEqual(fromBob.from, welcomeB.id);

    bob.send({t: 'presence', presence: {target: 'Cat'}});
    const presence = await alice.next('presence');
    assert.strictEqual(presence.presence.target, 'Cat');

    alice.send({t: 'chat', text: 'hi bob'});
    const chat = await bob.next('chat');
    assert.strictEqual(chat.text, 'hi bob');
    assert.strictEqual(chat.name, 'Alice');

    // After a quiet moment the oldest person is asked for a fresh snapshot.
    await alice.next('request-snapshot');
    alice.send({t: 'snapshot', seq: 2, data: fakeSb3('newer project')});

    bob.close();
    await alice.next('peer-leave');
    alice.close();
    await new Promise(resolve => setTimeout(resolve, 200));

    // The room was saved to disk and is restored for the next visitor.
    const carol = new TestClient('demo-room', 'Carol');
    const snapshotC = await carol.next('snapshot');
    assert.strictEqual(projectText(snapshotC.data), 'newer project');
    assert.strictEqual(snapshotC.seq, 2);
    const caughtUp = await carol.next('caught-up');
    assert.strictEqual(caughtUp.seq, 2);
    carol.close();
});

test('people who join while the first project is uploading get it once it arrives', async () => {
    const dana = new TestClient('upload-race', 'Dana');
    await dana.next('need-snapshot');
    const erin = new TestClient('upload-race', 'Erin');
    await erin.next('welcome');
    dana.send({t: 'snapshot', seq: 0, data: fakeSb3('dana project')});
    const snapshot = await erin.next('snapshot');
    assert.strictEqual(projectText(snapshot.data), 'dana project');
    dana.close();
    erin.close();
});

test('if the room creator leaves before uploading, the next person provides the project', async () => {
    const fay = new TestClient('creator-left', 'Fay');
    await fay.next('need-snapshot');
    const gus = new TestClient('creator-left', 'Gus');
    await gus.next('welcome');
    fay.close();
    await gus.next('need-snapshot');
    gus.close();
});

test('bad room codes and old editors are turned away', async () => {
    const bad = new TestClient('../etc/passwd', 'Mallory');
    const error = await bad.next('error');
    assert.strictEqual(error.code, 'bad-room');
});

test('after a snapshot, everyone else is told its fingerprint so they can self-check', async () => {
    const hana = new TestClient('checkpoint-room', 'Hana');
    await hana.next('need-snapshot');
    hana.send({t: 'snapshot', seq: 0, hash: 'first', data: fakeSb3('v1')});
    const ivan = new TestClient('checkpoint-room', 'Ivan');
    await ivan.next('caught-up');
    ivan.send({t: 'op', ref: 1, op: {kind: 'blocks'}});
    await ivan.next('ack');
    await hana.next('request-snapshot');
    hana.send({t: 'snapshot', seq: 1, hash: 'abc123', data: fakeSb3('v2')});
    const checkpoint = await ivan.next('checkpoint');
    assert.strictEqual(checkpoint.seq, 1);
    assert.strictEqual(checkpoint.hash, 'abc123');
    // Presence is reduced to just a sprite name
    ivan.send({t: 'presence', presence: {target: 'Cat', evil: {nested: true}}});
    const presence = await hana.next('presence');
    assert.deepStrictEqual(presence.presence, {target: 'Cat'});
    hana.close();
    ivan.close();
});

const helloClient = (room, name, extra) => {
    const client = Object.create(TestClient.prototype);
    client.messages = [];
    client.waiters = [];
    client.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    client.ws.addEventListener('message', e => {
        const message = JSON.parse(e.data);
        client.messages.push(message);
        client.waiters = client.waiters.filter(w => {
            if (w.match(message)) {
                w.resolve(message);
                return false;
            }
            return true;
        });
    });
    client.ws.addEventListener('open', () => client.send({t: 'hello', protocol: 1, room, name, ...extra}));
    return client;
};

const roomList = async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/rooms`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('access-control-allow-origin'), '*');
    return (await response.json()).rooms;
};

const waitFor = async (check, what) => {
    for (let i = 0; i < 40; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
};

test('room list: listed rooms show up with their title and people, private ones never do', async () => {
    const jo = helloClient('listed-room', 'Jo', {listed: true, title: '  My\u0007 Game  '});
    const welcome = await jo.next('welcome');
    assert.strictEqual(welcome.listed, true);
    assert.strictEqual(welcome.title, 'My Game');
    await jo.next('need-snapshot');
    // Not shown until the project is uploaded (nobody could join it yet).
    assert.ok(!(await roomList()).some(r => r.room === 'listed-room'));
    jo.send({t: 'snapshot', seq: 0, data: fakeSb3('jo project')});
    await waitFor(async () => (await roomList()).some(r => r.room === 'listed-room'), 'the listed room');

    const kim = helloClient('secret-room', 'Kim', {listed: false, title: 'Secret'});
    await kim.next('need-snapshot');
    kim.send({t: 'snapshot', seq: 0, data: fakeSb3('kim project')});
    const lee = helloClient('no-choice-room', 'Lee', {});
    await lee.next('need-snapshot');
    lee.send({t: 'snapshot', seq: 0, data: fakeSb3('lee project')});

    // Someone joins the listed room. Their own "listed: false" doesn't change it.
    const max = helloClient('listed-room', 'Max', {listed: false, title: 'Other title'});
    const maxWelcome = await max.next('welcome');
    assert.strictEqual(maxWelcome.listed, true);
    await max.next('caught-up');

    await new Promise(resolve => setTimeout(resolve, 100));
    const rooms = await roomList();
    assert.deepStrictEqual(rooms.find(r => r.room === 'listed-room'),
        {room: 'listed-room', title: 'My Game', locked: false, people: 2, names: ['Jo', 'Max']});
    assert.ok(!rooms.some(r => r.room === 'secret-room'), 'a private room is never listed');
    assert.ok(!rooms.some(r => r.room === 'no-choice-room'), 'rooms are private unless chosen');

    // Other methods are refused.
    const post = await fetch(`http://127.0.0.1:${PORT}/rooms`, {method: 'POST'});
    assert.strictEqual(post.status, 405);

    jo.close();
    max.close();
    kim.close();
    lee.close();
    await waitFor(async () => !(await roomList()).some(r => r.room === 'listed-room'), 'the empty room to leave the list');
});

test('room list: anyone in a room can list it or make it private, and it is remembered', async () => {
    const nia = helloClient('toggle-room', 'Nia', {listed: false, title: 'Toggle'});
    await nia.next('need-snapshot');
    nia.send({t: 'snapshot', seq: 0, data: fakeSb3('nia project')});
    const oz = helloClient('toggle-room', 'Oz', {});
    const ozWelcome = await oz.next('welcome');
    await oz.next('caught-up');
    assert.ok(!(await roomList()).some(r => r.room === 'toggle-room'));

    // Bad values are ignored.
    oz.send({t: 'room-settings', listed: 'yes'});
    oz.send({t: 'room-settings', listed: true});
    const infoNia = await nia.next('room-info');
    const infoOz = await oz.next('room-info');
    assert.strictEqual(infoNia.listed, true);
    assert.strictEqual(infoNia.by, ozWelcome.id);
    assert.strictEqual(infoOz.listed, true);
    assert.ok((await roomList()).some(r => r.room === 'toggle-room'));

    // Everyone leaves; the choice is saved with the room.
    nia.close();
    oz.close();
    await waitFor(async () => !(await roomList()).some(r => r.room === 'toggle-room'), 'the empty room to leave the list');
    const pia = helloClient('toggle-room', 'Pia', {listed: false});
    const piaWelcome = await pia.next('welcome');
    assert.strictEqual(piaWelcome.listed, true);
    assert.strictEqual(piaWelcome.title, 'Toggle');
    await pia.next('caught-up');
    await waitFor(async () => (await roomList()).some(r => r.room === 'toggle-room'), 'the room to be listed again');

    pia.send({t: 'room-settings', listed: false});
    const off = await pia.next('room-info');
    assert.strictEqual(off.listed, false);
    assert.ok(!(await roomList()).some(r => r.room === 'toggle-room'));
    pia.close();
});
