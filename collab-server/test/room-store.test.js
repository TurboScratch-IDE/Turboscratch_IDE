'use strict';

/**
 * Saved rooms must come back correctly whatever moment the server stopped,
 * and a damaged file must never cost the room its project.
 */

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {RoomStore, nestingTooDeep} = require('../room-store');

const project = text => Buffer.from(`PK\u0003\u0004${text}`);
const text = buffer => buffer.toString().slice(4);
const quiet = () => {};

const newStore = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-store-'));
    return {dir, store: new RoomStore(dir, quiet), file: name => path.join(dir, name)};
};

const room = (id, snapshotSeq, ops, extra = {}) => Object.assign({
    id,
    snapshot: project(`at ${snapshotSeq}`),
    snapshotSeq,
    snapshotHash: `hash-${snapshotSeq}`,
    ops,
    listed: true,
    title: 'My game',
    createdAt: 1234
}, extra);

const op = (seq, n = seq) => ({seq, from: 'someone', op: {kind: 'blocks', n}, bytes: 10});

test('a saved room loads back exactly, with appended edits', () => {
    const {store} = newStore();
    const r = room('r1', 3, [op(4), op(5)]);
    r.snapshotFile = store.saveSnapshot(r);
    store.appendOps(r, [op(6), op(7)]);
    const loaded = store.load('r1', 100);
    assert.strictEqual(text(loaded.snapshot), 'at 3');
    assert.strictEqual(loaded.snapshotSeq, 3);
    assert.strictEqual(loaded.snapshotHash, 'hash-3');
    assert.deepStrictEqual(loaded.ops.map(o => o.seq), [4, 5, 6, 7]);
    assert.strictEqual(loaded.seq, 7);
    assert.strictEqual(loaded.listed, true);
    assert.strictEqual(loaded.title, 'My game');
    assert.strictEqual(loaded.needsRewrite, false);
});

test('a new snapshot replaces the old files', () => {
    const {store, dir} = newStore();
    store.saveSnapshot(room('r2', 3, [op(4)]));
    store.saveSnapshot(room('r2', 4, []));
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['r2.4.sb3', 'r2.json', 'r2.ops']);
    assert.strictEqual(store.load('r2', 100).snapshotSeq, 4);
});

test('stopped after writing a new snapshot but before the settings: the newer snapshot is used, nothing twice', () => {
    const {store, file} = newStore();
    store.saveSnapshot(room('r3', 3, [op(4), op(5)]));
    store.appendOps({id: 'r3'}, [op(6)]);
    // The new snapshot at 5 reached the disk, then the server stopped.
    fs.writeFileSync(file('r3.5.sb3'), project('at 5'));
    const loaded = store.load('r3', 100);
    assert.strictEqual(text(loaded.snapshot), 'at 5');
    assert.strictEqual(loaded.snapshotSeq, 5);
    assert.deepStrictEqual(loaded.ops.map(o => o.seq), [6]);
    // The fingerprint belonged to the older snapshot, so it isn't used.
    assert.strictEqual(loaded.snapshotHash, null);
    assert.strictEqual(loaded.needsRewrite, true);
});

test('a damaged settings file keeps the project and its edits, and a copy of the damaged file', () => {
    const {store, file, dir} = newStore();
    store.saveSnapshot(room('r4', 2, [op(3)]));
    fs.writeFileSync(file('r4.json'), '{"snapshotFile": "r4.2.sb3", "list');
    const loaded = store.load('r4', 100);
    assert.strictEqual(text(loaded.snapshot), 'at 2');
    assert.deepStrictEqual(loaded.ops.map(o => o.seq), [3]);
    assert.strictEqual(loaded.listed, false, 'a room comes back private when its settings are lost');
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith('r4.json.damaged-')));
});

test('settings with wrong types are ignored safely', () => {
    const {store, file} = newStore();
    store.saveSnapshot(room('r5', 1, []));
    fs.writeFileSync(file('r5.json'), JSON.stringify({snapshotFile: 'r5.1.sb3', seq: 'abc', ops: 'oops', listed: 'yes',
        title: 42, createdAt: 'now', snapshotHash: {x: 1}}));
    const loaded = store.load('r5', 100);
    assert.strictEqual(loaded.seq, 1);
    assert.deepStrictEqual(loaded.ops, []);
    assert.strictEqual(loaded.listed, false);
    assert.strictEqual(loaded.title, null);
    assert.strictEqual(loaded.createdAt, null);
    assert.strictEqual(loaded.snapshotHash, null);
});

