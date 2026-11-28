/**
 * TurboScratch IDE collaboration server.
 *
 * Copyright (C) 2026 TurboScratch IDE contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * How it works
 * ------------
 * Everyone who opens the same "room" edits the same project.
 *
 *  - The server keeps a snapshot of the room's project (an .sb3 file) plus a
 *    log of every edit ("op") made since that snapshot. Each op gets a
 *    sequence number so every client applies edits in the same order.
 *  - A new person joining the room receives the snapshot and then all the ops
 *    that came after it, so they end up with exactly the same project.
 *  - Every so often the server asks one of the people in the room for a fresh
 *    snapshot so the op log stays short.
 *  - Snapshots and op logs are saved in ./data so rooms survive a restart
 *    (see room-store.js).
 *
 * The server is meant to be safe to put on the internet: one person must not
 * be able to crash it, fill its memory or disk, or break other rooms.
 */

'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const {WebSocketServer} = require('ws');
// Settings such as ANTHROPIC_API_KEY can live in a .env file next to this one
// (never committed: see .gitignore).
try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
    // no .env file
}
const {openDatabase} = require('./community/db');
const {createCommunityApi} = require('./community/api');
const {hashPassword, verifyPassword, clientIp, RateLimiter} = require('./community/auth');
const {RoomStore, isProjectFile, nestingTooDeep} = require('./room-store');

const numberSetting = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 && process.env[name] !== '' ? value : fallback;
};

const PORT = numberSetting('PORT', 8090);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 200 * 1024 * 1024;
const MAX_CLIENTS_PER_ROOM = 32;
const SNAPSHOT_IDLE_MS = Number(process.env.SNAPSHOT_IDLE_MS) || 3000;
const SNAPSHOT_MAX_OPS = 150;
const SNAPSHOT_MAX_OP_BYTES = 24 * 1024 * 1024;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 30000;
const HEARTBEAT_MS = 30000;
// New edits are added to the room's file on disk this soon after they happen.
const OPS_FLUSH_DELAY_MS = 200;
// Hard limits on edits waiting for a snapshot (normally one is asked for after
// SNAPSHOT_MAX_OPS edits). Once a room is past either limit, new edits are
// refused until someone in it has saved the project.
const MAX_OP_LOG_OPS = numberSetting('MAX_OP_LOG_OPS', 10000) || 10000;
const MAX_OP_LOG_BYTES = (numberSetting('MAX_OP_LOG_MB', 100) || 100) * 1024 * 1024;
// No real edit is nested anywhere near this deep.
const MAX_OP_DEPTH = 100;
// "Send me the whole project again" is answered at most this often per person.
const RESYNC_MIN_INTERVAL_MS = 5000;
// When this much data is already waiting to be sent, new people joining big
// rooms are asked to try again in a moment (protects the server's memory).
const MAX_PENDING_SEND_BYTES = numberSetting('MAX_PENDING_SEND_MB', 256) * 1024 * 1024;
// A connection with this much data waiting to be sent to it isn't reading
// (a full project plus every edit after it fits easily): it is closed, so it
// can't make the server hold on to more and more memory.
const MAX_CLIENT_BACKLOG_BYTES = 2 * MAX_MESSAGE_BYTES + 128 * 1024 * 1024;
// How long the room's project stays ready to send after it was last sent.
const STATE_CACHE_MS = 60000;
// An empty room stays in memory this long, so people reconnecting or
// reloading the page don't make the server read it from disk again.
const EMPTY_ROOM_KEEP_MS = numberSetting('EMPTY_ROOM_KEEP_MS', 30000);
// A connection must say which room it wants within this time.
const HELLO_TIMEOUT_MS = numberSetting('HELLO_TIMEOUT_MS', 30000) || 30000;
// How long people wait for a new room's first project before being told.
const FIRST_SNAPSHOT_TIMEOUT_MS = numberSetting('FIRST_SNAPSHOT_TIMEOUT_MS', 180000);
// ...unless it is still arriving: they wait longer while at least this much
// more of it comes in every UPLOAD_PROGRESS_CHECK_MS (big project, slow Wi-Fi).
const UPLOAD_PROGRESS_BYTES = 16 * 1024;
const UPLOAD_PROGRESS_CHECK_MS = 30000;
// How long a room creator whose connection dropped gets to come back before
// someone else is asked to provide the project.
const CREATOR_GRACE_MS = numberSetting('CREATOR_GRACE_MS', 15000);
// Rooms nobody has opened for this many days are deleted (0 = keep forever).
const ROOM_EXPIRE_DAYS = numberSetting('ROOM_EXPIRE_DAYS', 90);
// No new rooms are created while room files use more than this (0 = no limit).
const MAX_ROOM_STORAGE_BYTES = numberSetting('MAX_ROOM_STORAGE_MB', 2048) * 1024 * 1024;
// Optional: comma-separated list of web page origins allowed to connect,
// e.g. ALLOWED_ORIGINS=https://turboscratch-ide.github.io,http://localhost:8601
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim())
    .filter(Boolean);
// The TurboScratch desktop app shows the editor from its own tsc-app://editor
// pages, so it is always let in, even when ALLOWED_ORIGINS is set. That is
// safe: browsers set the Origin header from the page's real address, and no
// website can have a tsc-app:// one. Programs that aren't browsers could send
// any Origin anyway (also the website's), so the list never stopped them.
// Room access is checked inside the messages (room code, password), not by
// cookies, so a page that gets in here gains nothing else.
// Never let 'null' in: sandboxed frames and data: pages on ANY website send that.
const DESKTOP_APP_ORIGIN = 'tsc-app://editor';
const MAX_NAME_LENGTH = 24;
const MAX_CHAT_LENGTH = 500;
const MAX_TITLE_LENGTH = 60;
const MAX_LISTED_ROOMS = 100;
const MAX_LISTED_NAMES = 5;
// Room passwords. Only a salted hash of a password is kept (see auth.js).
const MIN_ROOM_PASSWORD_LENGTH = 4;
const MAX_ROOM_PASSWORD_LENGTH = 100;
// Wrong room passwords allowed per room and address, and per room from
// everyone, in PASSWORD_TRIES_WINDOW_MS. Everyone behind the same tunnel or
// school network shares one address, so the first limit can't be tiny.
const PASSWORD_TRIES_WINDOW_MS = 10 * 60 * 1000;
const PASSWORD_TRIES_PER_IP = numberSetting('ROOM_PASSWORD_TRIES_PER_IP', 10) || 10;
const PASSWORD_TRIES_PER_ROOM = numberSetting('ROOM_PASSWORD_TRIES_PER_ROOM', 30) || 30;
// Checking or hashing a room password (scrypt) is slow and uses 16 MB on
// purpose. At most this many run at once; at most this many more wait for
// their turn (a class joining at the same moment), the rest are told to retry.
const MAX_PASSWORD_WORK_AT_ONCE = 8;
const MAX_PASSWORD_WORK_WAITING = 64;
// Hashing a new password (a new locked room, or a password change) may only
// use part of that: a hello costs nothing but a new connection, so without
// this anyone could keep every slot busy with made-up rooms, and nobody could
// join an existing locked room. Checks for those always go first.
const MAX_PASSWORD_HASHES_AT_ONCE = 4;
const MAX_PASSWORD_HASHES_WAITING = 16;
// ...and one address can have only this many running or waiting at once, and
// start only so many a minute (a whole class shares one address, so a few).
const MAX_PASSWORD_HASHES_PER_ADDRESS = 2;
const PASSWORD_HASHES_PER_MINUTE = numberSetting('ROOM_PASSWORD_HASHES_PER_MINUTE', 10) || 10;
// Checks get a share per address too: right passwords are never counted as
// tries, so without it one address could keep every slot and waiting place
// busy by joining its own locked room over and over, and nobody else could
// join theirs. A whole class shares one address, so this can't be tiny.
const MAX_PASSWORD_CHECKS_PER_ADDRESS = numberSetting('ROOM_PASSWORD_CHECKS_PER_ADDRESS', 16) || 16;
// Checks may never use this many of the running slots: a new password (a
// new locked room, a password change) always has one to start in.
const PASSWORD_SLOTS_ONLY_FOR_HASHING = 1;
// A room's password can change while someone's password is being checked:
// then it's checked again, at most this many more times.
const MAX_PASSWORD_RECHECKS = 3;
// How often one person can set or remove the room's password.
const MAX_PASSWORD_CHANGES_PER_MINUTE = 10;
// Someone let into a room whose connection then drops can come back with the
// resume token from their welcome without the password (it may have changed
// while they were in the room, or they never typed it), for this long, while
// the room is in memory, and while its password is still the one it had when
// they dropped. Only the last ones per room are kept.
const DROPPED_MEMBER_KEEP_MS = numberSetting('DROPPED_MEMBER_KEEP_MS', 6 * 60 * 60 * 1000);
const MAX_DROPPED_MEMBERS_PER_ROOM = 200;
// ...and at most this many from one address (a whole class shares one), so
// one address can't keep lots of them or push out everyone else's.
const MAX_DROPPED_MEMBERS_PER_ADDRESS = MAX_CLIENTS_PER_ROOM;
// After the password changes, the old password the editor of someone who
// dropped out of the locked room still sends isn't counted as guessing. Only
// this many such checks per room and password (as many people as can be in
// a room) are free: tokens saved up by joining and dropping again and again
// give no more than that, and the rest count like anyone's.
const MAX_UNCOUNTED_CHECKS_PER_PASSWORD = MAX_CLIENTS_PER_ROOM;
// The close code the editor uses when it closes a connection in order to
// connect again (it looked dead). Leave is a plain close.
const CLOSE_RECONNECTING = 4000;

