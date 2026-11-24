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
const EMPTY_ROOM_KEEP_MS = 30000;
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
const MAX_NAME_LENGTH = 24;
const MAX_CHAT_LENGTH = 500;
const MAX_TITLE_LENGTH = 60;
const MAX_LISTED_ROOMS = 100;
const MAX_LISTED_NAMES = 5;

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

/** Sends an error and closes the connection (the editor shows or handles it). */
const refuse = (ws, code, message) => {
    send(ws, {t: 'error', code, message});
    ws.close();
};

/** Refuses something a person in a room did: nothing more from that connection is used. */
const refuseClient = (client, code, message) => {
    client.closing = true;
    refuse(client.ws, code, message);
};

const SERVER_FULL_MESSAGE = 'This server has no space for new rooms right now. Existing rooms still work.';

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
        return {room: this.id, title: this.title, people: this.clients.size, names};
    }

    /** Anyone in the room can show it in the room list or make it private again. */
    setListed (client, listed) {
        if (!client.ready || typeof listed !== 'boolean' || listed === this.listed) return;
        this.listed = listed;
        log(`[${this.id}] ${client.name} made the room ${listed ? 'listed' : 'private'}`);
        this.broadcast({t: 'room-info', listed, title: this.title, by: client.id});
        this.saveSettings();
    }

    /**
     * @param {object} client the person leaving
     * @param {boolean} dropped whether the connection broke (rather than being closed on purpose)
     */
    leave (client, dropped) {
        if (!this.removeClient(client)) return;
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
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => {
            this.closeTimer = null;
            if (this.clients.size > 0) return;
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

/** The first message of a connection: which room, and who. */
const handleHello = (ws, message) => {
    const roomId = sanitizeRoomId(message.room);
    if (!roomId) {
        refuse(ws, 'bad-room', 'Room codes can use letters, numbers, - and _');
        return null;
    }
    if (message.protocol !== PROTOCOL_VERSION) {
        refuse(ws, 'protocol', 'Your editor and the server are different versions');
        return null;
    }
    const isOpen = rooms.has(roomId);
    const room = getRoom(roomId);
    const forgetIfUnused = () => {
        if (!isOpen && room.clients.size === 0) room.close();
    };
    if (room.loadFailed) {
        forgetIfUnused();
        refuse(ws, 'busy', 'This room can\'t be opened right now. Try again in a minute.');
        return null;
    }
    // Their editor connected again, but their old connection is still here.
    const resume = typeof message.resume === 'string' && message.resume.length <= 64 ? message.resume : null;
    const previous = resume ? [...room.clients.values()].find(c => c.resumeToken === resume && !c.closing) : null;
    if (room.clients.size - (previous ? 1 : 0) >= MAX_CLIENTS_PER_ROOM) {
        refuse(ws, 'room-full', 'This room is full');
        return null;
    }
    // (Joining a room whose project is being sent anyway costs nothing extra.)
    if (room.snapshot && !room.stateCache && tooMuchPending()) {
        forgetIfUnused();
        refuse(ws, 'busy', 'The server is busy right now. Try again in a minute.');
        return null;
    }
    const brandNew = room.clients.size === 0 && !room.snapshot;
    if (brandNew && MAX_ROOM_STORAGE_BYTES > 0 && store.usedBytes() > MAX_ROOM_STORAGE_BYTES) {
        forgetIfUnused();
        refuse(ws, 'server-full', SERVER_FULL_MESSAGE);
        return null;
    }
    if (brandNew) {
        // A brand-new room: whoever creates it decides whether it is
        // listed. For an existing room these fields are ignored.
        room.listed = message.listed === true;
        room.title = sanitizeTitle(message.title);
    }
    let resumingCreator = !!room.creatorGrace && resume !== null && resume === room.creatorGrace.token;
    if (previous) {
        resumingCreator = room.takeOver(previous);
        log(`[${room.id}] ${previous.name} connected again`);
    }
    const client = {
        id: crypto.randomUUID(),
        resumeToken: crypto.randomBytes(16).toString('hex'),
        name: sanitizeName(message.name),
        // Someone connecting again keeps their colour and their place in line.
        color: previous ? previous.color : room.pickColor(message.color),
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
    room.join(client, resumingCreator);
    return client;
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
        room.setListed(client, message.listed);
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
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
        refuse(ws, 'origin', 'This server does not accept connections from that website');
        return;
    }
    /** @type {null | object} */
    let client = null;
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
                if (message.t !== 'hello') return;
                clearTimeout(helloTimer);
                client = handleHello(ws, message);
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
            // 1006: the connection broke (Wi-Fi, sleep...) rather than being closed.
            client.room.leave(client, code === 1006);
            client = null;
        }
    });
});

const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
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

module.exports = {httpServer, wss, rooms};