test('a half-written last edit (crash while appending) is ignored; edits after a gap are not applied', () => {
    const {store, file} = newStore();
    store.saveSnapshot(room('r6', 0, [op(1), op(2)]));
    fs.appendFileSync(file('r6.ops'), `${JSON.stringify(op(4))}\n{"seq":5,"op":{"ki`);
    const loaded = store.load('r6', 100);
    assert.deepStrictEqual(loaded.ops.map(o => o.seq), [1, 2]);
    assert.strictEqual(loaded.seq, 2);
});

test('broken edit entries are skipped (no op, too deep, duplicates)', () => {
    const {store, file} = newStore();
    store.saveSnapshot(room('r7', 0, [op(1)]));
    let deep = {};
    for (let i = 0; i < 200; i++) deep = {a: deep};
    fs.appendFileSync(file('r7.ops'), [
        JSON.stringify(op(1, 'duplicate')),
        JSON.stringify({seq: 2}),
        JSON.stringify({seq: 2, from: 'x', op: deep}),
        JSON.stringify(op(2))
    ].join('\n') + '\n');
    const loaded = store.load('r7', 100);
    assert.deepStrictEqual(loaded.ops.map(o => [o.seq, o.op.n]), [[1, 1], [2, 2]]);
});

test('a snapshot file that is empty or not a project is moved aside', () => {
    const {store, file, dir} = newStore();
    store.saveSnapshot(room('r8', 0, []));
    fs.writeFileSync(file('r8.0.sb3'), '');
    const loaded = store.load('r8', 100);
    assert.strictEqual(loaded.snapshot, null);
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith('r8.0.sb3.damaged-')));
});

test('an older, still readable snapshot is used when the newest one is damaged', () => {
    const {store, file} = newStore();
    store.saveSnapshot(room('r9', 2, [op(3)]));
    fs.writeFileSync(file('r9.3.sb3'), 'garbage');
    const loaded = store.load('r9', 100);
    assert.strictEqual(loaded.snapshotSeq, 2);
    assert.deepStrictEqual(loaded.ops.map(o => o.seq), [3]);
});

test('rooms saved by older versions (<room>.sb3 with edits in the .json) still load', () => {
    const {store, file} = newStore();
    fs.writeFileSync(file('old.sb3'), project('old project'));
    fs.writeFileSync(file('old.json'), JSON.stringify({version: 1, snapshotSeq: 4, snapshotHash: 'h', seq: 6,
        ops: [op(5), op(6)], listed: true, title: 'Old'}));
    const loaded = store.load('old', 100);
    assert.strictEqual(text(loaded.snapshot), 'old project');
    assert.strictEqual(loaded.snapshotSeq, 4);
    assert.strictEqual(loaded.snapshotHash, 'h');
    assert.deepStrictEqual(loaded.ops.map(o => o.seq), [5, 6]);
    assert.strictEqual(loaded.needsRewrite, true);

    // Rewritten in the new form, with the old files removed.
    store.saveSnapshot(Object.assign({id: 'old'}, loaded));
    assert.ok(!fs.existsSync(file('old.sb3')));
    const again = store.load('old', 100);
    assert.deepStrictEqual(again.ops.map(o => o.seq), [5, 6]);
    assert.strictEqual(again.needsRewrite, false);
});

test('rooms nobody used for a long time are deleted, open rooms and the accounts database are kept', () => {
    const {store, file, dir} = newStore();
    store.saveSnapshot(room('stale', 0, []));
    store.saveSnapshot(room('open', 0, []));
    store.saveSnapshot(room('fresh', 0, []));
    fs.writeFileSync(file('community.sqlite'), 'accounts');
    fs.writeFileSync(file('stale.json.123.tmp'), 'left by a crash');
    const old = (Date.now() - 100 * 24 * 60 * 60 * 1000) / 1000;
    for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('fresh')) fs.utimesSync(file(name), old, old);
    }
    const deleted = store.deleteUnused(90 * 24 * 60 * 60 * 1000, id => id === 'open');
    assert.strictEqual(deleted, 1);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [
        'community.sqlite', 'fresh.0.sb3', 'fresh.json', 'fresh.ops', 'open.0.sb3', 'open.json', 'open.ops'
    ]);
});