const COLORS = [
    '#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8',
    '#ff922b', '#22b8cf', '#f06595', '#94d82d', '#845ef7'
];

const log = (...args) => {
    if (process.env.QUIET) return;
    // eslint-disable-next-line no-console
    console.log(new Date().toISOString(), ...args);
};

const store = new RoomStore(DATA_DIR, log);

/** @type {Map<string, Room>} */
const rooms = new Map();

const sanitizeRoomId = raw => {
    if (typeof raw !== 'string') return null;
    const id = raw.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) return null;
    return id;
};

/** Cuts text to at most `max` characters without leaving half an emoji. */
const clip = (text, max) => {
    if (text.length <= max) return text;
    const last = text.charCodeAt(max - 1);
    return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
};

// Always removed: control characters, zero-width spaces and characters that
// hide or reorder text. (Zero-width joiners stay: emoji like 👩‍💻 and many
// Persian or Indian names need them.)
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
const DIRECTION_CHARACTERS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Blank-looking characters taken off the start and end of names and titles.
const BLANK = '\\s\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200d\\u2060-\\u2064\\u2800\\u3164\\uffa0';
const BLANK_EDGES = new RegExp(`^[${BLANK}]+|[${BLANK}]+$`, 'gu');
// Text made only of these shows nothing, or only empty space.
const NOTHING_VISIBLE = /^[\s\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Z}\u2800\u3164\u115f\u1160\uffa0]*$/u;
const hasVisibleText = text => !NOTHING_VISIBLE.test(text);

/** A name or title: cleaned, cut to `max` characters, '' if nothing visible is left. */
const cleanLabel = (raw, max) => {
    const text = clip(clip(raw, 1000).replace(HIDDEN_CHARACTERS, '').replace(BLANK_EDGES, ''), max)
        .replace(BLANK_EDGES, '');
    return hasVisibleText(text) ? text : '';
};

const sanitizeName = raw => (typeof raw === 'string' && cleanLabel(raw, MAX_NAME_LENGTH)) || 'Guest';

/** A room's title for the room list (the creator's project name). */
const sanitizeTitle = raw => (typeof raw === 'string' && cleanLabel(raw, MAX_TITLE_LENGTH)) || null;

const sanitizeColor = raw => (typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : null);

/** The "ref" a client attaches to an op is only echoed back in the ack. */
const sanitizeRef = raw => {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.length <= 64) return raw;
    return null;
};

/**
 * Sends a message that is already JSON (a string or a Buffer). The same Buffer
 * can go to many people without being copied for each of them. A connection
 * that stopped reading is closed instead.
 * @param {WebSocket} ws the connection
 * @param {string|Buffer} data JSON text
 * @returns {boolean} whether it was sent
 */
const sendData = (ws, data) => {
    if (ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount > MAX_CLIENT_BACKLOG_BYTES) {
        log('closing a connection that stopped reading');
        ws.terminate();
        return false;
    }
    ws.send(data, {binary: false});
    return true;
};

const send = (ws, message) => sendData(ws, typeof message === 'string' ? message : JSON.stringify(message));

const jsonBuffer = message => Buffer.from(JSON.stringify(message));

/**
 * The address the per-address limits use. An IPv6 address counts by its /64
 * prefix: one home or phone usually gets a whole /64, so it could use a new
 * address for each connection. An IPv4 address counts as itself, also when it
 * is written the IPv6 way (::ffff:1.2.3.4).
 * @param {string} ip the connection's address (see clientIp)
 * @returns {string} the address for the limits
 */
const addressKey = ip => {
    const address = String(ip).split('%')[0];
    if (!net.isIPv6(address)) return ip;
    const groups = text => (text ? text.split(':') : []).flatMap(piece => {
        if (!piece.includes('.')) return [parseInt(piece, 16)];
        const bytes = piece.split('.').map(Number);
        return [(bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]];
    });
    const [head, tail] = address.split('::');
    const start = groups(head);
    const end = groups(tail);
    const all = [...start, ...new Array(8 - start.length - end.length).fill(0), ...end];
    if (all.slice(0, 5).every(group => group === 0) && all[5] === 0xffff) {
        return [all[6] >> 8, all[6] & 0xff, all[7] >> 8, all[7] & 0xff].join('.');
    }
    return `${all.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`;
};

/**
 * Who shares one turn in the password-check line (see checkRoomPassword).
 * Wider than addressKey for IPv6: one network often owns a whole /48 or /56,
 * so counting by /64 there would let it act like hundreds of people and push
 * everyone else out of the line. The wrong-password limits still use the /64.
 * @param {string} address an address from addressKey
 * @returns {string} the key for the check line
 */
const checkShareKey = address => {
    if (!address.endsWith('::/64')) return address;
    return `${address.slice(0, -'::/64'.length).split(':')
        .slice(0, 3)
        .join(':')}::/48`;
};

/** What is kept of a resume token: a memory dump can't be used to get into a room. */
const tokenHash = token => crypto.createHash('sha256').update(token)
    .digest('base64');

/** Sends an error and closes the connection (the editor shows or handles it). */
const refuse = (ws, code, message) => {
    send(ws, {t: 'error', code, message});
    ws.close();
};

/**
 * Refuses something a person in a room did: nothing more from that connection
 * is used. Their editor usually reconnects by itself, so this counts as a
 * dropped connection, not as Leave (see ws.on('close')).
 */
const refuseClient = (client, code, message) => {
    client.closing = true;
    refuse(client.ws, code, message);
};

/**
 * Answers a room-settings message that couldn't be done. The connection stays
 * open: "for" tells the editor this is about the change it asked for, so it
 * just says so instead of leaving the room.
 */
const refuseSettings = (client, code, message) => {
    send(client.ws, {t: 'error', code, for: 'room-settings', message});
};

const SERVER_FULL_MESSAGE = 'This server has no space for new rooms right now. Existing rooms still work.';
const BUSY_MESSAGE = 'The server is busy right now. Try again in a minute.';
const PASSWORD_BUSY_MESSAGE = 'The server was too busy to change the room\'s password. Try again in a minute.';
const PASSWORD_NEEDED_MESSAGE = 'This room has a password. Type it to join.';
const PASSWORD_TOO_SHORT = `Room passwords need at least ${MIN_ROOM_PASSWORD_LENGTH} characters`;
const PASSWORD_TOO_LONG = `Room passwords can be at most ${MAX_ROOM_PASSWORD_LENGTH} characters`;
const TOO_MANY_TRIES_MESSAGE = 'Too many wrong passwords for this room. Wait a few minutes and try again.';
const TOO_MANY_HASHES_MESSAGE = 'Too many room passwords were set from your network just now. Try again in a minute.';
const TOO_MANY_CHANGES_MESSAGE = 'You changed the room\'s password too often. Try again in a minute.';

/**
 * Counts wrong room passwords. A check that is still running might turn out
 * wrong, so it counts as a try until it is done: lots of guesses sent at the
 * same moment can't get past the limit together.
 */
class PasswordTries extends RateLimiter {
    constructor (limit, windowMs) {
        super(limit, windowMs);
        /** @type {Map<string, number>} checks running now, per key */
        this.running = new Map();
    }

    /** Wrong tries `key` has left in this window (checks still running not counted). */
    left (key) {
        const entry = this.entry(key, false);
        return this.limit - (entry ? entry.count : 0);
    }

    /** True when another check for `key` must wait: the running ones could use its last tries. */
    full (key) {
        return (this.running.get(key) || 0) >= this.left(key);
    }

    started (key) {
        this.running.set(key, (this.running.get(key) || 0) + 1);
    }

    finished (key) {
        const count = (this.running.get(key) || 0) - 1;
        if (count > 0) {
            this.running.set(key, count);
        } else {
            this.running.delete(key);
        }
    }
}

const wrongPasswordsPerAddress = new PasswordTries(PASSWORD_TRIES_PER_IP, PASSWORD_TRIES_WINDOW_MS);
const wrongPasswordsPerRoom = new PasswordTries(PASSWORD_TRIES_PER_ROOM, PASSWORD_TRIES_WINDOW_MS);
const passwordChanges = new RateLimiter(MAX_PASSWORD_CHANGES_PER_MINUTE, 60 * 1000);

/** The wrong-password limits a check of `roomId`'s password from `ip` counts against. */
const passwordGuards = (roomId, ip) => [
    {tries: wrongPasswordsPerAddress, key: `${roomId} ${ip}`},
    {tries: wrongPasswordsPerRoom, key: roomId}
];

const tooManyTries = guards => guards.some(guard => guard.tries.blocked(guard.key));

/**
 * Room password work (scrypt) running now, and work waiting for its turn.
 * Checks (someone joining an existing locked room) and hashing (a new
 * password) wait in separate lines. When a slot frees up, checks go first,
 * and hashing may only use part of the slots and waiting places (see
 * MAX_PASSWORD_HASHES_AT_ONCE), so made-up new rooms can't keep people out.
 * Checks can't use every slot either (see PASSWORD_SLOTS_ONLY_FOR_HASHING),
 * so a flood of them can't stop passwords from being set.
 *
 * Waiting checks are kept per address, and addresses take turns (see
 * startWaitingChecks), so a few addresses checking over and over can't make
 * everyone else wait behind all of their checks, or fill every waiting place
 * (see makeRoomForCheck).
 */
