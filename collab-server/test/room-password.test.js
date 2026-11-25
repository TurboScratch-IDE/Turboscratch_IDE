'use strict';

/**
 * Room passwords: only people who type a room's password get its project,
 * the password itself is never saved, logged or sent to anyone, guessing is
 * slowed down, and rooms without a password work exactly as before.
 */

const {test, after} = require('node:test');
const assert = require('node:assert');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocketClient = require('ws');

const ZIP_START = 'PK\u0003\u0004';
const fakeSb3 = text => Buffer.from(ZIP_START + text).toString('base64');
const projectText = base64 => Buffer.from(base64, 'base64').toString()
    .slice(ZIP_START.length);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Waits until `check()` is true (looked at every 20 ms). */
const waitFor = async (check, what, timeout = 5000) => {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
        await sleep(20);
    }
};

const servers = [];

/** Starts a server of its own (own free port and data folder) with extra settings. */
const startServer = async (env = {}) => {
    let port = 0;
    const dataDir = env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-password-'));
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
        roomList: async () => (await (await fetch(`http://127.0.0.1:${port}/rooms`)).json()).rooms,
        stop: () => new Promise(resolve => {
            if (!server.alive()) return resolve();
            child.once('exit', resolve);
            child.kill('SIGINT');
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

class Client {
    /**
     * @param {object} server from startServer
     * @param {?string} room sends a hello for this room once connected (null: no hello)
     * @param {string} name their name
     * @param {object} extra more hello fields (password, resume, listed, title...)
     * @param {object} headers HTTP headers for the connection (X-Forwarded-For...)
     */
    constructor (server, room, name, extra = {}, headers = {}) {
        this.messages = [];
        this.waiters = [];
        this.closed = new Promise(resolve => {
            this.resolveClosed = resolve;
        });
        this.ws = new WebSocketClient(`ws://127.0.0.1:${server.port}`, {headers});
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
        if (room) this.opened.then(() => this.hello(room, name, extra));
    }
    hello (room, name, extra = {}) {
        this.send({t: 'hello', protocol: 1, room, name, ...extra});
    }
    send (message) {
        this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
    /** The next message of one of these types (and matching `predicate`) not looked at yet. */
    next (types, predicate = () => true, timeout = 5000) {
        const match = m => [].concat(types).includes(m.t) && predicate(m);
        const existing = this.messages.find(m => match(m) && !m._seen);
        if (existing) {
            existing._seen = true;
            return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for ${types}`)), timeout);
            this.waiters.push({
                match,
                resolve: m => {
                    clearTimeout(timer);
                    m._seen = true;
                    resolve(m);
                }
            });
        });
    }
    /** What the server answered the hello with: 'welcome' or the error code. */
    async answer (timeout = 5000) {
        const message = await this.next(['welcome', 'error'], () => true, timeout);
        return message.t === 'welcome' ? 'welcome' : message.code;
    }
    welcome () {
        return this.messages.find(m => m.t === 'welcome');
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
const openRoom = async (server, room, name, extra = {}, text = 'project', headers = {}) => {
    const owner = new Client(server, room, name, extra, headers);
    await owner.next('need-snapshot');
    owner.send({t: 'snapshot', seq: 0, data: fakeSb3(text)});
    // Answered after the snapshot was handled.
    owner.send({t: 'ping'});
    await owner.next('pong');
    return owner;
};

/** The fields of a room-info message (and nothing else may be in it). */
const roomInfo = message => {
    assert.deepStrictEqual(Object.keys(message).filter(key => key !== '_seen')
        .sort(), ['by', 'changed', 'listed', 'locked', 't', 'title']);
    return {listed: message.listed, title: message.title, locked: message.locked, by: message.by, changed: message.changed};
};

test('a room created with a password lets in only people who type it', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'pw-room', 'Owner',
        {password: 'tiger-cake', listed: true, title: 'Secret base'}, 'owner project');
    assert.strictEqual(owner.welcome().locked, true);
    assert.strictEqual(owner.welcome().title, 'Secret base');

    // An older editor sends no password at all.
    const old = new Client(server, 'pw-room', 'Old');
    const refused = await old.next('error');
    assert.deepStrictEqual([refused.code, refused.message], ['password-needed', 'This room has a password. Type it to join.']);
    await old.closed;
    const empty = new Client(server, 'pw-room', 'Empty', {password: ''});
    assert.strictEqual(await empty.answer(), 'password-needed');
    const wrong = new Client(server, 'pw-room', 'Wrong', {password: 'tiger-cakes'});
    const wrongError = await wrong.next('error');
    assert.deepStrictEqual([wrongError.code, wrongError.message], ['wrong-password', 'Wrong password for this room.']);
    await wrong.closed;
    for (const refusedClient of [old, empty, wrong]) {
        assert.strictEqual(refusedClient.count('welcome') + refusedClient.count('snapshot'), 0);
    }

    const friend = new Client(server, 'pw-room', 'Friend', {password: 'tiger-cake'});
    assert.strictEqual(await friend.answer(), 'welcome');
    assert.strictEqual(friend.welcome().locked, true);
    assert.strictEqual(projectText((await friend.next('snapshot')).data), 'owner project');
    await friend.next('caught-up');
    assert.strictEqual((await owner.next('peer-join')).peer.name, 'Friend');
    assert.strictEqual(owner.count('peer-join'), 1, 'only the friend got in');

    // Locked rooms can be listed; the list says they are locked.
    const listed = (await server.roomList()).find(r => r.room === 'pw-room');
    assert.deepStrictEqual(listed, {room: 'pw-room', title: 'Secret base', locked: true, people: 2, names: ['Owner', 'Friend']});

    // A room without a password: not locked, and a password sent to it is ignored.
    const opener = await openRoom(server, 'open-room', 'Opener', {listed: true});
    assert.strictEqual(opener.welcome().locked, false);
    const guest = new Client(server, 'open-room', 'Guest', {password: 'anything'});
    assert.strictEqual(await guest.answer(), 'welcome');
    assert.strictEqual(guest.welcome().locked, false);
    await guest.next('caught-up');
    assert.strictEqual((await server.roomList()).find(r => r.room === 'open-room').locked, false);

    for (const client of [owner, friend, opener, guest, empty]) client.close();
});

test('the password survives a restart as a salted hash only; it is never saved, logged or sent', async () => {
    const PASSWORD = 'purple-rocket-pizza';
    const NEW_PASSWORD = 'green-moon-soup';
    const server = await startServer();
    const owner = await openRoom(server, 'saved-pw', 'Owner', {password: PASSWORD}, 'saved project');
    owner.send({t: 'op', ref: 1, op: {kind: 'blocks', n: 1}});
    await owner.next('ack');
    const friend = new Client(server, 'saved-pw', 'Friend', {password: PASSWORD});
    await friend.next('caught-up');
    const wrong = new Client(server, 'saved-pw', 'Wrong', {password: 'not-the-password'});
    assert.strictEqual(await wrong.answer(), 'wrong-password');
    owner.send({t: 'room-settings', password: NEW_PASSWORD});
    assert.strictEqual(roomInfo(await friend.next('room-info')).changed, 'password-set');
    owner.close();
    friend.close();
    await owner.closed;
    await friend.closed;
    await server.stop();

    const settings = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'saved-pw.json'), 'utf8'));
    assert.match(settings.passwordHash, /^scrypt\$/);
    for (const name of fs.readdirSync(server.dataDir)) {
        const content = fs.readFileSync(path.join(server.dataDir, name));
        assert.ok(!content.includes(PASSWORD) && !content.includes(NEW_PASSWORD), `${name} contains a password`);
    }

    const again = await startServer({DATA_DIR: server.dataDir});
    const noPassword = new Client(again, 'saved-pw', 'Late');
    assert.strictEqual(await noPassword.answer(), 'password-needed');
    const oldPassword = new Client(again, 'saved-pw', 'Late', {password: PASSWORD});
    assert.strictEqual(await oldPassword.answer(), 'wrong-password');
    const visitor = new Client(again, 'saved-pw', 'Late', {password: NEW_PASSWORD});
    assert.strictEqual(await visitor.answer(), 'welcome');
    assert.strictEqual(visitor.welcome().locked, true);
    assert.strictEqual(projectText((await visitor.next('snapshot')).data), 'saved project');
    await visitor.next('caught-up');
    visitor.close();
    await visitor.closed;
    await again.stop();

    for (const output of [server.output(), again.output()]) {
        assert.ok(output.includes('wrong password'), output);
        assert.ok(!output.includes(PASSWORD) && !output.includes(NEW_PASSWORD), output);
        assert.ok(!output.includes(settings.passwordHash) && !output.includes('scrypt'), output);
    }
    for (const client of [owner, friend, wrong, noPassword, oldPassword, visitor]) {
        const seen = JSON.stringify(client.messages);
        assert.ok(!seen.includes(PASSWORD) && !seen.includes(NEW_PASSWORD) && !seen.includes('scrypt'), seen);
    }
});

test('people reconnecting with their resume token keep their place without typing the password again', async () => {
    const server = await startServer({CREATOR_GRACE_MS: '3000'});
    const owner = await openRoom(server, 'resume-pw', 'Owner', {password: 'open-sesame'});
    const ownerWelcome = owner.welcome();
    // Their Wi-Fi changed: the editor connects again while the old connection is still open.
    const again = new Client(server, 'resume-pw', 'Owner', {resume: ownerWelcome.resume, color: ownerWelcome.color});
    assert.strictEqual(await again.answer(), 'welcome');
    assert.strictEqual(again.welcome().color, ownerWelcome.color);
    assert.strictEqual(again.welcome().locked, true);
    await again.next('caught-up');
    await owner.closed;
    // That token belongs to nobody in the room any more, so it proves nothing.
    const stranger = new Client(server, 'resume-pw', 'Stranger', {resume: ownerWelcome.resume});
    assert.strictEqual(await stranger.answer(), 'password-needed');
    const guesser = new Client(server, 'resume-pw', 'Guesser', {resume: 'nope', password: 'nope-nope'});
    assert.strictEqual(await guesser.answer(), 'wrong-password');
    again.close();

    // A room creator whose connection dropped before the project arrived.
    const creator = new Client(server, 'grace-pw', 'Creator', {password: 'first-one'});
    assert.strictEqual(await creator.answer(), 'welcome');
    await creator.next('need-snapshot');
    const friend = new Client(server, 'grace-pw', 'Friend', {password: 'first-one'});
    assert.strictEqual(await friend.answer(), 'welcome');
    creator.drop();
    await friend.next('peer-leave');
    const back = new Client(server, 'grace-pw', 'Creator', {resume: creator.welcome().resume});
    assert.strictEqual(await back.answer(), 'welcome');
    await back.next('need-snapshot');
    back.send({t: 'snapshot', seq: 0, data: fakeSb3('creator project')});
    assert.strictEqual(projectText((await friend.next('snapshot')).data), 'creator project');
    assert.strictEqual(friend.count('need-snapshot'), 0);
    back.close();
    friend.close();
});

test('anyone in the room can set, change or remove its password and rename it; each change is announced and saved', async () => {
    const server = await startServer();
    const clients = [];
    const join = (name, extra) => {
        const client = new Client(server, 'settings-pw', name, extra);
        clients.push(client);
        return client.answer();
    };
    const owner = await openRoom(server, 'settings-pw', 'Owner', {title: 'First name'});
    const ownerId = owner.welcome().id;
    const friend = new Client(server, 'settings-pw', 'Friend');
    assert.strictEqual(await friend.answer(), 'welcome');
    assert.strictEqual(friend.welcome().locked, false);
    const friendId = friend.welcome().id;
    await friend.next('caught-up');

    // Set.
    friend.send({t: 'room-settings', password: 'abcd'});
    const set = {listed: false, title: 'First name', locked: true, by: friendId, changed: 'password-set'};
    assert.deepStrictEqual(roomInfo(await owner.next('room-info')), set);
    assert.deepStrictEqual(roomInfo(await friend.next('room-info')), set);
    assert.strictEqual(await join('Late'), 'password-needed');
    assert.strictEqual(await join('Late', {password: 'abcd'}), 'welcome');

    // Change.
    owner.send({t: 'room-settings', password: 'efgh'});
    assert.deepStrictEqual(roomInfo(await friend.next('room-info')), {...set, by: ownerId});
    assert.deepStrictEqual(roomInfo(await owner.next('room-info')), {...set, by: ownerId});
    assert.strictEqual(await join('Late', {password: 'abcd'}), 'wrong-password');
    assert.strictEqual(await join('Late', {password: 'efgh'}), 'welcome');

    // Bad passwords are refused without closing the connection (the error
    // says it answers the room-settings message); other types are ignored.
    owner.send({t: 'room-settings', password: 'abc'});
    const short = await owner.next('error');
    assert.deepStrictEqual(short, {t: 'error', code: 'bad-password', for: 'room-settings',
        message: 'Room passwords need at least 4 characters', _seen: true});
    owner.send({t: 'room-settings', password: 'x'.repeat(101)});
    const long = await owner.next('error');
    assert.deepStrictEqual([long.code, long.for, long.message],
        ['bad-password', 'room-settings', 'Room passwords can be at most 100 characters']);
    owner.send({t: 'room-settings', password: 42});
    owner.send({t: 'room-settings', password: {}});
    owner.send({t: 'ping'});
    await owner.next('pong');
    await sleep(200);
    assert.strictEqual(friend.count('room-info'), 2);
    assert.strictEqual(friend.count('error'), 0, 'only the sender hears about a bad password');

    // Remove.
    friend.send({t: 'room-settings', password: null});
    assert.deepStrictEqual(roomInfo(await owner.next('room-info')),
        {listed: false, title: 'First name', locked: false, by: friendId, changed: 'password-removed'});
    // Removing it again changes nothing.
    friend.send({t: 'room-settings', password: ''});
    assert.strictEqual(await join('Anyone'), 'welcome');
    assert.strictEqual(clients[clients.length - 1].welcome().locked, false);

    // Rename (cleaned like a new room's name); nothing visible means no name.
    friend.send({t: 'room-settings', title: '  Space\u0007 Race  '});
    assert.deepStrictEqual(roomInfo(await owner.next('room-info')),
        {listed: false, title: 'Space Race', locked: false, by: friendId, changed: 'title'});
    friend.send({t: 'room-settings', title: '​  '});
    assert.deepStrictEqual(roomInfo(await owner.next('room-info')),
        {listed: false, title: null, locked: false, by: friendId, changed: 'title'});
    friend.send({t: 'room-settings', title: null});
    friend.send({t: 'room-settings', title: 5});
    friend.send({t: 'ping'});
    await friend.next('pong');
    await sleep(100);
    assert.strictEqual(owner.count('room-info'), 5);

    // Several changes in one message: each is announced, in order.
    owner.send({t: 'room-settings', listed: true, title: 'Final name', password: 'last-one'});
    const changes = [];
    for (let i = 0; i < 3; i++) changes.push(roomInfo(await friend.next('room-info', m => m.by === ownerId)));
    assert.deepStrictEqual(changes, [
        {listed: true, title: null, locked: false, by: ownerId, changed: 'listed'},
        {listed: true, title: 'Final name', locked: false, by: ownerId, changed: 'title'},
        {listed: true, title: 'Final name', locked: true, by: ownerId, changed: 'password-set'}
    ]);
    const listed = (await server.roomList()).find(r => r.room === 'settings-pw');
    assert.strictEqual(listed.locked, true);
    assert.strictEqual(listed.title, 'Final name');

    // All remembered after a restart.
    for (const client of [owner, friend, ...clients]) client.close();
    await Promise.all([owner, friend, ...clients].map(client => client.closed));
    await server.stop();
    const again = await startServer({DATA_DIR: server.dataDir});
    const late = new Client(again, 'settings-pw', 'Late');
    assert.strictEqual(await late.answer(), 'password-needed');
    const back = new Client(again, 'settings-pw', 'Back', {password: 'last-one'});
    assert.strictEqual(await back.answer(), 'welcome');
    assert.deepStrictEqual([back.welcome().listed, back.welcome().title, back.welcome().locked], [true, 'Final name', true]);
    back.close();
});

test('password changes: the last one asked for wins, and each person can make only so many a minute', async () => {
    const server = await startServer({ROOM_PASSWORD_HASHES_PER_MINUTE: '100'});
    const owner = await openRoom(server, 'many-changes', 'Owner');
    const tryPassword = async password => {
        const client = new Client(server, 'many-changes', 'Guest', {password});
        const answer = await client.answer();
        client.close();
        return answer;
    };
    // Two at once: the one asked for last wins. A third at the same moment is
    // more than one address may have hashed at once: refused, nothing cancelled.
    for (const password of ['pass-01', 'pass-02', 'pass-03']) owner.send({t: 'room-settings', password});
    const refused = await owner.next('error');
    assert.deepStrictEqual([refused.code, refused.for, refused.message], ['busy', 'room-settings',
        'Too many room passwords were set from your network just now. Try again in a minute.']);
    await owner.next('room-info', m => m.changed === 'password-set');
    await sleep(300);
    assert.strictEqual(owner.count('room-info'), 1, 'the first change was overtaken: never announced');
    assert.strictEqual(await tryPassword('pass-01'), 'wrong-password');
    assert.strictEqual(await tryPassword('pass-03'), 'wrong-password');
    assert.strictEqual(await tryPassword('pass-02'), 'welcome');

    // Ten changes a minute per person (three so far, the refused one included).
    for (let i = 4; i <= 10; i++) {
        owner.send({t: 'room-settings', password: `pass-${String(i).padStart(2, '0')}`});
        await owner.next('room-info', m => m.changed === 'password-set');
    }
    owner.send({t: 'room-settings', password: 'pass-11'});
    const tooOften = await owner.next('error');
    assert.deepStrictEqual([tooOften.code, tooOften.for, tooOften.message], ['busy', 'room-settings',
        'You changed the room\'s password too often. Try again in a minute.']);
    owner.send({t: 'ping'});
    await owner.next('pong');
    assert.strictEqual(await tryPassword('pass-11'), 'wrong-password');
    assert.strictEqual(await tryPassword('pass-10'), 'welcome');
    owner.close();
});

test('passwords that are too short or too long are refused when joining', async () => {
    const server = await startServer();
    const short = new Client(server, 'short-pw', 'Shorty', {password: 'abc'});
    const shortError = await short.next('error');
    assert.deepStrictEqual([shortError.code, shortError.message], ['bad-password', 'Room passwords need at least 4 characters']);
    assert.ok(!('for' in shortError), 'a refused hello is not about room settings');
    await short.closed;
    const long = new Client(server, 'short-pw', 'Long', {password: 'x'.repeat(101)});
    const longError = await long.next('error');
    assert.deepStrictEqual([longError.code, longError.message], ['bad-password', 'Room passwords can be at most 100 characters']);

    // Exactly 4 and 100 characters are fine.
    const four = new Client(server, 'four-pw', 'Four', {password: 'abcd'});
    assert.strictEqual(await four.answer(), 'welcome');
    assert.strictEqual(four.welcome().locked, true);
    const hundred = new Client(server, 'hundred-pw', 'Hundred', {password: 'y'.repeat(100)});
    assert.strictEqual(await hundred.answer(), 'welcome');
    assert.strictEqual(hundred.welcome().locked, true);

    // The refused room was not kept: the next person creates it, without a password.
    const next = new Client(server, 'short-pw', 'Next');
    assert.strictEqual(await next.answer(), 'welcome');
    assert.strictEqual(next.welcome().locked, false);
    await next.next('need-snapshot');
    // Too long is refused even where any password would be ignored.
    const tooLong = new Client(server, 'short-pw', 'Long', {password: 'x'.repeat(101)});
    assert.strictEqual(await tooLong.answer(), 'bad-password');
    // A short guess at a locked room is just a wrong password.
    const guess = new Client(server, 'four-pw', 'Guess', {password: 'ab'});
    assert.strictEqual(await guess.answer(), 'wrong-password');
    for (const client of [four, hundred, next]) client.close();
});

test('wrong passwords are limited per room and address, and per room; reconnecting with a token never is', async () => {
    const server = await startServer({TRUSTED_PROXY_HOPS: '1', ROOM_PASSWORD_TRIES_PER_IP: '3', ROOM_PASSWORD_TRIES_PER_ROOM: '5'});
    const from = ip => ({'x-forwarded-for': ip});
    const tryJoin = async (room, password, ip) => {
        const client = new Client(server, room, 'Guest', {password}, from(ip));
        const answer = await client.answer();
        client.close();
        return answer;
    };
    const owner = await openRoom(server, 'guarded', 'Owner', {password: 'right-one'}, 'guarded', from('10.0.0.9'));
    const other = await openRoom(server, 'other-guarded', 'Other', {password: 'other-one'}, 'other', from('10.0.0.9'));

    for (let i = 0; i < 3; i++) assert.strictEqual(await tryJoin('guarded', `wrong-${i}`, '10.0.0.1'), 'wrong-password');
    const blocked = new Client(server, 'guarded', 'Guest', {password: 'right-one'}, from('10.0.0.1'));
    const blockedError = await blocked.next('error');
    assert.deepStrictEqual([blockedError.code, blockedError.message],
        ['too-many-tries', 'Too many wrong passwords for this room. Wait a few minutes and try again.']);
    // Other addresses and other rooms are not affected.
    assert.strictEqual(await tryJoin('guarded', 'right-one', '10.0.0.2'), 'welcome');
    assert.strictEqual(await tryJoin('other-guarded', 'other-one', '10.0.0.1'), 'welcome');

    // Five wrong passwords for the room from anyone: nobody new gets in for now.
    for (let i = 0; i < 2; i++) assert.strictEqual(await tryJoin('guarded', `wrong-${i}`, '10.0.0.2'), 'wrong-password');
    assert.strictEqual(await tryJoin('guarded', 'right-one', '10.0.0.3'), 'too-many-tries');
    assert.strictEqual(await tryJoin('other-guarded', 'other-one', '10.0.0.3'), 'welcome');

    // The owner's editor reconnecting with its token keeps its place.
    const again = new Client(server, 'guarded', 'Owner', {resume: owner.welcome().resume}, from('10.0.0.1'));
    assert.strictEqual(await again.answer(), 'welcome');
    again.close();
    other.close();
});

test('many guesses at the same moment cannot get past the limit together; a class with the right password all gets in', async () => {
    const server = await startServer({ROOM_PASSWORD_TRIES_PER_IP: '3'});
    const owner = await openRoom(server, 'burst-room', 'Owner', {password: 'right-one'});
    const guessers = [];
    for (let i = 0; i < 12; i++) guessers.push(new Client(server, 'burst-room', 'Guesser', {password: `guess-${i}`}));
    const answers = await Promise.all(guessers.map(guesser => guesser.answer()));
    assert.strictEqual(answers.filter(answer => answer === 'wrong-password').length, 3, answers.join());
    assert.strictEqual(answers.filter(answer => answer === 'too-many-tries').length, 9, answers.join());
    owner.close();

    // Everyone behind one school network typing the right password at once
    // (as many as one address may have checked at once): nobody is refused.
    const teacher = await openRoom(server, 'class-room', 'Teacher', {password: 'class-pass'});
    const kids = [];
    for (let i = 0; i < 16; i++) kids.push(new Client(server, 'class-room', `Kid ${i}`, {password: 'class-pass'}));
    const kidAnswers = await Promise.all(kids.map(kid => kid.answer()));
    assert.deepStrictEqual(kidAnswers, kids.map(() => 'welcome'));
    teacher.close();
    for (const kid of kids) kid.close();
});

test('two people creating the same room at the same moment with different passwords: one password wins', async () => {
    // (Everyone here has the same address: more than its usual share of new passwords.)
    const server = await startServer({ROOM_PASSWORD_HASHES_PER_MINUTE: '100'});
    for (let round = 0; round < 4; round++) {
        const room = `race-${round}`;
        const ann = new Client(server, room, 'Ann', {password: 'ann-password'});
        const bob = new Client(server, room, 'Bob', {password: 'bob-password'});
        const answers = await Promise.all([ann.answer(), bob.answer()]);
        assert.deepStrictEqual([...answers].sort(), ['welcome', 'wrong-password']);
        const [winner, winnerPassword] = answers[0] === 'welcome' ? [ann, 'ann-password'] : [bob, 'bob-password'];
        assert.strictEqual(winner.welcome().locked, true);
        await winner.next('need-snapshot');
        winner.send({t: 'snapshot', seq: 0, data: fakeSb3(`winner ${round}`)});
        // The other person must use the winning password.
        const retry = new Client(server, room, 'Retry', {password: winnerPassword});
        assert.strictEqual(await retry.answer(), 'welcome');
        assert.strictEqual(projectText((await retry.next('snapshot')).data), `winner ${round}`);
        winner.close();
        retry.close();
    }

    // With and without a password at the same moment: both get in, and both are told there is none.
    const cat = new Client(server, 'race-mixed', 'Cat', {password: 'cat-password'});
    const dog = new Client(server, 'race-mixed', 'Dog');
    assert.deepStrictEqual(await Promise.all([cat.answer(), dog.answer()]), ['welcome', 'welcome']);
    assert.deepStrictEqual([cat.welcome().locked, dog.welcome().locked], [false, false]);
    cat.close();
    dog.close();
});

test('a password change while someone is being checked never lets them in with the old one after it', async () => {
    const server = await startServer({ROOM_PASSWORD_HASHES_PER_MINUTE: '100'});
    for (let round = 0; round < 4; round++) {
        const room = `change-race-${round}`;
        const owner = await openRoom(server, room, 'Owner', {password: 'old-pass'});
        const late = new Client(server, room, 'Late', {password: 'old-pass'});
        await late.opened;
        owner.send({t: 'room-settings', password: 'new-pass'});
        const answer = await late.answer();
        await owner.next('room-info');
        const order = owner.messages.filter(m => m.t === 'peer-join' || m.t === 'room-info').map(m => m.t);
        if (answer === 'welcome') {
            // Let in while the old password was still the room's password.
            assert.deepStrictEqual(order, ['peer-join', 'room-info']);
        } else {
            assert.strictEqual(answer, 'wrong-password');
            assert.deepStrictEqual(order, ['room-info']);
        }
        owner.close();
        late.close();
    }
});

test('while a hello is being checked nothing else from that connection is used; leaving meanwhile leaves no trace', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'careful-room', 'Owner', {password: 'right-one'});

    // A wrong password, then at once a second hello with the right one: only the first counts.
    const sneaky = new Client(server, null, null);
    await sneaky.opened;
    sneaky.hello('careful-room', 'Sneaky', {password: 'wrong-one'});
    sneaky.hello('careful-room', 'Sneaky', {password: 'right-one'});
    sneaky.send({t: 'chat', text: 'let me in'});
    assert.strictEqual(await sneaky.answer(), 'wrong-password');
    await sneaky.closed;
    assert.strictEqual(sneaky.count('welcome'), 0);

    // The right password, but gone before it was checked.
    const leaver = new Client(server, null, null);
    await leaver.opened;
    leaver.hello('careful-room', 'Leaver', {password: 'right-one'});
    // A brand-new room's creator, gone before its password was hashed.
    const ghost = new Client(server, null, null);
    await ghost.opened;
    ghost.hello('ghost-room', 'Ghost', {password: 'ghost-pass'});
    await sleep(15);
    leaver.drop();
    ghost.drop();

    await sleep(500);
    assert.strictEqual(owner.count('peer-join'), 0);
    assert.strictEqual(owner.count('chat'), 0);
    const health = await server.health();
    assert.strictEqual(health.people, 1);
    assert.strictEqual(health.rooms, 1, 'the ghost room is not kept');
    // The ghost room can still be created by anyone, as a new room.
    const fresh = new Client(server, 'ghost-room', 'Fresh');
    assert.strictEqual(await fresh.answer(), 'welcome');
    assert.strictEqual(fresh.welcome().locked, false);
    fresh.close();
    owner.close();
    assert.ok(server.alive());
});

const from = ip => ({'x-forwarded-for': ip});

test('someone let in whose connection drops comes back with their resume token: no password needed, never counted or blocked', async () => {
    const server = await startServer({TRUSTED_PROXY_HOPS: '1', ROOM_PASSWORD_TRIES_PER_IP: '3', ROOM_PASSWORD_TRIES_PER_ROOM: '5'});
    const owner = await openRoom(server, 'drop-room', 'Owner', {password: 'old-pass'}, 'drop project', from('10.0.1.1'));
    const member = new Client(server, 'drop-room', 'Kid', {password: 'old-pass'}, from('10.0.1.2'));
    assert.strictEqual(await member.answer(), 'welcome');
    await member.next('caught-up');
    // Someone else changes the password: the member's editor only knows the old one.
    owner.send({t: 'room-settings', password: 'new-pass'});
    await member.next('room-info', m => m.changed === 'password-set');

    // Guessers use up the wrong tries of the member's address, then the room's.
    for (let i = 0; i < 5; i++) {
        const guesser = new Client(server, 'drop-room', 'Guesser', {password: `guess-${i}`}, from(i < 3 ? '10.0.1.2' : '10.0.1.3'));
        assert.strictEqual(await guesser.answer(), 'wrong-password');
    }
    const friend = new Client(server, 'drop-room', 'Friend', {password: 'new-pass'}, from('10.0.1.4'));
    assert.strictEqual(await friend.answer(), 'too-many-tries', 'the limits still hold for everyone else');

    // The member's Wi-Fi drops, and the server notices before their editor reconnects.
    member.drop();
    await owner.next('peer-leave');
    const back = new Client(server, 'drop-room', 'Kid', {resume: member.welcome().resume, password: 'old-pass'}, from('10.0.1.2'));
    assert.strictEqual(await back.answer(), 'welcome');
    assert.strictEqual(back.welcome().locked, true);
    assert.strictEqual(projectText((await back.next('snapshot')).data), 'drop project');
    await back.next('caught-up');
    // A token works once: the member has a new one now.
    assert.notStrictEqual(back.welcome().resume, member.welcome().resume);
    const copycat = new Client(server, 'drop-room', 'Copycat', {resume: member.welcome().resume}, from('10.0.1.5'));
    assert.strictEqual(await copycat.answer(), 'password-needed');

    // Dropped again, and back with no password at all.
    back.drop();
    await owner.next('peer-leave');
    const again = new Client(server, 'drop-room', 'Kid', {resume: back.welcome().resume}, from('10.0.1.2'));
    assert.strictEqual(await again.answer(), 'welcome');
    await again.next('caught-up');

    // Someone who clicks Leave needs the password to come back.
    again.close();
    await owner.next('peer-leave');
    const afterLeave = new Client(server, 'drop-room', 'Kid', {resume: again.welcome().resume}, from('10.0.1.6'));
    assert.strictEqual(await afterLeave.answer(), 'password-needed');
    // Nobody's token was saved, in any form.
    for (const name of fs.readdirSync(server.dataDir)) {
        const content = fs.readFileSync(path.join(server.dataDir, name), 'utf8');
        for (const client of [member, back, again]) assert.ok(!content.includes(client.welcome().resume), name);
    }
    owner.close();
});

test('members whose editor or the server closed their connection come back with their token; only Leave needs the password', async () => {
    const server = await startServer({MAX_OP_LOG_OPS: '3', SNAPSHOT_IDLE_MS: '600000'});
    const owner = await openRoom(server, 'closes', 'Owner');
    const members = {};
    for (const name of ['Dropped', 'Reconnecting', 'BadOp', 'TooManyEdits', 'Leaver', 'Leaver1000']) {
        members[name] = new Client(server, 'closes', name);
        await members[name].next('caught-up');
    }
    // Someone sets a password while they are all in the room: none of their editors knows it.
    owner.send({t: 'room-settings', password: 'set-later'});
    for (const member of Object.values(members)) await member.next('room-info', m => m.changed === 'password-set');

    const backAfter = async (name, close) => {
        const member = members[name];
        await close(member);
        await member.closed;
        await owner.next('peer-leave', m => m.id === member.welcome().id);
        const back = new Client(server, 'closes', name, {resume: member.welcome().resume, expectLocked: true});
        const answer = await back.answer();
        back.close();
        return answer;
    };
    // The Wi-Fi broke (1006).
    assert.strictEqual(await backAfter('Dropped', member => member.drop()), 'welcome');
    // The editor thought the connection was dead and closed it to connect again.
    assert.strictEqual(await backAfter('Reconnecting', member => member.ws.close(4000, 'reconnecting')), 'welcome');
    // The server refused an edit and closed the connection; the editor reconnects.
    const tooDeep = depth => (depth === 0 ? {x: 1} : {a: tooDeep(depth - 1)});
    assert.strictEqual(await backAfter('BadOp', async member => {
        member.send({t: 'op', ref: 1, op: tooDeep(120)});
        assert.strictEqual((await member.next('error')).code, 'bad-op');
    }), 'welcome');
    assert.strictEqual(await backAfter('TooManyEdits', async member => {
        for (let i = 0; i < 4; i++) member.send({t: 'op', ref: i, op: {kind: 'blocks', n: i}});
        assert.strictEqual((await member.next('error')).code, 'too-many-edits');
    }), 'welcome');
    // Leave: a plain close (older editors), or 1000.
    assert.strictEqual(await backAfter('Leaver', member => member.close()), 'password-needed');
    assert.strictEqual(await backAfter('Leaver1000', member => member.ws.close(1000)), 'password-needed');
    owner.close();
});

test('a token from before the password changed is no pass and works once; only the old password of someone who dropped out of the locked room is not counted', async () => {
    // Any wrong password counted here blocks the address for everyone new,
    // and two block the room.
    const server = await startServer({TRUSTED_PROXY_HOPS: '1', ROOM_PASSWORD_TRIES_PER_IP: '1', ROOM_PASSWORD_TRIES_PER_ROOM: '2'});
    const owner = await openRoom(server, 'old-tokens', 'Owner', {listed: true}, 'open project', from('10.0.8.1'));
    const joinAndDrop = async (name, extra = {}, ip = '10.0.8.2') => {
        const member = new Client(server, 'old-tokens', name, extra, from(ip));
        assert.strictEqual(await member.answer(), 'welcome');
        await member.next('caught-up');
        member.drop();
        await owner.next('peer-leave', m => m.id === member.welcome().id);
        return member.welcome().resume;
    };
    const comeBack = async (token, password, ip = '10.0.8.2') => {
        const client = new Client(server, 'old-tokens', 'Back', {resume: token, password, expectLocked: true}, from(ip));
        const answer = await client.answer();
        client.close();
        return answer;
    };
    // Strangers from the Open rooms list drop out while the room is open...
    const strangerTokens = [];
    for (let i = 0; i < 2; i++) strangerTokens.push(await joinAndDrop(`Stranger ${i}`));
    // ...and a friend is in the room when the owner sets a password.
    const friend = new Client(server, 'old-tokens', 'Friend', {}, from('10.0.8.3'));
    await friend.next('caught-up');
    owner.send({t: 'room-settings', password: 'private-now'});
    await friend.next('room-info', m => m.changed === 'password-set');
    await owner.next('room-info', m => m.changed === 'password-set');

    // The friend was there when the password was set: their token is still a pass.
    friend.drop();
    await owner.next('peer-leave', m => m.id === friend.welcome().id);
    assert.strictEqual(await comeBack(friend.welcome().resume, '', '10.0.8.3'), 'welcome');
    // A pass until the password changes again after they dropped.
    const memberTokens = [];
    for (let i = 0; i < 4; i++) memberTokens.push(await joinAndDrop(`Member ${i}`, {password: 'private-now'}, '10.0.8.3'));
    owner.send({t: 'room-settings', password: 'changed-again'});
    await owner.next('room-info', m => m.changed === 'password-set');
    // The old password their editors still send, or none: refused as usual,
    // but not counted (the address has one try, and it is still there).
    assert.strictEqual(await comeBack(memberTokens[0], 'private-now', '10.0.8.3'), 'wrong-password');
    assert.strictEqual(await comeBack(memberTokens[1], 'private-now', '10.0.8.3'), 'wrong-password');
    assert.strictEqual(await comeBack(memberTokens[2], '', '10.0.8.3'), 'password-needed');
    // The new password works as for anyone.
    assert.strictEqual(await comeBack(memberTokens[3], 'changed-again', '10.0.8.3'), 'welcome');
    // No password with a stranger's token isn't a guess either.
    assert.strictEqual(await comeBack(strangerTokens[0], ''), 'password-needed');
    // Nothing above was counted: the room is not blocked.
    assert.strictEqual(await comeBack(null, 'changed-again', '10.0.8.2'), 'welcome');

    // The strangers dropped out while the room had no password: they had
    // none to send, so what they send now is a guess like anyone's. Here,
    // the address's one try...
    assert.strictEqual(await comeBack(strangerTokens[1], 'not-it'), 'wrong-password');
    assert.strictEqual(await comeBack(null, 'changed-again', '10.0.8.2'), 'too-many-tries');
    // ...and each token worked once: a member's old password is a plain
    // guess now, the room's second try.
    assert.strictEqual(await comeBack(memberTokens[0], 'private-now', '10.0.8.4'), 'wrong-password');
    assert.strictEqual(await comeBack(null, 'changed-again', '10.0.8.5'), 'too-many-tries');
    owner.close();
});

test('for each new password, only as many old passwords of members who dropped out go uncounted as people fit in a room', async () => {
    const server = await startServer({TRUSTED_PROXY_HOPS: '1', ROOM_PASSWORD_TRIES_PER_IP: '1', ROOM_PASSWORD_TRIES_PER_ROOM: '2'});
    const owner = await openRoom(server, 'uncounted', 'Owner', {password: 'first-pass'}, 'uncounted project', from('10.0.12.1'));
    // 36 members, each from their own address, drop out while the password is 'first-pass'.
    const tokens = [];
    for (let batch = 0; batch < 2; batch++) {
        const members = [];
        for (let i = 0; i < 18; i++) {
            members.push(new Client(server, 'uncounted', 'Member', {password: 'first-pass'}, from(`10.0.13.${tokens.length + i}`)));
        }
        await Promise.all(members.map(member => member.next('caught-up')));
        for (const member of members) {
            tokens.push(member.welcome().resume);
            member.drop();
        }
        for (const member of members) await owner.next('peer-leave', m => m.id === member.welcome().id);
    }
    owner.send({t: 'room-settings', password: 'second-pass'});
    await owner.next('room-info', m => m.changed === 'password-set');
    const comeBack = async (token, password, ip) => {
        const client = new Client(server, 'uncounted', 'Back', {resume: token, password, expectLocked: true}, from(ip));
        const answer = await client.answer();
        client.close();
        return answer;
    };
    // All from one address, which has one try: the first 32 are not counted...
    for (let i = 0; i < 32; i++) {
        assert.strictEqual(await comeBack(tokens[i], 'first-pass', '10.0.14.1'), 'wrong-password', `token ${i}`);
    }
    // ...the 33rd is (the address's one try), and that address is blocked now.
    assert.strictEqual(await comeBack(tokens[32], 'first-pass', '10.0.14.1'), 'wrong-password');
    assert.strictEqual(await comeBack(tokens[33], 'first-pass', '10.0.14.1'), 'too-many-tries');
    // The next password has its own uncounted checks.
    owner.send({t: 'room-settings', password: 'third-pass'});
    await owner.next('room-info', m => m.changed === 'password-set');
    assert.strictEqual(await comeBack(tokens[34], 'first-pass', '10.0.14.2'), 'wrong-password');
    assert.strictEqual(await comeBack(tokens[35], 'first-pass', '10.0.14.2'), 'wrong-password');
    // The room has one of its two tries left (the 33rd), and 10.0.14.2 its one.
    assert.strictEqual(await comeBack(null, 'third-pass', '10.0.14.2'), 'welcome');
    owner.close();
});

test('one address can have only so many password checks at once; other addresses and new passwords are not held up', async () => {
    const server = await startServer({TRUSTED_PROXY_HOPS: '1', ROOM_PASSWORD_CHECKS_PER_ADDRESS: '3'});
    const own = await openRoom(server, 'own-room', 'Own', {password: 'own-pass'}, 'own project', from('10.0.9.66'));
    const target = await openRoom(server, 'their-room', 'Owner', {password: 'their-pass'}, 'their project', from('10.0.9.1'));
    // Right passwords are never counted as tries, so only the share stops one
    // address from keeping every check busy with its own room.
    const flood = [];
    for (let i = 0; i < 6; i++) flood.push(new Client(server, null, null, {}, from('10.0.9.66')));
    const friend = new Client(server, null, null, {}, from('10.0.9.2'));
    await Promise.all([...flood, friend].map(client => client.opened));
    flood.forEach(client => client.hello('own-room', 'Flood', {password: 'own-pass'}));
    friend.hello('their-room', 'Friend', {password: 'their-pass'});
    const floodAnswers = await Promise.all(flood.map(client => client.answer()));
    assert.deepStrictEqual([...floodAnswers].sort(), ['busy', 'busy', 'busy', 'welcome', 'welcome', 'welcome']);
    assert.strictEqual(flood[floodAnswers.indexOf('busy')].messages.find(m => m.t === 'error').message,
        'The server is busy right now. Try again in a minute.');
    assert.strictEqual(await friend.answer(), 'welcome');
    for (const client of [...flood, friend]) client.close();

    // Checks never take the last running slot: a password change starts at
    // once, even with many checks (each from its own address) waiting.
    const many = [];
    for (let i = 0; i < 30; i++) many.push(new Client(server, null, null, {}, from(`10.0.10.${i}`)));
    await Promise.all(many.map(client => client.opened));
    let answered = 0;
    const answers = many.map(client => {
        client.hello('their-room', 'Many', {password: 'their-pass'});
        return client.answer().then(answer => {
            answered++;
            return answer;
        });
    });
    own.send({t: 'room-settings', password: 'own-pass-2'});
    await own.next('room-info', m => m.changed === 'password-set');
    const answeredFirst = answered;
    assert.deepStrictEqual(await Promise.all(answers), many.map(() => 'welcome'));
    assert.ok(answeredFirst < 15, `the change waited for ${answeredFirst} of 30 checks`);
    for (const client of [own, target, ...many]) client.close();
});

test('waiting checks take turns per address: five addresses using their whole share never keep a sixth out', async () => {
    const server = await startServer({TRUSTED_PROXY_HOPS: '1'});
    const target = await openRoom(server, 'fair-target', 'Owner', {password: 'target-pass'}, 'fair project', from('10.0.22.1'));
    // Right passwords are never counted as tries: 5 x 16 checks for their
    // own rooms is more than every running slot and waiting place.
    const own = [];
    const flood = [];
    for (let n = 0; n < 5; n++) {
        own.push(await openRoom(server, `fair-own-${n}`, 'Flood', {password: 'flood-pass'}, 'flood project', from(`10.0.21.${n}`)));
        for (let i = 0; i < 16; i++) flood.push(new Client(server, null, null, {}, from(`10.0.21.${n}`)));
    }
    const friend = new Client(server, null, null, {}, from('10.0.22.2'));
    await Promise.all([...flood, friend].map(client => client.opened));
    // (80 checks take a while on a slow or busy computer.)
    let welcomes = 0;
    const floodAnswers = flood.map(client => client.answer(60000).then(answer => {
        if (answer === 'welcome') welcomes++;
        return answer;
    }));
    flood.forEach((client, i) => client.hello(`fair-own-${Math.floor(i / 16)}`, 'Flood', {password: 'flood-pass'}));
    friend.hello('fair-target', 'Friend', {password: 'target-pass'});

    // The friend's check got a waiting place (the newest of an address with
    // the most waiting made way), and its turn came after one check of each
    // flooding address, not after all of them.
    assert.strictEqual(await friend.answer(60000), 'welcome');
    const welcomesFirst = welcomes;
    assert.strictEqual(projectText((await friend.next('snapshot')).data), 'fair project');
    const answers = await Promise.all(floodAnswers);
    assert.ok(answers.every(answer => answer === 'welcome' || answer === 'busy'), answers.join());
    const busy = answers.filter(answer => answer === 'busy').length;
    assert.ok(busy >= 1 && busy <= 12, `${busy} flood checks were refused`);
    assert.ok(welcomesFirst < 30, `the friend waited for ${welcomesFirst} of the ${80 - busy} flood checks`);
    for (const client of [target, ...own, friend, ...flood]) client.close();
});

test('per-address limits count an IPv6 address by its /64, and an IPv4 address written the IPv6 way as itself', async () => {
    const server = await startServer({TRUSTED_PROXY_HOPS: '1', ROOM_PASSWORD_TRIES_PER_IP: '1', ROOM_PASSWORD_CHECKS_PER_ADDRESS: '2'});
    const owner = await openRoom(server, 'v6-room', 'Owner', {password: 'v6-pass'}, 'v6 project', from('10.0.23.1'));
    const tryJoin = async (password, ip) => {
        const client = new Client(server, 'v6-room', 'Guest', {password}, from(ip));
        const answer = await client.answer();
        client.close();
        return answer;
    };
    // One wrong try per address: another address in the same /64 is the same address.
    assert.strictEqual(await tryJoin('wrong-one', '2001:db8:1:2::1'), 'wrong-password');
    assert.strictEqual(await tryJoin('v6-pass', '2001:db8:1:2:abcd:ef01:2345:6789'), 'too-many-tries');
    assert.strictEqual(await tryJoin('v6-pass', '2001:db8:1:3::1'), 'welcome');
    // IPv4 addresses are not lumped together.
    assert.strictEqual(await tryJoin('wrong-one', '::ffff:10.0.24.1'), 'wrong-password');
    assert.strictEqual(await tryJoin('v6-pass', '10.0.24.1'), 'too-many-tries');
    assert.strictEqual(await tryJoin('v6-pass', '::ffff:10.0.24.2'), 'welcome');
    assert.strictEqual(await tryJoin('v6-pass', '10.0.24.3'), 'welcome');
    // The share of checks at once, too: three from one /64 at the same moment.
    const three = ['2001:db8:5:6::1', '2001:db8:5:6::2', '2001:db8:5:6:1::3']
        .map(ip => new Client(server, null, null, {}, from(ip)));
    await Promise.all(three.map(client => client.opened));
    three.forEach(client => client.hello('v6-room', 'Guest', {password: 'v6-pass'}));
    assert.deepStrictEqual((await Promise.all(three.map(client => client.answer()))).sort(), ['busy', 'welcome', 'welcome']);
    for (const client of [owner, ...three]) client.close();
});

test('dropped members are remembered for a while, while the room is open, and at most 200 per room and 32 per address', async () => {
    const server = await startServer({TRUSTED_PROXY_HOPS: '1'});
    const owner = await openRoom(server, 'many-drops', 'Owner', {password: 'many-pass'}, 'many project', from('10.0.15.1'));
    const tokens = [];
    // `count` people join the room `insider` is in with the password and drop out, each from the address ip(n).
    const joinAndDrop = async (insider, room, count, ip) => {
        const people = [];
        for (let i = 0; i < count; i++) {
            people.push(new Client(server, room, `P${tokens.length + i}`, {password: 'many-pass'}, from(ip(tokens.length + i))));
        }
        await Promise.all(people.map(person => person.next('caught-up')));
        for (const person of people) {
            tokens.push(person.welcome().resume);
            person.drop();
            // One at a time, so the server remembers them in this order.
            await insider.next('peer-leave', m => m.id === person.welcome().id);
        }
    };
    // A token from the password as it is now is a pass: no password needed.
    const comeBack = async (room, token, ip = '10.0.15.2') => {
        const client = new Client(server, room, 'Back', {resume: token, expectLocked: true}, from(ip));
        const answer = await client.answer();
        client.close();
        return answer;
    };
    // One first, so it is surely the oldest; then 200 more, 25 at a time,
    // each from their own address.
    const eachOwn = n => `10.0.${16 + Math.floor(n / 200)}.${n % 200}`;
    await joinAndDrop(owner, 'many-drops', 1, eachOwn);
    for (let i = 0; i < 8; i++) await joinAndDrop(owner, 'many-drops', 25, eachOwn);
    // The oldest made way for the 201st.
    assert.strictEqual(await comeBack('many-drops', tokens[0]), 'password-needed');
    for (const index of [1, 2, 100, 200]) assert.strictEqual(await comeBack('many-drops', tokens[index]), 'welcome', `token ${index}`);
    owner.close();

    // One address (a whole class) can have only 32 remembered per room: its oldest make way.
    tokens.length = 0;
    const school = await openRoom(server, 'one-network', 'Teacher', {password: 'many-pass'}, 'class project', from('10.0.18.1'));
    await joinAndDrop(school, 'one-network', 1, () => '10.0.18.2');
    for (let i = 0; i < 3; i++) await joinAndDrop(school, 'one-network', 12, () => '10.0.18.3');
    assert.strictEqual(await comeBack('one-network', tokens[1]), 'password-needed');
    assert.strictEqual(await comeBack('one-network', tokens[4]), 'password-needed');
    for (const index of [5, 6, 20, 36]) assert.strictEqual(await comeBack('one-network', tokens[index]), 'welcome', `token ${index}`);
    // Other addresses' are kept.
    assert.strictEqual(await comeBack('one-network', tokens[0]), 'welcome');
    school.close();

    // Kept only so long...
    const short = await startServer({DROPPED_MEMBER_KEEP_MS: '300', EMPTY_ROOM_KEEP_MS: '300'});
    const host = await openRoom(short, 'short-memory', 'Host', {password: 'some-pass'});
    const kid = new Client(short, 'short-memory', 'Kid', {password: 'some-pass'});
    await kid.next('caught-up');
    kid.drop();
    await host.next('peer-leave');
    await sleep(500);
    const late = new Client(short, 'short-memory', 'Kid', {resume: kid.welcome().resume});
    assert.strictEqual(await late.answer(), 'password-needed');
    // ...and only while the room is in memory.
    const kid2 = new Client(short, 'short-memory', 'Kid', {password: 'some-pass'});
    await kid2.next('caught-up');
    kid2.drop();
    await host.next('peer-leave');
    host.close();
    await waitFor(() => short.output().includes('[short-memory] empty, saved and closed'), 'the room to close');
    const afterClose = new Client(short, 'short-memory', 'Kid', {resume: kid2.welcome().resume});
    assert.strictEqual(await afterClose.answer(), 'password-needed');
});

test('a room the server forgot is only created again by someone with its password, if the editor knows it had one', async () => {
    const server = await startServer({ROOM_PASSWORD_TRIES_PER_IP: '1'});
    // The editor saw the room locked; then the server lost it (say, it restarted with an empty disk).
    for (let i = 0; i < 3; i++) {
        const member = new Client(server, 'forgotten', 'Member', {expectLocked: true, listed: true, resume: 'old-token'});
        const refused = await member.next('error');
        assert.deepStrictEqual([refused.code, refused.message], ['password-needed', 'This room has a password. Type it to join.']);
        await member.closed;
        assert.strictEqual(member.count('need-snapshot'), 0);
    }
    assert.strictEqual((await server.health()).rooms, 0, 'not created');
    assert.strictEqual(await new Client(server, 'forgotten', 'Member', {expectLocked: true, password: 'abc'}).answer(),
        'bad-password');

    // Someone who has the password creates it again, locked.
    const keeper = new Client(server, 'forgotten', 'Keeper', {expectLocked: true, password: 'the-pass', listed: true});
    assert.strictEqual(await keeper.answer(), 'welcome');
    assert.strictEqual(keeper.welcome().locked, true);
    await keeper.next('need-snapshot');
    keeper.send({t: 'snapshot', seq: 0, data: fakeSb3('kept project')});
    // The refusals above were not guesses (only one is allowed here).
    const member = new Client(server, 'forgotten', 'Member', {expectLocked: true, password: 'the-pass'});
    assert.strictEqual(await member.answer(), 'welcome');
    assert.strictEqual(projectText((await member.next('snapshot')).data), 'kept project');

    // Older editors don't send it: rooms are created as before. An existing
    // room without a password lets in anyone, whatever the editor expected.
    const old = new Client(server, 'open-again', 'Old');
    assert.strictEqual(await old.answer(), 'welcome');
    assert.strictEqual(old.welcome().locked, false);
    await old.next('need-snapshot');
    old.send({t: 'snapshot', seq: 0, data: fakeSb3('open project')});
    const expecting = new Client(server, 'open-again', 'Late', {expectLocked: true});
    assert.strictEqual(await expecting.answer(), 'welcome');
    assert.strictEqual(expecting.welcome().locked, false);
    for (const client of [keeper, member, old, expecting]) client.close();
});

test('new password rooms and password changes are limited per address; rooms without one and other addresses are not', async () => {
    const server = await startServer({TRUSTED_PROXY_HOPS: '1', ROOM_PASSWORD_HASHES_PER_MINUTE: '4'});
    const create = async (room, ip, password = 'make-pass') => {
        const client = new Client(server, room, 'Maker', {password}, from(ip));
        const answer = await client.answer();
        client.close();
        return answer;
    };
    // Ten new locked rooms at the same moment from one address: two at a time.
    const burst = [];
    for (let i = 0; i < 10; i++) burst.push(new Client(server, null, null, {}, from('10.0.2.1')));
    await Promise.all(burst.map(client => client.opened));
    burst.forEach((client, i) => client.hello(`burst-${i}`, 'Maker', {password: 'make-pass'}));
    const answers = await Promise.all(burst.map(client => client.answer()));
    assert.strictEqual(answers.filter(answer => answer === 'welcome').length, 2, answers.join());
    assert.strictEqual(answers.filter(answer => answer === 'busy').length, 8, answers.join());
    assert.strictEqual(burst[answers.indexOf('busy')].messages.find(m => m.t === 'error').message,
        'Too many room passwords were set from your network just now. Try again in a minute.');
    for (const client of burst) client.close();

    // ...and four a minute: two used.
    assert.strictEqual(await create('later-1', '10.0.2.1'), 'welcome');
    assert.strictEqual(await create('later-2', '10.0.2.1'), 'welcome');
    assert.strictEqual(await create('one-too-many', '10.0.2.1'), 'busy');
    // Rooms without a password cost nothing; other addresses have their own limit.
    assert.strictEqual(await create('open-room', '10.0.2.1', ''), 'welcome');
    assert.strictEqual(await create('other-address', '10.0.2.2'), 'welcome');

    // Password changes from that address count too. The person stays in the room.
    const changer = await openRoom(server, 'change-room', 'Changer', {}, 'change project', from('10.0.2.1'));
    changer.send({t: 'room-settings', password: 'new-pass'});
    const refused = await changer.next('error');
    assert.deepStrictEqual([refused.code, refused.for, refused.message], ['busy', 'room-settings',
        'Too many room passwords were set from your network just now. Try again in a minute.']);
    changer.send({t: 'ping'});
    assert.ok(await changer.next('pong'));
    assert.strictEqual(changer.count('room-info'), 0);
    // Joining an existing locked room from there is a check, not a new hash.
    const host = await openRoom(server, 'host-room', 'Host', {password: 'host-pass'}, 'host project', from('10.0.2.3'));
    assert.strictEqual(await create('host-room', '10.0.2.1', 'host-pass'), 'welcome');
    changer.close();
    host.close();
});

test('a flood of new password rooms never keeps people out of an existing locked room', async () => {
    const server = await startServer({TRUSTED_PROXY_HOPS: '1'});
    const owner = await openRoom(server, 'target', 'Owner', {password: 'right-pass'}, 'target project', from('10.0.3.1'));
    // Made-up rooms with a password, each from its own address (so no
    // per-address limit stops them), and then friends joining the real room.
    const flood = [];
    for (let i = 0; i < 80; i++) flood.push(new Client(server, null, null, {}, from(`10.0.4.${i}`)));
    const friends = [];
    for (let i = 0; i < 3; i++) friends.push(new Client(server, null, null, {}, from(`10.0.5.${i}`)));
    await Promise.all([...flood, ...friends].map(client => client.opened));
    const answeredAt = new Map();
    const answer = client => client.answer().then(result => {
        answeredAt.set(client, Date.now());
        return result;
    });
    flood.forEach((client, i) => client.hello(`junk-${i}`, 'X', {password: 'junk-pass'}));
    friends.forEach(client => client.hello('target', 'Friend', {password: 'right-pass'}));
    const [floodAnswers, friendAnswers] = await Promise.all([Promise.all(flood.map(answer)), Promise.all(friends.map(answer))]);

    assert.deepStrictEqual(friendAnswers, ['welcome', 'welcome', 'welcome']);
    for (const friend of friends) assert.strictEqual(projectText((await friend.next('snapshot')).data), 'target project');
    // New rooms may only use part of the password work (4 running, 16 waiting).
    assert.ok(floodAnswers.every(result => result === 'welcome' || result === 'busy'), floodAnswers.join());
    assert.ok(floodAnswers.filter(result => result === 'busy').length >= 40, floodAnswers.join());
    // The friends' checks went ahead of the new rooms still waiting.
    const lastFriend = Math.max(...friends.map(friend => answeredAt.get(friend)));
    const lastNewRoom = Math.max(...flood.filter((client, i) => floodAnswers[i] === 'welcome').map(client => answeredAt.get(client)));
    assert.ok(lastFriend < lastNewRoom, `friends in after ${lastFriend - lastNewRoom} ms relative to the last new room`);
    for (const client of [owner, ...flood, ...friends]) client.close();
    assert.ok(server.alive());
});

test('refused hellos do not make the server read a room from disk again and again', async () => {
    const first = await startServer();
    const owner = await openRoom(first, 'big-locked', 'Owner', {password: 'right-pass'}, 'big project');
    owner.close();
    await owner.closed;
    await first.stop();
    const server = await startServer({DATA_DIR: first.dataDir, EMPTY_ROOM_KEEP_MS: '1500', TRUSTED_PROXY_HOPS: '1',
        ROOM_PASSWORD_TRIES_PER_IP: '2'});
    const loads = () => (server.output().match(/\[big-locked\] loaded from disk/g) || []).length;
    const tryJoin = async (ip, extra = {}) => {
        const client = new Client(server, 'big-locked', 'Visitor', extra, from(ip));
        const answer = await client.answer();
        client.close();
        return answer;
    };
    for (let i = 0; i < 5; i++) assert.strictEqual(await tryJoin('10.0.6.1'), 'password-needed');
    assert.strictEqual(loads(), 1, 'read once, then kept a little while');
    assert.strictEqual((await server.health()).rooms, 1);
    for (let i = 0; i < 2; i++) assert.strictEqual(await tryJoin('10.0.6.1', {password: `wrong-${i}`}), 'wrong-password');
    assert.strictEqual(loads(), 1);

    // Forgotten a little later, like a room everyone left.
    await waitFor(() => server.output().includes('[big-locked] empty, saved and closed'), 'the room to close');
    assert.strictEqual((await server.health()).rooms, 0);
    // That address is over its limit. The room is read once more (only then
    // can the server see it still has a password) and kept a while again.
    for (let i = 0; i < 3; i++) assert.strictEqual(await tryJoin('10.0.6.1', {password: 'right-pass'}), 'too-many-tries');
    assert.strictEqual(loads(), 2);
    assert.strictEqual((await server.health()).rooms, 1);
    // Anyone else gets in as usual.
    assert.strictEqual(await tryJoin('10.0.6.2', {password: 'right-pass'}), 'welcome');
    assert.strictEqual(loads(), 2);
});

test('wrong guesses at a room whose password was then removed never keep people out of it, in memory or not', async () => {
    const server = await startServer({ROOM_PASSWORD_TRIES_PER_IP: '3', ROOM_PASSWORD_TRIES_PER_ROOM: '3', EMPTY_ROOM_KEEP_MS: '300'});
    const owner = await openRoom(server, 'unlocked-later', 'Owner', {password: 'secret-pass'}, 'unlocked project');
    for (let i = 0; i < 3; i++) {
        assert.strictEqual(await new Client(server, 'unlocked-later', 'Guesser', {password: `guess-${i}`}).answer(), 'wrong-password');
    }
    assert.strictEqual(await new Client(server, 'unlocked-later', 'Friend', {password: 'secret-pass'}).answer(), 'too-many-tries');
    owner.send({t: 'room-settings', password: null});
    await owner.next('room-info', m => m.changed === 'password-removed');
    const inMemory = new Client(server, 'unlocked-later', 'Friend');
    assert.strictEqual(await inMemory.answer(), 'welcome');
    await inMemory.next('caught-up');
    inMemory.close();
    owner.close();
    await waitFor(() => server.output().includes('[unlocked-later] empty, saved and closed'), 'the room to close');
    assert.strictEqual((await server.health()).rooms, 0);
    const later = new Client(server, 'unlocked-later', 'Friend');
    assert.strictEqual(await later.answer(), 'welcome');
    assert.strictEqual(later.welcome().locked, false);
    assert.strictEqual(projectText((await later.next('snapshot')).data), 'unlocked project');
    later.close();
});

test('a password whose settings could not be saved is saved with the next save', async () => {
    const server = await startServer();
    const owner = await openRoom(server, 'fragile', 'Owner', {}, 'fragile project');
    // The settings file can't be written for a moment (a directory is in its way).
    const json = path.join(server.dataDir, 'fragile.json');
    fs.rmSync(json);
    fs.mkdirSync(json);
    owner.send({t: 'room-settings', password: 'secret-pass'});
    assert.strictEqual((await owner.next('room-info')).locked, true);
    await waitFor(() => server.output().includes('could not save room settings'), 'the failed save');
    fs.rmdirSync(json);
    // The next edit saves everything again, the settings included.
    owner.send({t: 'op', ref: 1, op: {kind: 'blocks', n: 1}});
    await owner.next('ack');
    await waitFor(() => fs.existsSync(json) && /scrypt\$/.test(fs.readFileSync(json, 'utf8')), 'the settings to be saved');
    owner.close();
    await owner.closed;
    await server.stop();

    const again = await startServer({DATA_DIR: server.dataDir});
    const stranger = new Client(again, 'fragile', 'Stranger');
    assert.strictEqual(await stranger.answer(), 'password-needed');
    const friend = new Client(again, 'fragile', 'Friend', {password: 'secret-pass'});
    assert.strictEqual(await friend.answer(), 'welcome');
    assert.strictEqual(projectText((await friend.next('snapshot')).data), 'fragile project');
    friend.close();
});