test('used space counts only room files', () => {
    const {store, file} = newStore();
    fs.writeFileSync(file('community.sqlite'), Buffer.alloc(5000));
    store.saveSnapshot(room('a', 0, []));
    const bytes = store.usedBytes();
    assert.ok(bytes > 0 && bytes < 5000, String(bytes));
});

test('after a cut-off or damaged edit line, the edit file is rewritten before anything is added', () => {
    const {store, file, dir} = newStore();
    store.saveSnapshot(room('t1', 0, [op(1)]));
    fs.appendFileSync(file('t1.ops'), '{"seq":2,"op":{"ki');
    assert.strictEqual(store.load('t1', 100).needsRewrite, true);

    store.saveSnapshot(room('t2', 0, [op(1)]));
    fs.appendFileSync(file('t2.ops'), `garbage\n${JSON.stringify(op(2))}\n`);
    const loaded = store.load('t2', 100);
    assert.strictEqual(loaded.needsRewrite, true);
    assert.deepStrictEqual(loaded.ops.map(o => o.seq), [1]);
    // The edits after the damage are kept in a copy for the server owner.
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith('t2.ops.damaged-')));

    store.saveSnapshot(room('t3', 0, [op(1)]));
    fs.appendFileSync(file('t3.ops'), `${JSON.stringify(op(3))}\n`);
    assert.strictEqual(store.load('t3', 100).needsRewrite, true, 'an edit after a gap');
});

test('files that cannot be read right now make loading fail without touching anything', () => {
    const {store, file, dir} = newStore();
    store.saveSnapshot(room('busy', 2, [op(3)]));
    const before = fs.readdirSync(dir).sort();
    fs.renameSync(file('busy.json'), file('busy.json.real'));
    fs.mkdirSync(file('busy.json'));
    assert.throws(() => store.load('busy', 100), e => e.temporary === true);
    fs.rmdirSync(file('busy.json'));
    fs.renameSync(file('busy.json.real'), file('busy.json'));

    fs.renameSync(file('busy.2.sb3'), file('busy.2.sb3.real'));
    fs.mkdirSync(file('busy.2.sb3'));
    assert.throws(() => store.load('busy', 100), e => e.temporary === true);
    fs.rmdirSync(file('busy.2.sb3'));
    fs.renameSync(file('busy.2.sb3.real'), file('busy.2.sb3'));

    assert.deepStrictEqual(fs.readdirSync(dir).sort(), before);
    assert.strictEqual(text(store.load('busy', 100).snapshot), 'at 2');
});

test('a touched room counts as used', () => {
    const {store, file} = newStore();
    store.saveSnapshot(room('used', 0, []));
    const old = (Date.now() - (100 * 24 * 60 * 60 * 1000)) / 1000;
    for (const name of ['used.0.sb3', 'used.json', 'used.ops']) fs.utimesSync(file(name), old, old);
    store.touch('used');
    assert.strictEqual(store.deleteUnused(90 * 24 * 60 * 60 * 1000, () => false), 0);
});