const passwordWork = {
    running: 0,
    hashesRunning: 0,
    /** @type {Map<string, Array<object>>} address -> its waiting checks, oldest first (the address whose turn is next first) */
    checks: new Map(),
    checksWaiting: 0,
    hashes: []
};

/**
 * @param {{hashing: boolean, guards: Array<object>, address: string}} job
 *     hashing or a check, the wrong-password limits it counts against (none
 *     for hashing), and who asked for it
 * @returns {boolean} whether it may start now
 */
const passwordWorkCanStart = job => passwordWork.running < MAX_PASSWORD_WORK_AT_ONCE &&
    (job.hashing ?
        passwordWork.hashesRunning < MAX_PASSWORD_HASHES_AT_ONCE :
        passwordWork.running - passwordWork.hashesRunning < MAX_PASSWORD_WORK_AT_ONCE - PASSWORD_SLOTS_ONLY_FOR_HASHING) &&
    job.guards.every(guard => !guard.tries.full(guard.key));

const passwordWorkCanWait = job => passwordWork.checksWaiting + passwordWork.hashes.length < MAX_PASSWORD_WORK_WAITING &&
    (!job.hashing || passwordWork.hashes.length < MAX_PASSWORD_HASHES_WAITING);

const startPasswordWork = job => {
    passwordWork.running++;
    if (job.hashing) passwordWork.hashesRunning++;
    for (const guard of job.guards) guard.tries.started(guard.key);
};

/** Puts work in its line to wait for its turn. */
const waitForTurn = waiting => {
    if (waiting.job.hashing) {
        passwordWork.hashes.push(waiting);
        return;
    }
    // An address with nothing waiting yet gets its turn after those already waiting.
    const line = passwordWork.checks.get(waiting.job.address);
    if (line) {
        line.push(waiting);
    } else {
        passwordWork.checks.set(waiting.job.address, [waiting]);
    }
    passwordWork.checksWaiting++;
};

/**
 * Every waiting place is taken, and a check from `job.address` arrives. If
 * that address has fewer checks waiting than the address with the most, the
 * newest check of that address makes way (it is told the server is busy).
 * So one address can't keep more than its share of the waiting places, and
 * someone new always gets one.
 * @param {object} job the check that arrived
 * @returns {boolean} whether a place was made for it
 */
const makeRoomForCheck = job => {
    const own = (passwordWork.checks.get(job.address) || []).length;
    let most = null;
    for (const entry of passwordWork.checks) {
        if (!most || entry[1].length >= most[1].length) most = entry;
    }
    if (!most || most[1].length <= own) return false;
    const [address, line] = most;
    const newest = line.pop();
    passwordWork.checksWaiting--;
    if (line.length === 0) passwordWork.checks.delete(address);
    newest.resolve('busy');
    return true;
};

/** Starts what has waited longest in one line, as far as the limits allow; returns who still waits. */
const startWaitingWork = line => line.filter(waiting => {
    if (tooManyTries(waiting.job.guards)) {
        waiting.resolve('blocked');
        return false;
    }
    if (!passwordWorkCanStart(waiting.job)) return true;
    startPasswordWork(waiting.job);
    waiting.resolve('go');
    return false;
});

/**
 * Starts waiting checks as far as the limits allow, one address at a time:
 * each turn starts the oldest check of that address that may start, and the
 * address then goes to the end of the line. The address whose check started
 * longest ago goes first.
 */
const startWaitingChecks = () => {
    for (let startedOne = true; startedOne;) {
        startedOne = false;
        for (const [address, line] of [...passwordWork.checks]) {
            let started = false;
            const waiting = line.filter(entry => {
                if (tooManyTries(entry.job.guards)) {
                    entry.resolve('blocked');
                    return false;
                }
                if (started || !passwordWorkCanStart(entry.job)) return true;
                startPasswordWork(entry.job);
                entry.resolve('go');
                started = true;
                return false;
            });
            passwordWork.checksWaiting -= line.length - waiting.length;
            // (Setting an address that is still there keeps its place in the line.)
            if (started || waiting.length === 0) passwordWork.checks.delete(address);
            if (waiting.length > 0) passwordWork.checks.set(address, waiting);
            if (started) startedOne = true;
        }
    }
};

/** Work that is done makes room: waiting checks first, then waiting hashing. */
const finishPasswordWork = job => {
    passwordWork.running--;
    if (job.hashing) passwordWork.hashesRunning--;
    for (const guard of job.guards) guard.tries.finished(guard.key);
    startWaitingChecks();
    passwordWork.hashes = startWaitingWork(passwordWork.hashes);
};

/**
 * Hashes or checks a room password when its turn comes (see MAX_PASSWORD_WORK_AT_ONCE).
 * @param {{hashing: boolean, guards: Array<object>, address: string}} job what
 *     kind of work, the wrong-password limits it counts against (none for
 *     hashing), and the address of who asked for it
 * @param {function(): Promise<*>} task the work; a check counts its own wrong result
 * @returns {Promise<{turn: string, result: *}>} turn: 'done' (result is set), 'busy'
 *     (too much work waiting already, or it made way for someone else's) or
 *     'blocked' (no wrong tries left)
 */
const doPasswordWork = async (job, task) => {
    let turn;
    if (tooManyTries(job.guards)) {
        turn = 'blocked';
    } else if (passwordWorkCanStart(job)) {
        startPasswordWork(job);
        turn = 'go';
    } else if (!passwordWorkCanWait(job) && (job.hashing || !makeRoomForCheck(job))) {
        turn = 'busy';
    } else {
        turn = await new Promise(resolve => waitForTurn({job, resolve}));
    }
    if (turn !== 'go') return {turn, result: null};
    try {
        return {turn: 'done', result: await task()};
    } finally {
        finishPasswordWork(job);
    }
};

/**
 * Runs `work` while it counts as one more for `address` in `perAddress`
 * (running or waiting password work, per address).
 * @param {Map<string, number>} perAddress the counts
 * @param {string} address the connection's address
 * @param {function(): Promise<*>} work the work
 * @returns {Promise<*>} what the work gave
 */
const countedPerAddress = async (perAddress, address, work) => {
    perAddress.set(address, (perAddress.get(address) || 0) + 1);
    try {
        return await work();
    } finally {
        const left = perAddress.get(address) - 1;
        if (left > 0) {
            perAddress.set(address, left);
        } else {
            perAddress.delete(address);
        }
    }
};

/** Password checks each address has running or waiting right now. */
const checksPerAddress = new Map();

/**
 * Checks a password against a room's password hash. A wrong one is counted
 * before the next check may start. The result is null when nobody wanted the
 * answer any more by the time its turn came (nothing was checked or counted).
 * An address that already has its share of checks running or waiting gets
 * 'busy' (see MAX_PASSWORD_CHECKS_PER_ADDRESS): those still count while they
 * wait, even if their connection is gone, so closing them doesn't get round it.
 * @param {string} address the connection's address
 * @param {Array<object>} guards the wrong-password limits it counts against
 *     (none for a check that must not count, see joinRoom)
 * @param {string} password the password sent
 * @param {string} hash the room's password hash
 * @param {function(): boolean} wanted false once nobody wants the answer any more
 * @returns {Promise<{turn: string, result: ?boolean}>} see doPasswordWork
 */
const checkRoomPassword = (address, guards, password, hash, wanted) => {
    const share = checkShareKey(address);
    if ((checksPerAddress.get(share) || 0) >= MAX_PASSWORD_CHECKS_PER_ADDRESS) {
        return Promise.resolve({turn: 'busy', result: null});
    }
    return countedPerAddress(checksPerAddress, share, () => doPasswordWork({hashing: false, guards, address: share}, async () => {
        if (!wanted()) return null;
        const matches = await verifyPassword(password, hash);
        if (!matches) {
            for (const guard of guards) guard.tries.hit(guard.key);
        }
        return matches;
    }));
};

/** Password hashing each address has running or waiting right now. */
const hashesPerAddress = new Map();
const passwordHashesPerAddress = new RateLimiter(PASSWORD_HASHES_PER_MINUTE, 60 * 1000);

/**
 * Whether `address` may have another room password hashed now (then it is
 * counted, and hashRoomPassword must follow right away). New connections
 * cost nothing, so this is per address, not per connection or person.
 * @param {string} address the connection's address
 * @returns {boolean} false when it has too many running or waiting, or started too many this minute
 */
const mayHashPassword = address => (hashesPerAddress.get(address) || 0) < MAX_PASSWORD_HASHES_PER_ADDRESS &&
    passwordHashesPerAddress.hit(address);

/**
 * Hashes a new room password (a new locked room, or a password change) when
 * its turn comes. Call mayHashPassword first.
 * @param {string} address the connection's address
 * @param {string} password the new password
 * @param {function(): boolean} wanted false once nobody wants it any more (the result is then null)
 * @returns {Promise<{turn: string, result: ?string}>} see doPasswordWork
 */
const hashRoomPassword = (address, password, wanted) => countedPerAddress(hashesPerAddress, address,
    () => doPasswordWork({hashing: true, guards: [], address}, () => (wanted() ? hashPassword(password) : null)));

/**
 * The room's project as a "snapshot" message, built straight into one Buffer
 * (no huge temporary strings for a big project).
 * @param {number} seq the edit the project is at
 * @param {Buffer} snapshot the .sb3 file
 * @returns {Buffer} the message
 */
const snapshotMessage = (seq, snapshot) => {
    const head = Buffer.from(`{"t":"snapshot","seq":${seq},"data":"`);
    const tail = Buffer.from('"}');
    const out = Buffer.allocUnsafe(head.length + (Math.ceil(snapshot.length / 3) * 4) + tail.length);
    let offset = head.copy(out, 0);
    // A multiple of 3 bytes, so the pieces join into one valid base64 text.
    const CHUNK = 3 * 1024 * 1024;
    for (let start = 0; start < snapshot.length; start += CHUNK) {
        offset += out.write(snapshot.subarray(start, start + CHUNK).toString('base64'), offset, 'latin1');
    }
    tail.copy(out, offset);
    return out;
};

/** An edit as an "op" message, made once and kept for everyone who joins later. */
const opData = entry => {
    if (!entry.data) entry.data = jsonBuffer({t: 'op', seq: entry.seq, from: entry.from, op: entry.op});
    return entry.data;
};

/**
 * Roughly how much data is waiting to be sent. People in the same room are
 * sent the same copy of everything, so each room counts once.
 * @returns {boolean} whether so much is waiting that big sends should wait
 */
const tooMuchPending = () => {
    if (!MAX_PENDING_SEND_BYTES) return false;
    let total = 0;
    for (const room of rooms.values()) {
        let most = 0;
        for (const client of room.clients.values()) most = Math.max(most, client.ws.bufferedAmount);
        total += most;
    }
    return total > MAX_PENDING_SEND_BYTES;
};

class Room {
    constructor (id) {
        this.id = id;
        /** @type {Map<string, object>} */
        this.clients = new Map();
        this.seq = 0;
        /** @type {Buffer|null} */
        this.snapshot = null;
        this.snapshotSeq = 0;
        /** @type {Array<{seq: number, from: string, op: object, bytes: number}>} */
        this.ops = [];
        this.opBytes = 0;
        this.snapshotRequestedAt = 0;
        this.snapshotRequestedFrom = null;
        this.snapshotTimer = null;
        this.snapshotRequestTimer = null;
        this.snapshotHash = null;
        // Listed rooms appear in the room list (GET /rooms), so anyone on this
        // server can find and join them without an invite link. Rooms are
        // private unless the person who created them chose otherwise.
        this.listed = false;
        this.title = null;
        // A room with a password lets in only people who type it (or who were
        // already let in and are reconnecting). Only a salted hash is kept.
        this.passwordHash = null;
        // Counts password changes, so when several overlap the last one wins.
        this.passwordRequest = 0;
        // Goes up each time the password is set, changed or removed (see
        // setPasswordHash), so a remembered token can tell whether the
        // password is still the one from when that person dropped out.
        this.passwordVersion = 0;
        // Checks of an old password that are not counted as guessing, left
        // for the password as it is now (see joinRoom).
        this.uncountedChecksLeft = MAX_UNCOUNTED_CHECKS_PER_PASSWORD;
        // People whose hello is still being checked (their password takes a
        // moment): the room isn't forgotten under them.
        this.pendingHellos = 0;
        /**
         * People let in whose connection then dropped: they may come back
         * without the password (see DROPPED_MEMBER_KEEP_MS) while it is the
         * same as when they dropped. Only a hash of their resume token is
         * kept, oldest first.
         * @type {Map<string, {droppedAt: number, version: number, locked: boolean, address: string}>}
         *     token hash -> when they dropped, the room's passwordVersion then
         *     and whether it had a password then, and their address
         */
        this.droppedMembers = new Map();
        this.createdAt = Date.now();
        // What's on disk: the snapshot file, and edits not written there yet.
        this.savedSnapshotFile = null;
        this.needsFullSave = false;
        this.unsavedOps = [];
        this.flushTimer = null;
        // While a room creator whose connection dropped may still come back.
        this.creatorGrace = null;
        // The project as a message, shared by everyone it's sent to.
        this.stateCache = null;
        this.stateCacheTimer = null;
        // Set while the room is empty and about to be forgotten.
        this.closeTimer = null;
        // The room's files exist but couldn't be read: nobody may open it now.
        this.loadFailed = false;
        this.loadFromDisk();
    }

    loadFromDisk () {
        let saved;
        try {
            saved = store.load(this.id, MAX_OP_DEPTH);
        } catch (e) {
            // Never treat the room as new because its files couldn't be read
            // (too many open files...): its project would be replaced.
            this.loadFailed = true;
            log(`[${this.id}] could not load saved room:`, e.message);
            return;
        }
        if (!saved.snapshot) return;
        store.touch(this.id);
        this.snapshot = saved.snapshot;
        this.snapshotSeq = saved.snapshotSeq;
        this.snapshotHash = saved.snapshotHash;
        this.ops = saved.ops;
        this.opBytes = this.ops.reduce((total, entry) => total + entry.bytes, 0);
        this.seq = saved.seq;
        this.listed = saved.listed;
        this.title = sanitizeTitle(saved.title);
        this.passwordHash = saved.passwordHash;
        if (saved.createdAt !== null) this.createdAt = saved.createdAt;
        this.savedSnapshotFile = saved.snapshotFile;
        this.needsFullSave = saved.needsRewrite;
        log(`[${this.id}] loaded from disk (snapshot seq ${this.snapshotSeq}, ${this.ops.length} ops)`);
    }

    /** Writes the snapshot and every edit after it (when the snapshot changed). */
    saveSnapshotNow () {
        if (!this.snapshot) return;
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        try {
            this.savedSnapshotFile = store.saveSnapshot(this);
            this.needsFullSave = false;
            this.unsavedOps = [];
        } catch (e) {
            this.needsFullSave = true;
            log(`[${this.id}] could not save room:`, e.message);
        }
    }

    /** Adds new edits to the room's file (they're never rewritten all at once). */
    flushOps () {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        if (!this.snapshot) return;
        if (this.needsFullSave || !this.savedSnapshotFile) {
            this.saveSnapshotNow();
            return;
        }
        if (this.unsavedOps.length === 0) return;
        try {
            store.appendOps(this, this.unsavedOps);
            this.unsavedOps = [];
        } catch (e) {
            // Rewrite everything on the next try.
            this.needsFullSave = true;
            log(`[${this.id}] could not save edits:`, e.message);
        }
    }