test('nesting check: exact limit, and quick for huge flat values', () => {
    const nest = levels => {
        let value = 1;
        for (let i = 0; i < levels; i++) value = [value];
        return value;
    };
    assert.strictEqual(nestingTooDeep(nest(100), 100), false);
    assert.strictEqual(nestingTooDeep(nest(101), 100), true);
    assert.strictEqual(nestingTooDeep({a: [{b: nest(98)}]}, 100), true);
    assert.strictEqual(nestingTooDeep({a: [{b: nest(97)}]}, 100), false);
    assert.strictEqual(nestingTooDeep(5, 100), false);
    const wide = new Array(5000000).fill(0);
    wide.push({deep: nest(200)});
    const started = Date.now();
    assert.strictEqual(nestingTooDeep(wide, 100), true);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('a room password hash is saved with the settings and loads back; rooms without one have none', () => {
    const {store, file} = newStore();
    const hash = `scrypt$16384$8$1$${'s'.repeat(24)}$${'k'.repeat(88)}`;
    const locked = room('locked', 2, [op(3)], {passwordHash: hash});
    locked.snapshotFile = store.saveSnapshot(locked);
    assert.strictEqual(store.load('locked', 100).passwordHash, hash);
    assert.strictEqual(JSON.parse(fs.readFileSync(file('locked.json'), 'utf8')).passwordHash, hash);

    // Changed or removed later: only the settings file is written.
    locked.passwordHash = null;
    store.saveSettings(locked, locked.snapshotFile);
    assert.strictEqual(store.load('locked', 100).passwordHash, null);
    assert.strictEqual(JSON.parse(fs.readFileSync(file('locked.json'), 'utf8')).passwordHash, null);
    locked.passwordHash = hash;
    store.saveSettings(locked, locked.snapshotFile);
    assert.strictEqual(store.load('locked', 100).passwordHash, hash);

    // A room saved without the field, or by a version from before room passwords.
    store.saveSnapshot(room('open', 0, []));
    assert.strictEqual(store.load('open', 100).passwordHash, null);
    fs.writeFileSync(file('open.json'), JSON.stringify({version: 2, snapshotFile: 'open.0.sb3', snapshotSeq: 0,
        listed: false, title: 'Old room', createdAt: 1}));
    assert.strictEqual(store.load('open', 100).passwordHash, null);
});

test('anything that is not a server-made password hash counts as no password', () => {
    const {store, file} = newStore();
    store.saveSnapshot(room('weird', 0, []));
    const settings = JSON.parse(fs.readFileSync(file('weird.json'), 'utf8'));
    for (const value of [42, true, {hash: 'scrypt$x'}, ['scrypt$x'], 'hunter22', '', 'SCRYPT$1$2$3$4$5',
        `scrypt$${'x'.repeat(300)}`]) {
        fs.writeFileSync(file('weird.json'), JSON.stringify({...settings, passwordHash: value}));
        assert.strictEqual(store.load('weird', 100).passwordHash, null, JSON.stringify(value).slice(0, 40));
    }
    const longest = `scrypt$${'x'.repeat(293)}`;
    fs.writeFileSync(file('weird.json'), JSON.stringify({...settings, passwordHash: longest}));
    assert.strictEqual(store.load('weird', 100).passwordHash, longest);
});

const HASH = `scrypt$16384$8$1$${'s'.repeat(24)}$${'k'.repeat(88)}`;

/** Runs `save` and returns the files it wrote, in order; `stopAt` acts like a crash just before that file. */
const writeOrder = (save, stopAt = null) => {
    const order = [];
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (path.basename(to) === stopAt) throw new Error('the server stopped');
        order.push(path.basename(to));
        return rename(from, to);
    };
    try {
        save();
    } catch (e) {
        if (e.message !== 'the server stopped') throw e;
    } finally {
        fs.renameSync = rename;
    }
    return order;
};

test('the settings are written before a new snapshot, so a locked room\'s project is never on disk without its password', () => {
    const {store, file, dir} = newStore();
    assert.deepStrictEqual(writeOrder(() => store.saveSnapshot(room('first', 0, [], {passwordHash: HASH}))),
        ['first.json', 'first.0.sb3', 'first.ops']);
    assert.deepStrictEqual(writeOrder(() => store.saveSnapshot(room('first', 3, [op(4)], {passwordHash: HASH}))),
        ['first.json', 'first.3.sb3', 'first.ops']);

    // Stopped right after the settings of a room's first snapshot: nothing to restore, as before.
    assert.deepStrictEqual(writeOrder(() => store.saveSnapshot(room('crash1', 0, [], {passwordHash: HASH})), 'crash1.0.sb3'),
        ['crash1.json']);
    const empty = store.load('crash1', 100);
    assert.strictEqual(empty.snapshot, null);
    assert.strictEqual(empty.passwordHash, null);

    // A password was just set, and the server stopped after the new settings
    // (which name a snapshot that never made it to disk): the older snapshot
    // and its edits are used, and the room keeps the new password.
    store.saveSnapshot(room('crash2', 2, [op(3)]));
    assert.deepStrictEqual(writeOrder(() => store.saveSnapshot(room('crash2', 5, [], {passwordHash: HASH})), 'crash2.5.sb3'),
        ['crash2.json']);
    assert.strictEqual(JSON.parse(fs.readFileSync(file('crash2.json'), 'utf8')).snapshotFile, 'crash2.5.sb3');
    const loaded = store.load('crash2', 100);
    assert.strictEqual(text(loaded.snapshot), 'at 2');
    assert.strictEqual(loaded.snapshotSeq, 2);
    assert.deepStrictEqual(loaded.ops.map(o => o.seq), [3]);
    assert.strictEqual(loaded.passwordHash, HASH);
    assert.strictEqual(loaded.snapshotHash, null, 'the fingerprint was for the snapshot that is missing');
    assert.strictEqual(loaded.needsRewrite, true);
    assert.ok(!fs.readdirSync(dir).some(name => name.startsWith('crash2') && name.includes('damaged')));

    // A room saved by an older version keeps its settings (which hold its
    // edits) until the new files are there.
    fs.writeFileSync(file('old.sb3'), project('old project'));
    fs.writeFileSync(file('old.json'), JSON.stringify({version: 1, snapshotSeq: 4, ops: [op(5)], listed: true}));
    const old = store.load('old', 100);
    assert.deepStrictEqual(writeOrder(() => store.saveSnapshot(Object.assign({id: 'old'}, old))),
        ['old.4.sb3', 'old.ops', 'old.json']);
});

test('damaged settings keep the room\'s password when its hash can still be read', () => {
    const {store, file, dir} = newStore();
    store.saveSnapshot(room('salvage', 2, [op(3)], {passwordHash: HASH}));
    const settings = fs.readFileSync(file('salvage.json'), 'utf8');
    // The end of the file is lost: no longer JSON, but the hash is all there.
    fs.writeFileSync(file('salvage.json'), settings.slice(0, -20));
    const loaded = store.load('salvage', 100);
    assert.strictEqual(loaded.passwordHash, HASH);
    assert.strictEqual(text(loaded.snapshot), 'at 2');
    assert.deepStrictEqual(loaded.ops.map(o => o.seq), [3]);
    assert.strictEqual(loaded.needsRewrite, true);
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith('salvage.json.damaged-')));
    // Written back with the next save.
    store.saveSnapshot(Object.assign({id: 'salvage'}, loaded));
    assert.strictEqual(JSON.parse(fs.readFileSync(file('salvage.json'), 'utf8')).passwordHash, HASH);

    // Damaged somewhere else, with the hash still whole.
    fs.writeFileSync(file('salvage.json'), `garbage${settings.slice(1)}`);
    assert.strictEqual(store.load('salvage', 100).passwordHash, HASH);

    // A damaged file that shows the room had no password.
    store.saveSnapshot(room('open', 0, []));
    const openSettings = fs.readFileSync(file('open.json'), 'utf8');
    assert.ok(openSettings.startsWith('{"version":2,"passwordHash":null,'), openSettings);
    fs.writeFileSync(file('open.json'), openSettings.slice(0, 40));
    assert.strictEqual(store.load('open', 100).passwordHash, null);
    assert.strictEqual(text(store.load('open', 100).snapshot), 'at 0');
});