    flushOpsSoon () {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => this.flushOps(), OPS_FLUSH_DELAY_MS);
    }

    /** Saves whatever isn't on disk yet (nothing is rewritten if nothing changed). */
    saveAll () {
        if (this.needsFullSave || !this.savedSnapshotFile) {
            this.saveSnapshotNow();
        } else {
            this.flushOps();
        }
    }

    saveSettings () {
        if (!this.snapshot) return;
        if (this.needsFullSave || !this.savedSnapshotFile) {
            this.saveSnapshotNow();
            return;
        }
        try {
            store.saveSettings(this, this.savedSnapshotFile);
        } catch (e) {
            // The next save (the next edit, or when the room empties) rewrites
            // everything, settings included: a new password must not be lost
            // just because the disk failed once.
            this.needsFullSave = true;
            log(`[${this.id}] could not save room settings:`, e.message);
        }
    }

    peers (exceptId) {
        const result = [];
        for (const client of this.clients.values()) {
            if (client.id !== exceptId) {
                result.push({
                    id: client.id,
                    name: client.name,
                    color: client.color,
                    presence: client.presence
                });
            }
        }
        return result;
    }

    broadcast (message, exceptId) {
        const data = jsonBuffer(message);
        for (const client of this.clients.values()) {
            if (client.id !== exceptId) sendData(client.ws, data);
        }
    }

    /** A colour nobody in the room has; the one asked for if it's free. */
    pickColor (requested) {
        const used = new Set([...this.clients.values()].map(c => c.color));
        const wanted = sanitizeColor(requested);
        if (wanted && !used.has(wanted)) return wanted;
        return COLORS.find(c => !used.has(c)) || COLORS[this.clients.size % COLORS.length];
    }

    /** The project as a message, made once and shared by everyone it's sent to. */
    snapshotData () {
        const cache = this.stateCache;
        if (!cache || cache.snapshot !== this.snapshot || cache.seq !== this.snapshotSeq) {
            this.stateCache = {
                snapshot: this.snapshot,
                seq: this.snapshotSeq,
                data: snapshotMessage(this.snapshotSeq, this.snapshot)
            };
        }
        clearTimeout(this.stateCacheTimer);
        this.stateCacheTimer = setTimeout(() => {
            this.stateCache = null;
        }, STATE_CACHE_MS);
        this.stateCacheTimer.unref();
        return this.stateCache.data;
    }

    /** Send the snapshot and every op after it so a client catches up. */
    sendState (client) {
        clearTimeout(client.waitTimer);
        client.waitTimer = null;
        sendData(client.ws, this.snapshotData());
        for (const entry of this.ops) sendData(client.ws, opData(entry));
        send(client.ws, {t: 'caught-up', seq: this.seq});
        client.ready = true;
        // A long list of edits (say, a room loaded from disk): save the project
        // soon. This person can answer right away: none of their edits is on its way.
        if (this.ops.length > 0) this.scheduleSnapshot();
    }

    /**
     * "Send me the room's project again." Answered at most every few seconds
     * per person, and only once the previous answer has been received, so a
     * few tiny messages can't make the server copy a big project over and over.
     */
    requestResync (client) {
        if (!this.snapshot || client.resyncTimer) return;
        const attempt = () => {
            client.resyncTimer = null;
            if (!this.clients.has(client.id) || !this.snapshot) return;
            const wait = (client.lastResyncAt || 0) + RESYNC_MIN_INTERVAL_MS - Date.now();
            if (wait > 0 || client.ws.bufferedAmount > 0 || (!this.stateCache && tooMuchPending())) {
                client.resyncTimer = setTimeout(attempt, Math.max(wait, 500));
                return;
            }
            client.lastResyncAt = Date.now();
            this.sendState(client);
        };
        attempt();
    }

    /** The person who has been in the room longest provides snapshots. */
    snapshotProvider () {
        let best = null;
        for (const client of this.clients.values()) {
            if (client.ready && !client.closing && !client.snapshotUnresponsive &&
                (!best || client.joinedAt < best.joinedAt)) {
                best = client;
            }
        }
        if (!best) {
            // Everyone has missed a request once; give them all another chance.
            for (const client of this.clients.values()) client.snapshotUnresponsive = false;
            for (const client of this.clients.values()) {
                if (client.ready && !client.closing && (!best || client.joinedAt < best.joinedAt)) best = client;
            }
        }
        return best;
    }

    requestSnapshot () {
        if (this.ops.length === 0 && this.snapshot) return;
        const now = Date.now();
        if (this.snapshotRequestedAt && now - this.snapshotRequestedAt < SNAPSHOT_REQUEST_TIMEOUT_MS) return;
        const provider = this.snapshotProvider();
        if (!provider) return;
        this.snapshotRequestedAt = now;
        this.snapshotRequestedFrom = provider.id;
        send(provider.ws, {t: 'request-snapshot'});
        clearTimeout(this.snapshotRequestTimer);
        this.snapshotRequestTimer = setTimeout(() => {
            if (this.snapshotRequestedFrom !== provider.id || !this.snapshotRequestedAt) return;
            // No answer: ask someone else.
            provider.snapshotUnresponsive = true;
            this.snapshotRequestedAt = 0;
            this.snapshotRequestedFrom = null;
            this.requestSnapshot();
        }, SNAPSHOT_REQUEST_TIMEOUT_MS);
    }

    scheduleSnapshot () {
        if (this.ops.length >= SNAPSHOT_MAX_OPS || this.opBytes >= SNAPSHOT_MAX_OP_BYTES) {
            this.requestSnapshot();
            return;
        }
        clearTimeout(this.snapshotTimer);
        this.snapshotTimer = setTimeout(() => this.requestSnapshot(), SNAPSHOT_IDLE_MS);
    }

    handleSnapshot (client, message) {
        // Only someone who has the room's project (or is creating it) can provide it.
        if (!client.ready) return;
        const seq = message.seq;
        const data = typeof message.data === 'string' ? Buffer.from(message.data, 'base64') : null;
        if (!Number.isInteger(seq) || seq < this.snapshotSeq || seq > this.seq || !isProjectFile(data)) {
            send(client.ws, {t: 'error', code: 'bad-snapshot', message: 'Snapshot rejected'});
            // Ask again (preferably someone else) instead of keeping a long op log.
            client.snapshotUnresponsive = true;
            clearTimeout(this.snapshotRequestTimer);
            this.snapshotRequestedAt = 0;
            this.snapshotRequestedFrom = null;
            if (this.snapshot && this.ops.length > 0) this.scheduleSnapshot();
            return;
        }
        const firstSnapshot = !this.snapshot;
        if (firstSnapshot && MAX_ROOM_STORAGE_BYTES > 0 &&
            store.usedBytes() + data.length > MAX_ROOM_STORAGE_BYTES) {
            // Checked again here: rooms opened at the same moment all got past
            // the check when they were opened.
            log(`[${this.id}] no space for this new room's project`);
            for (const other of [...this.clients.values()]) refuseClient(other, 'server-full', SERVER_FULL_MESSAGE);
            return;
        }
        this.snapshot = data;
        this.snapshotSeq = seq;
        this.snapshotHash = typeof message.hash === 'string' && message.hash.length <= 128 ? message.hash : null;
        client.snapshotUnresponsive = false;
        clearTimeout(this.snapshotRequestTimer);
        this.ops = this.ops.filter(entry => entry.seq > seq);
        this.opBytes = this.ops.reduce((total, entry) => total + entry.bytes, 0);
        this.snapshotRequestedAt = 0;
        this.snapshotRequestedFrom = null;
        log(`[${this.id}] snapshot at seq ${seq} (${Math.round(this.snapshot.length / 1024)} KB) from ${client.name}`);
        this.saveSnapshotNow();

        if (firstSnapshot) {
            clearTimeout(this.creatorGrace && this.creatorGrace.timer);
            this.creatorGrace = null;
            for (const other of this.clients.values()) {
                if (!other.ready) this.sendState(other);
            }
        } else if (this.snapshotHash) {
            // Everyone at this exact point compares their project with the snapshot
            // and reloads it if theirs ended up different.
            const checkpoint = jsonBuffer({t: 'checkpoint', seq, hash: this.snapshotHash});
            for (const other of this.clients.values()) {
                if (other.id !== client.id && other.ready) sendData(other.ws, checkpoint);
            }
        }
        if (this.ops.length > 0) this.scheduleSnapshot();
    }

    handleOp (client, message, rawBytes) {
        if (!client.ready) return;
        const op = message.op;
        if (!op || typeof op !== 'object') return;
        if (nestingTooDeep(op, MAX_OP_DEPTH)) {
            refuseClient(client, 'bad-op', 'That change could not be shared.');
            return;
        }
        // Only a list that is already full refuses an edit, so one big edit
        // (loading a big project) always fits.
        if (this.ops.length >= MAX_OP_LOG_OPS || this.opBytes >= MAX_OP_LOG_BYTES) {
            // Nobody has saved the room's project for a long time. This person
            // reconnects (their editor reloads the room) and someone else is
            // asked for the project; if nobody can, they're asked when back.
            refuseClient(client, 'too-many-edits',
                'This room has too many unsaved edits, so your last change wasn\'t shared.');
            this.requestSnapshot();
            return;
        }
        const seq = this.seq + 1;
        let data;
        try {
            data = jsonBuffer({t: 'op', seq, from: client.id, op});
        } catch (e) {
            refuseClient(client, 'bad-op', 'That change could not be shared.');
            return;
        }
        this.seq = seq;
        const entry = {seq, from: client.id, op, bytes: rawBytes, data};
        this.ops.push(entry);
        this.opBytes += rawBytes;
        this.unsavedOps.push(entry);
        for (const other of this.clients.values()) {
            if (other.id !== client.id && other.ready) sendData(other.ws, data);
        }
        send(client.ws, {t: 'ack', seq, ref: sanitizeRef(message.ref)});
        this.scheduleSnapshot();
        this.flushOpsSoon();
    }

    /**
     * @param {object} client the person joining
     * @param {boolean} resumingCreator whether they created this room and their
     *     connection dropped before its project arrived
     */
    join (client, resumingCreator) {
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
        this.clients.set(client.id, client);
        send(client.ws, {
            t: 'welcome',
            protocol: PROTOCOL_VERSION,
            id: client.id,
            // Names are cleaned up, so this can differ from what they typed.
            name: client.name,
            color: client.color,
            room: this.id,
            peers: this.peers(client.id),
            hasProject: !!this.snapshot,
            listed: this.listed,
            title: this.title,
            locked: !!this.passwordHash,
            // Lets this person take their place back if their connection drops.
            resume: client.resumeToken
        });
        this.broadcast({
            t: 'peer-join',
            peer: {id: client.id, name: client.name, color: client.color, presence: client.presence}
        }, client.id);

        if (this.snapshot) {
            this.sendState(client);
        } else if (resumingCreator || (!this.creatorGrace && ![...this.clients.values()].some(c => c.ready))) {
            // First person in a brand new room (or its creator coming back):
            // their project becomes the room's project.
            if (this.creatorGrace) {
                clearTimeout(this.creatorGrace.timer);
                this.creatorGrace = null;
            }
            client.ready = true;
            send(client.ws, {t: 'need-snapshot', seq: this.seq});
            this.restartWaiting();
        } else {
            // The room's first project is still on its way; this person gets it
            // as soon as it arrives (see handleSnapshot), or is told if it doesn't.
            this.waitForProject(client);
        }
    }

    /** How much the people providing the room's first project have sent so far. */
    uploadedBytes () {
        let total = 0;
        for (const client of this.clients.values()) {
            const socket = client.ready && client.ws._socket;
            if (socket) total += socket.bytesRead;
        }
        return total;
    }

    /** Tells someone waiting for the room's first project when it doesn't come. */
    waitForProject (client) {
        clearTimeout(client.waitTimer);
        client.waitTimer = null;
        if (FIRST_SNAPSHOT_TIMEOUT_MS <= 0) return;
        client.uploadSeen = this.uploadedBytes();
        const check = () => {
            client.waitTimer = null;
            if (this.snapshot || !this.clients.has(client.id) || client.closing) return;
            const uploaded = this.uploadedBytes();
            if (uploaded - client.uploadSeen >= UPLOAD_PROGRESS_BYTES) {
                // Still arriving (a big project on a slow connection): keep waiting.
                client.uploadSeen = uploaded;
                client.waitTimer = setTimeout(check, Math.min(UPLOAD_PROGRESS_CHECK_MS, FIRST_SNAPSHOT_TIMEOUT_MS));
                return;
            }
            refuseClient(client, 'no-project',
                'The person who started this room hasn\'t shared its project yet. Try joining again later.');
        };
        client.waitTimer = setTimeout(check, FIRST_SNAPSHOT_TIMEOUT_MS);
    }

    /** Someone new provides the room's first project: everyone waiting gets the full time again. */
    restartWaiting () {
        for (const other of this.clients.values()) {
            if (!other.ready && !other.closing) this.waitForProject(other);
        }
    }

    /** The room creator left before sharing the project: the next person in line provides it. */
    handOverFirstUpload () {
        if (this.snapshot || [...this.clients.values()].some(c => c.ready && !c.closing)) return;
        let next = null;
        for (const other of this.clients.values()) {
            if (!other.closing && (!next || other.joinedAt < next.joinedAt)) next = other;
        }
        if (!next) return;
        clearTimeout(next.waitTimer);
        next.waitTimer = null;
        next.ready = true;
        send(next.ws, {t: 'need-snapshot', seq: this.seq});
        this.restartWaiting();
    }

    /** What the room list shows about this room. */
    listing () {
        const names = [];
        for (const client of this.clients.values()) {
            if (names.length >= MAX_LISTED_NAMES) break;
            names.push(client.name);
        }
        // Locked rooms can be listed too: joining one from the list asks for its password.
        return {room: this.id, title: this.title, locked: !!this.passwordHash, people: this.clients.size, names};
    }

    /**
     * Tells everyone in the room about one change to its settings (never the
     * password or its hash: only whether there is one).
     * @param {object} client who changed it
     * @param {string} changed 'listed', 'title', 'password-set' or 'password-removed'
     */
    settingsChanged (client, changed) {
        this.broadcast({
            t: 'room-info',
            listed: this.listed,
            title: this.title,
            locked: !!this.passwordHash,
            by: client.id,
            changed
        });
    }

    /**
     * Anyone in the room can show it in the room list or make it private
     * again, rename it, and set, change or remove its password. One message
     * can do several of these; each change is announced on its own.
     */
    changeSettings (client, message) {
        if (!client.ready) return;
        let changed = false;
        if (typeof message.listed === 'boolean' && message.listed !== this.listed) {
            this.listed = message.listed;
            log(`[${this.id}] ${client.name} made the room ${this.listed ? 'listed' : 'private'}`);
            this.settingsChanged(client, 'listed');
            changed = true;
        }
        if (typeof message.title === 'string' || message.title === null) {
            // Same cleaning as a new room's title; nothing visible left means no name.
            const title = sanitizeTitle(message.title);
            if (title !== this.title) {
                this.title = title;
                log(`[${this.id}] ${client.name} ${title ? 'renamed the room' : 'removed the room\'s name'}`);
                this.settingsChanged(client, 'title');
                changed = true;
            }
        }
        if (changed) this.saveSettings();
        if (message.password !== undefined) this.changePassword(client, message.password);
    }

    /**
     * Sets, changes (a string) or removes (null or '') the room's password.
     * Hashing takes a moment; when changes overlap, the one asked for last wins.
     */
    changePassword (client, password) {
        if (password !== null && typeof password !== 'string') return;
        if (password && (password.length < MIN_ROOM_PASSWORD_LENGTH || password.length > MAX_ROOM_PASSWORD_LENGTH)) {
            // The editor checks this too.
            refuseSettings(client, 'bad-password',
                password.length > MAX_ROOM_PASSWORD_LENGTH ? PASSWORD_TOO_LONG : PASSWORD_TOO_SHORT);
            return;
        }
        if (!password && !this.passwordHash) return;
        // Each change costs the server a hash, so there are limits. A refused
        // change is refused before it counts as asked for, so it can't cancel
        // an earlier one that is still being hashed.
        if (!passwordChanges.hit(client.id)) {
            refuseSettings(client, 'busy', TOO_MANY_CHANGES_MESSAGE);
            return;
        }
        if (password && !mayHashPassword(client.ip)) {
            refuseSettings(client, 'busy', TOO_MANY_HASHES_MESSAGE);
            return;
        }
        const request = ++this.passwordRequest;
        if (!password) {
            this.setPasswordHash(null);
            log(`[${this.id}] ${client.name} removed the room's password`);
            this.settingsChanged(client, 'password-removed');
            this.saveSettings();
            return;
        }
        // Gone meanwhile, or someone changed the password again after this:
        // nothing to hash or say any more.
        const stillWanted = () => this.clients.get(client.id) === client && !client.closing &&
            request === this.passwordRequest;
        hashRoomPassword(client.ip, password, stillWanted)
            .then(outcome => {
                if (outcome.turn !== 'done') {
                    if (stillWanted()) refuseSettings(client, 'busy', PASSWORD_BUSY_MESSAGE);
                    return;
                }
                if (!stillWanted() || !outcome.result) return;
                this.setPasswordHash(outcome.result);
                log(`[${this.id}] ${client.name} set a new password for the room`);
                this.settingsChanged(client, 'password-set');
                this.saveSettings();
            })
            .catch(e => {
                log(`[${this.id}] could not set the room's password:`, e && e.message);
                if (stillWanted()) refuseSettings(client, 'busy', PASSWORD_BUSY_MESSAGE);
            });
    }

    /**
     * Sets, changes or removes (null) the room's password hash. Tokens of
     * people who dropped out before this stop being a pass (see joinRoom):
     * they weren't here for the change, so nobody here saw them get it.
     * @param {?string} hash the new hash
     */
    setPasswordHash (hash) {
        this.passwordHash = hash;
        this.passwordVersion++;
        this.uncountedChecksLeft = MAX_UNCOUNTED_CHECKS_PER_PASSWORD;
    }

    /**
     * Uses up one check that isn't counted as guessing, if the room's
     * password as it is now has any left (see joinRoom).
     * @returns {boolean} whether there was one
     */
    takeUncountedCheck () {
        if (this.uncountedChecksLeft <= 0) return false;
        this.uncountedChecksLeft--;
        return true;
    }

    /**
     * @param {object} client the person leaving
     * @param {boolean} dropped whether they are expected back on their own
     *     (the connection broke, their editor is reconnecting, or the server
     *     closed it), rather than having clicked Leave
     */
    leave (client, dropped) {
        if (!this.removeClient(client)) return;
        // Someone who clicked Leave needs the password again to come back.
        if (dropped) this.rememberDropped(client);
        if (!this.snapshot && client.ready && this.clients.size > 0 && !this.creatorGrace) {
            if (dropped && CREATOR_GRACE_MS > 0) {
                // The creator's connection broke before their project arrived.
                // Their editor reconnects by itself; give it a moment, so their
                // project (not someone else's) becomes the room's project.
                this.creatorGrace = {
                    token: client.resumeToken,
                    timer: setTimeout(() => {
                        this.creatorGrace = null;
                        this.handOverFirstUpload();
                    }, CREATOR_GRACE_MS)
                };
            } else {
                this.handOverFirstUpload();
            }
        }
        if (this.clients.size === 0) {
            this.emptied();
        } else if (this.ops.length > 0) {
            this.scheduleSnapshot();
        }
    }

    /**
     * Someone who was let in lost their connection (Wi-Fi, a laptop going to
     * sleep, the heartbeat giving up on them, the server closing it). Their
     * editor reconnects with the resume token from its welcome, maybe with a
     * password that is out of date or none at all: that must neither shut
     * them out nor count as guessing (enough wrong guesses would block the
     * room for everyone). The password as it is now is noted with it: if it
     * changes before they are back, the token no longer lets them past it.
     * @param {object} client the person who dropped out (their resume token and address)
     */
    rememberDropped (client) {
        if (DROPPED_MEMBER_KEEP_MS <= 0) return;
        const now = Date.now();
        // Oldest first: drop the ones too old, then any over the limit.
        for (const [key, {droppedAt}] of this.droppedMembers) {
            if (now - droppedAt <= DROPPED_MEMBER_KEEP_MS && this.droppedMembers.size < MAX_DROPPED_MEMBERS_PER_ROOM) {
                break;
            }
            this.droppedMembers.delete(key);
        }
        // The oldest one from their address makes way if it has too many.
        const fromThere = [...this.droppedMembers].filter(([, dropped]) => dropped.address === client.ip);
        if (fromThere.length >= MAX_DROPPED_MEMBERS_PER_ADDRESS) this.droppedMembers.delete(fromThere[0][0]);
        this.droppedMembers.set(tokenHash(client.resumeToken), {
            droppedAt: now,
            version: this.passwordVersion,
            // Only someone who dropped out while the room had a password can
            // have an old one that their editor still sends (see joinRoom).
            locked: !!this.passwordHash,
            address: client.ip
        });
    }

    /**
     * @param {string} token a resume token
     * @returns {?{version: number, locked: boolean}} the room's passwordVersion
     *     when the person with this token dropped out lately, and whether it
     *     had a password then; null if it isn't such a token
     */
    droppedMember (token) {
        const key = tokenHash(token);
        const dropped = this.droppedMembers.get(key);
        if (!dropped) return null;
        if (Date.now() - dropped.droppedAt <= DROPPED_MEMBER_KEEP_MS) return dropped;
        this.droppedMembers.delete(key);
        return null;
    }

    /** A resume token works once: whoever used it gets a new one in their welcome. */
    forgetDropped (token) {
        this.droppedMembers.delete(tokenHash(token));
    }

    /** Takes someone off the room's list (they left, or connected again). */
    removeClient (client) {
        if (!this.clients.delete(client.id)) return false;
        clearTimeout(client.waitTimer);
        clearTimeout(client.resyncTimer);
        this.broadcast({t: 'peer-leave', id: client.id});
        if (this.snapshotRequestedFrom === client.id) {
            // They were asked for a snapshot but left; ask someone else.
            this.snapshotRequestedAt = 0;
        }
        return true;
    }

    /**
     * The same person connected again before their old connection was noticed
     * as broken (usual after the Wi-Fi changes): the old connection is dropped
     * and they keep their place.
     * @param {object} previous their old connection's client
     * @returns {boolean} whether they were providing the room's first project
     */
    takeOver (previous) {
        const wasProviding = !this.snapshot && previous.ready && !previous.closing;
        previous.closing = true;
        this.removeClient(previous);
        previous.ws.terminate();
        return wasProviding;
    }

    /** Nobody is left: save now, and forget the room a little later. */
    emptied () {
        if (!this.snapshot) {
            this.close();
            log(`[${this.id}] empty and closed`);
            return;
        }
        this.saveAll();
        this.closeSoon();
    }

    /**
     * Forgets the room (which has a project) EMPTY_ROOM_KEEP_MS from now,
     * unless someone is in it by then. Until then, people reconnecting, or
     * knocking without the right password, don't make the server read a
     * possibly big project from disk again.
     */
    closeSoon () {
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => {
            this.closeTimer = null;
            // Someone on their way in: forgotten later if they don't get in (see forgetIfUnused).
            if (this.clients.size > 0 || this.pendingHellos > 0) return;
            this.close();
            log(`[${this.id}] empty, saved and closed`);
        }, EMPTY_ROOM_KEEP_MS);
        this.closeTimer.unref();
    }

    /** Saves what's not on disk yet and forgets the room until someone opens it again. */
    close () {
        clearTimeout(this.snapshotTimer);
        clearTimeout(this.snapshotRequestTimer);
        clearTimeout(this.closeTimer);
        clearTimeout(this.stateCacheTimer);
        this.closeTimer = null;
        this.stateCache = null;
        if (this.creatorGrace) clearTimeout(this.creatorGrace.timer);
        this.creatorGrace = null;
        // Whoever dropped out of it needs the password from now on.
        this.droppedMembers.clear();
        this.saveAll();
        if (this.snapshot) store.touch(this.id);
        if (rooms.get(this.id) === this) rooms.delete(this.id);
    }
}

const getRoom = id => {
    let room = rooms.get(id);
    if (!room) {
        room = new Room(id);
        rooms.set(id, room);
    }
    return room;
};

/** Accounts, posted projects, friends and studios (null if storage failed to open). */
let community = null;
let communityError = null;

const httpServer = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
        if (community) {
            community.handle(req, res);
        } else {
            res.writeHead(503, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
            res.end(JSON.stringify({error: 'Accounts aren\'t available on this server right now'}));
        }
        return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.split('?')[0] === '/rooms') {
        // The room list: listed rooms that someone is in right now, biggest first.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, {'Allow': 'GET, HEAD', 'Content-Type': 'text/plain'});
            res.end('Method not allowed');
            return;
        }
        const listed = [...rooms.values()]
            .filter(room => room.listed && room.snapshot && room.clients.size > 0)
            .sort((a, b) => (b.clients.size - a.clients.size) || (b.createdAt - a.createdAt))
            .slice(0, MAX_LISTED_ROOMS)
            .map(room => room.listing());
        res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        res.end(JSON.stringify({rooms: listed}));
        return;
    }
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
            name: 'TurboScratch IDE collaboration server',
            protocol: PROTOCOL_VERSION,
            rooms: rooms.size,
            people: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0),
            accounts: !!community,
            accountStorage: community ? (process.env.DATABASE_URL ? 'postgres' : 'sqlite') : communityError
        }));
        return;
    }
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end('Not found');
});