test('settings cut off inside the password hash: the room is not opened, and the file is kept as it is', () => {
    const {store, file, dir} = newStore();
    store.saveSnapshot(room('cut', 2, [op(3)], {passwordHash: HASH}));
    const settings = fs.readFileSync(file('cut.json'), 'utf8');
    for (const length of [28, 40, 60, 150]) {
        const damaged = settings.slice(0, length);
        fs.writeFileSync(file('cut.json'), damaged);
        assert.throws(() => store.load('cut', 100), /password hash can't be read; fix or remove cut\.json/, String(length));
        assert.strictEqual(fs.readFileSync(file('cut.json'), 'utf8'), damaged);
    }
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['cut.2.sb3', 'cut.json', 'cut.ops']);
    // Without a project there's nothing to protect: the room is new.
    fs.renameSync(file('cut.2.sb3'), file('elsewhere.bin'));
    assert.strictEqual(store.load('cut', 100).snapshot, null);

    // Settings too short to say anything, or missing (deleted by hand): the
    // room opens with default settings, without a password, like rooms
    // saved before room passwords existed.
    store.saveSnapshot(room('short', 0, [], {passwordHash: HASH}));
    fs.writeFileSync(file('short.json'), '{"version":2,"pass');
    assert.strictEqual(store.load('short', 100).passwordHash, null);
    store.saveSnapshot(room('gone', 0, [], {passwordHash: HASH}));
    fs.renameSync(file('gone.json'), file('elsewhere.json'));
    const gone = store.load('gone', 100);
    assert.strictEqual(text(gone.snapshot), 'at 0');
    assert.strictEqual(gone.passwordHash, null);
});