const wss = new WebSocketServer({server: httpServer, maxPayload: MAX_MESSAGE_BYTES});

/**
 * Forgets a room that nobody is in or on their way into (a refused hello
 * must not keep a room in memory for good). A room with a project is kept a
 * little while first, like a room everyone just left: otherwise every
 * refused hello would read all of it from disk again. A room that is already
 * waiting to be forgotten (see Room.closeSoon) is left to that.
 */
const forgetIfUnused = room => {
    if (room.clients.size > 0 || room.pendingHellos > 0 || room.closeTimer || rooms.get(room.id) !== room) return;
    if (room.snapshot) {
        room.closeSoon();
    } else {
        room.close();
    }
};

/**
 * Puts someone in a room once every check has passed, or refuses them.
 *
 * Checking a room password takes a moment (scrypt runs on another thread),
 * and anything can happen meanwhile: someone else creates the room, its
 * password changes, it is forgotten, the connection closes... So after each
 * wait, everything is looked at again from the start, and a check is only
 * used for the password hash it was made against: nobody gets in without
 * passing the check for the room's password as it is at that moment.
 *
 * @param {WebSocket} ws the connection
 * @param {string} ip its address (for the per-address limits, see addressKey)
 * @param {function(object)} onJoin called with the client just before it joins
 * @param {object} hello what the hello asked for, already cleaned up
 * @returns {Promise<?object>} the client, or null if refused
 */
const joinRoom = async (ws, ip, onJoin, hello) => {
    const {roomId, password, resume} = hello;
    const guards = passwordGuards(roomId, ip);
    // Someone who left while waiting for their turn costs no scrypt work.
    const wanted = () => ws.readyState === ws.OPEN;
    // Work already done for this hello, used again while it still applies.
    let newHash = null;
    /** @type {Map<string, boolean>} room password hash -> whether the password matches it */
    const checked = new Map();
    let checks = 0;
    // Set once their resume token turned out to be from before the room's
    // password last changed, and from while it had a password (it is used
    // up then, so remembered here): their editor may still send that one.
    let oldPasswordMember = false;
    for (;;) {
        // (No wrong-tries check before this: only a room with a password has
        // one, and that can only be seen once the room is read. A room that
        // refuses someone stays in memory a while, see forgetIfUnused.)
        const room = getRoom(roomId);
        const turnAway = (code, text) => {
            refuse(ws, code, text);
            forgetIfUnused(room);
            return null;
        };
        if (room.loadFailed) return turnAway('busy', 'This room can\'t be opened right now. Try again in a minute.');
        // Their editor connected again, but their old connection is still here.
        const previous = resume ? [...room.clients.values()].find(c => c.resumeToken === resume && !c.closing) : null;
        if (room.clients.size - (previous ? 1 : 0) >= MAX_CLIENTS_PER_ROOM) return turnAway('room-full', 'This room is full');
        // (Joining a room whose project is being sent anyway costs nothing extra.)
        if (room.snapshot && !room.stateCache && tooMuchPending()) return turnAway('busy', BUSY_MESSAGE);
        const brandNew = room.clients.size === 0 && !room.snapshot;
        if (brandNew && MAX_ROOM_STORAGE_BYTES > 0 && store.usedBytes() > MAX_ROOM_STORAGE_BYTES) {
            return turnAway('server-full', SERVER_FULL_MESSAGE);
        }
        const resumingCreator = !!room.creatorGrace && resume !== null && resume === room.creatorGrace.token;
        // Their editor connected again after the old connection was noticed as broken.
        const dropped = !previous && resume !== null ? room.droppedMember(resume) : null;
        const droppedMember = dropped !== null && dropped.version === room.passwordVersion;
        if (dropped !== null && !droppedMember) {
            // They dropped out before the password was set, changed or
            // removed: they never heard about it, and nobody in the room saw
            // them while it happened, so their token is no pass. It is used
            // up; they need the password like anyone else. But the old
            // password their editor still sends isn't guessing, if the room
            // had one when they dropped out (see the check below).
            room.forgetDropped(resume);
            oldPasswordMember = dropped.locked;
        }

        // The password. Cheap checks first; scrypt only when nothing else refuses them.
        let work = null;
        if (brandNew) {
            // Their editor knows this room had a password, but the server has
            // forgotten the room (restarted with an empty disk...). Only
            // someone who has the password may create it again, or it would
            // come back open to anyone. Not a guess: nothing is counted.
            if (hello.expectLocked && !password) return turnAway('password-needed', PASSWORD_NEEDED_MESSAGE);
            if (password && password.length < MIN_ROOM_PASSWORD_LENGTH) return turnAway('bad-password', PASSWORD_TOO_SHORT);
            if (password && !newHash) {
                if (!mayHashPassword(ip)) return turnAway('busy', TOO_MANY_HASHES_MESSAGE);
                work = () => hashRoomPassword(ip, password, wanted);
            }
        } else if (room.passwordHash && !previous && !resumingCreator && !droppedMember) {
            // (Someone reconnecting with the token from their welcome was let
            // in already, so their place is kept even if the password changed.)
            const hash = room.passwordHash;
            if (!password) return turnAway('password-needed', PASSWORD_NEEDED_MESSAGE);
            if (!checked.has(hash)) {
                // (A room with too many wrong tries refuses everyone new, an
                // outdated token too: that only says its own try isn't counted.)
                if (tooManyTries(guards)) return turnAway('too-many-tries', TOO_MANY_TRIES_MESSAGE);
                // The wrong-password limits this check counts against: none
                // for the old password of someone who dropped out, while the
                // room's password has uncounted checks left (see
                // MAX_UNCOUNTED_CHECKS_PER_PASSWORD).
                const countedGuards = oldPasswordMember && room.takeUncountedCheck() ? [] : guards;
                if (password.length < MIN_ROOM_PASSWORD_LENGTH) {
                    // Never right (room passwords are longer), but still a guess.
                    for (const guard of countedGuards) guard.tries.hit(guard.key);
                    checked.set(hash, false);
                } else {
                    work = () => checkRoomPassword(ip, countedGuards, password, hash, wanted).then(outcome => {
                        if (outcome.turn === 'done' && outcome.result !== null) checked.set(hash, outcome.result);
                        return outcome;
                    });
                }
            }
            if (!work && !checked.get(hash)) {
                log(`[${room.id}] wrong password for this room`);
                return turnAway('wrong-password', 'Wrong password for this room.');
            }
        }
        // (An existing room without a password ignores any password sent.)

        if (!work) {
            if (brandNew) {
                // A brand-new room: whoever creates it decides whether it is
                // listed, its name and its password. For an existing room
                // these fields are ignored.
                room.listed = hello.listed;
                room.title = hello.title;
                if (password || room.passwordHash) room.setPasswordHash(password ? newHash : null);
                if (password) log(`[${room.id}] created with a password`);
            }
            let wasProviding = resumingCreator;
            if (previous) {
                wasProviding = room.takeOver(previous);
                log(`[${room.id}] ${previous.name} connected again`);
            }
            if (resume !== null) room.forgetDropped(resume);
            const client = {
                id: crypto.randomUUID(),
                resumeToken: crypto.randomBytes(16).toString('hex'),
                // For the limits on hashing new room passwords and on remembered tokens.
                ip,
                name: hello.name,
                // Someone connecting again keeps their colour and their place in line.
                color: previous ? previous.color : room.pickColor(hello.color),
                ws,
                room,
                ready: false,
                // Set once something they sent was refused: nothing more of theirs is used.
                closing: false,
                presence: {},
                joinedAt: previous ? previous.joinedAt : Date.now(),
                waitTimer: null,
                uploadSeen: 0,
                resyncTimer: null,
                lastResyncAt: 0
            };
            log(`[${room.id}] ${client.name} joined (${room.clients.size + 1} here)`);
            onJoin(client);
            room.join(client, wasProviding);
            return client;
        }

        if (checks > MAX_PASSWORD_RECHECKS) return turnAway('busy', BUSY_MESSAGE);
        checks++;
        room.pendingHellos++;
        let outcome;
        try {
            outcome = await work();
        } catch (e) {
            log(`[${room.id}] could not check a room password:`, e && e.message);
            outcome = {turn: 'failed', result: null};
        } finally {
            room.pendingHellos--;
        }
        if (!wanted()) {
            // They left while waiting.
            forgetIfUnused(room);
            return null;
        }
        // 'blocked' (no wrong tries left by the time its turn came) is said
        // by the next round, unless the room has no password any more.
        if (outcome.turn !== 'done' && outcome.turn !== 'blocked') return turnAway('busy', BUSY_MESSAGE);
        if (brandNew) newHash = outcome.result;
        // ...and round again: the room may have changed meanwhile.
    }
};

/**
 * The first message of a connection: which room, and who. Only the few small
 * things needed are taken from it, so a huge hello isn't kept in memory while
 * a password is being checked.
 * @param {WebSocket} ws the connection
 * @param {object} message the hello
 * @param {string} ip the connection's address
 * @param {function(object)} onJoin called with the client just before it joins its room
 * @returns {Promise<?object>} the client, or null if refused
 */
const handleHello = (ws, message, ip, onJoin) => {
    const roomId = sanitizeRoomId(message.room);
    if (!roomId) {
        refuse(ws, 'bad-room', 'Room codes can use letters, numbers, - and _');
        return Promise.resolve(null);
    }
    if (message.protocol !== PROTOCOL_VERSION) {
        refuse(ws, 'protocol', 'Your editor and the server are different versions');
        return Promise.resolve(null);
    }
    // Older editors send no password.
    const password = typeof message.password === 'string' ? message.password : '';
    if (password.length > MAX_ROOM_PASSWORD_LENGTH) {
        refuse(ws, 'bad-password', PASSWORD_TOO_LONG);
        return Promise.resolve(null);
    }
    return joinRoom(ws, ip, onJoin, {
        roomId,
        password,
        resume: typeof message.resume === 'string' && message.resume.length <= 64 ? message.resume : null,
        name: sanitizeName(message.name),
        color: sanitizeColor(message.color),
        // Only used if this creates the room.
        listed: message.listed === true,
        title: sanitizeTitle(message.title),
        // The editor saw that this room has a password (see joinRoom).
        expectLocked: message.expectLocked === true
    });
};

/** Every message after hello. */
const handleMessage = (client, message, rawBytes) => {
    if (client.closing) return;
    const room = client.room;
    switch (message.t) {
    case 'op':
        room.handleOp(client, message, rawBytes);
        break;
    case 'snapshot':
        room.handleSnapshot(client, message);
        break;
    case 'presence': {
        const target = message.presence && typeof message.presence.target === 'string' ?
            clip(message.presence.target, 100) :
            null;
        const presence = {target};
        client.presence = presence;
        room.broadcast({t: 'presence', id: client.id, presence}, client.id);
        break;
    }
    case 'chat': {
        if (typeof message.text !== 'string') return;
        const text = clip(clip(message.text, MAX_CHAT_LENGTH * 2).replace(DIRECTION_CHARACTERS, '').trim(),
            MAX_CHAT_LENGTH);
        if (!hasVisibleText(text)) return;
        room.broadcast({
            t: 'chat',
            id: client.id,
            name: client.name,
            color: client.color,
            text,
            time: Date.now()
        });
        break;
    }
    case 'resync':
        room.requestResync(client);
        break;
    case 'room-settings':
        room.changeSettings(client, message);
        break;
    case 'ping':
        send(client.ws, {t: 'pong'});
        break;
    }
};

wss.on('connection', (ws, req) => {
    // First of all: a broken frame from anyone must never crash the server.
    ws.on('error', () => {});
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin) && origin !== DESKTOP_APP_ORIGIN) {
        refuse(ws, 'origin', 'This server does not accept connections from that website');
        return;
    }
    // Only used for the per-address limits (an IPv6 address counts by its /64).
    const ip = addressKey(clientIp(req));
    /** @type {null | object} */
    let client = null;
    // Set when the hello arrives. While it is being checked (a room password
    // takes a moment) and after it was refused, nothing else from this
    // connection is used, not even another hello.
    let helloReceived = false;
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    const helloTimer = setTimeout(() => {
        if (!client) ws.terminate();
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let message;
        try {
            message = JSON.parse(data.toString('utf8'));
        } catch (e) {
            return;
        }
        if (!message || typeof message.t !== 'string') return;
        try {
            if (!client) {
                if (message.t !== 'hello' || helloReceived) return;
                helloReceived = true;
                clearTimeout(helloTimer);
                handleHello(ws, message, ip, joined => {
                    // Set right as they join, so a close from then on takes them out again.
                    client = joined;
                }).catch(e => {
                    log('error handling a hello, closing that connection:', e && e.message);
                    ws.terminate();
                });
                return;
            }
            handleMessage(client, message, data.length);
        } catch (e) {
            // A bug or a strange message must only affect this connection.
            log('error handling a message, closing that connection:', e && e.message);
            ws.terminate();
        }
    });

    ws.on('close', code => {
        clearTimeout(helloTimer);
        if (client) {
            log(`[${client.room.id}] ${client.name} left`);
            // Dropped (they may come back with their token, see Room.leave):
            // 1006, the connection broke (Wi-Fi, sleep, the heartbeat);
            // CLOSE_RECONNECTING, their editor closed a connection it thought
            // was dead and is connecting again; or the server closed it
            // itself (refuseClient), after which the editor mostly reconnects.
            // Any other close is Leave: the editor's Leave sends no code, and
            // so does everything older editors close.
            const dropped = code === 1006 || code === CLOSE_RECONNECTING || client.closing;
            client.room.leave(client, dropped);
            client = null;
        }
    });
});

const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            // Closes with 1006, so it counts as a dropped connection (see Room.leave).
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, HEARTBEAT_MS);

const deleteUnusedRooms = () => {
    if (!ROOM_EXPIRE_DAYS) return;
    try {
        const deleted = store.deleteUnused(ROOM_EXPIRE_DAYS * 24 * 60 * 60 * 1000, id => rooms.has(id));
        if (deleted) log(`Deleted ${deleted} rooms nobody opened for ${ROOM_EXPIRE_DAYS} days`);
    } catch (e) {
        log('Could not clean up old rooms:', e.message);
    }
};
const cleanup = setInterval(deleteUnusedRooms, 6 * 60 * 60 * 1000);
cleanup.unref();

const shutdown = () => {
    clearInterval(heartbeat);
    for (const room of rooms.values()) room.saveAll();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const start = async () => {
    try {
        const db = await openDatabase({databaseUrl: process.env.DATABASE_URL, dataDir: DATA_DIR});
        community = createCommunityApi({db, log});
        log(`Accounts enabled (${process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite file in the data folder'})`);
    } catch (e) {
        communityError = 'storage unavailable';
        log('Accounts are disabled: could not open storage:', e.message);
    }
    deleteUnusedRooms();
    httpServer.listen(PORT, HOST, () => {
        log(`TurboScratch collaboration server listening on ws://${HOST}:${httpServer.address().port}`);
    });
};
start();

module.exports = {httpServer, wss, rooms, DESKTOP_APP_ORIGIN};
