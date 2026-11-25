/**
 * How collaboration rooms are kept on disk (in the data folder).
 *
 *   <room>.<seq>.sb3   the room's project as it was at edit number <seq>.
 *                      A new snapshot always gets a new file.
 *   <room>.ops         the edits made after that snapshot, one JSON line each.
 *                      New edits are appended, so a busy room never rewrites
 *                      its whole history.
 *   <room>.json        small settings: which snapshot is current, whether the
 *                      room is listed, its title, its password's salted hash
 *                      (never the password itself), ...
 *
 * Crash safety: the settings are written first, then the new snapshot to its
 * own file, then the edit list is replaced, and only then are older snapshot
 * files removed. Whenever the server stops, the newest readable snapshot plus
 * the edits that follow it without a gap give a consistent room, and the
 * snapshot's number says exactly which edits it already contains. Settings
 * that name a snapshot that never made it to disk are fine: the newest one
 * there is used. Writing the settings first means a room with a password
 * never has a project on disk without its password hash next to it.
 *
 * Damaged files are never silently overwritten: they're renamed to
 * "<name>.damaged-<time>" and whatever can still be read is used, including
 * a password hash that can still be read from damaged settings.
 *
 * Older versions kept "<room>.sb3" plus all edits inside "<room>.json"; those
 * rooms are still read, and rewritten in the new form the next time they're
 * saved.
 *
 * Copyright (C) 2026 TurboScratch IDE contributors. GPL-3.0.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOM_ID = '[a-z0-9][a-z0-9_-]{0,39}';
const SNAPSHOT_FILE = new RegExp(`^(${ROOM_ID})\\.(\\d{1,15})\\.sb3$`);
/** Every file that belongs to a room (and nothing else, like the accounts database). */
const ANY_ROOM_FILE = new RegExp(
    `^(${ROOM_ID})\\.(?:json|ops|sb3|\\d{1,15}\\.sb3)(?:\\.damaged-\\d+|\\.\\d+\\.tmp)?$`
);
const TEMP_FILE = /\.\d+\.tmp$/;
const USAGE_CACHE_MS = 60 * 1000;
const MAX_PASSWORD_HASH_LENGTH = 300;

/**
 * A room password's hash as saved, or null. Anything that isn't a hash made
 * by the server (see hashPassword in community/auth.js) counts as no password.
 * @param {*} value what the settings file says
 * @returns {?string} the hash
 */
const savedPasswordHash = value => (
    typeof value === 'string' && value.startsWith('scrypt$') && value.length <= MAX_PASSWORD_HASH_LENGTH ?
        value :
        null
);

const PASSWORD_HASH_TEXT = /"passwordHash"\s*:\s*"(scrypt\$[^"\\]*)"/;
const NO_PASSWORD_TEXT = /"passwordHash"\s*:\s*null/;

/**
 * What the text of a settings file too damaged to read as JSON still says
 * about the room's password. A locked room must not open to anyone because
 * a few bytes of its settings were lost (the hash is written near the start,
 * so even a cut-off file usually still tells).
 * @param {string} text the damaged file
 * @returns {{hash: ?string, lost: boolean}} hash: the password hash if it can
 *     still be read whole; lost: the room may have had one, but it can't be
 *     read (false when the text shows none, or says nothing about it at all,
 *     like the settings of rooms saved before room passwords existed)
 */
const damagedPasswordHash = text => {
    const match = PASSWORD_HASH_TEXT.exec(text);
    const hash = match ? savedPasswordHash(match[1]) : null;
    return {hash, lost: !hash && text.includes('"passwordHash"') && !NO_PASSWORD_TEXT.test(text)};
};

/** True for data that starts like a zip file (every .sb3 project does). */
const isProjectFile = data => Buffer.isBuffer(data) && data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b;

/**
 * True when a parsed JSON value has more than `limit` levels of nested
 * objects/arrays. Checked without recursion, so a hostile value can't
 * overflow the stack here, and with one entry per level (not per item), so
 * a huge flat array is quick to check and needs no extra memory.
 * @param {*} value a parsed JSON value
 * @param {number} limit the deepest nesting allowed
 * @returns {boolean} whether it is too deep
 */
const nestingTooDeep = (value, limit) => {
    if (value === null || typeof value !== 'object') return false;
    if (limit < 1) return true;
    // One entry per level: the container, its keys (null for arrays) and how far we got.
    const containers = [value];
    const keyLists = [Array.isArray(value) ? null : Object.keys(value)];
    const positions = [0];
    while (containers.length) {
        const level = containers.length - 1;
        const container = containers[level];
        const keys = keyLists[level];
        const length = keys ? keys.length : container.length;
        let i = positions[level];
        let child = null;
        while (i < length) {
            const item = keys ? container[keys[i]] : container[i];
            i++;
            if (item !== null && typeof item === 'object') {
                child = item;
                break;
            }
        }
        positions[level] = i;
        if (child === null) {
            containers.pop();
            keyLists.pop();
            positions.pop();
            continue;
        }
        if (containers.length >= limit) return true;
        containers.push(child);
        keyLists.push(Array.isArray(child) ? null : Object.keys(child));
        positions.push(0);
    }
    return false;
};

/**
 * A read failed for a reason other than "the file isn't there" (too many open
 * files, no permission...). The room must not be treated as new or damaged
 * then: that could replace its project. Opening it is refused instead.
 */
const cannotReadNow = error => Object.assign(new Error(`could not read room files (${error.message})`), {
    code: error.code,
    temporary: true
});

/** Write to a temporary file first, so a crash never leaves a half-written file. */
const writeFileAtomic = (file, data) => {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
};

const opsText = ops => ops.map(entry => `${JSON.stringify({
    seq: entry.seq,
    from: entry.from,
    op: entry.op,
    bytes: entry.bytes
})}\n`).join('');

class RoomStore {
    /**
     * @param {string} dataDir the folder rooms are kept in
     * @param {function} log logging function
     */
    constructor (dataDir, log) {
        this.dataDir = dataDir;
        this.log = log;
        this.usageCache = null;
    }

    file (name) {
        return path.join(this.dataDir, name);
    }

    listFiles () {
        try {
            return fs.readdirSync(this.dataDir);
        } catch (e) {
            if (e.code === 'ENOENT') return [];
            throw cannotReadNow(e);
        }
    }

    /** Keeps a damaged file for the server owner instead of overwriting it. */
    moveAside (name) {
        try {
            fs.renameSync(this.file(name), this.file(`${name}.damaged-${Date.now()}`));
        } catch (e) {
            // already gone
        }
    }

    /**
     * A room's snapshot files, newest first.
     * @param {string} id room code
     * @returns {Array<{name: string, seq: ?number}>} seq is null for an old-style "<room>.sb3"
     */
    snapshotFiles (id) {
        const found = [];
        let legacy = null;
        for (const name of this.listFiles()) {
            const match = SNAPSHOT_FILE.exec(name);
            if (match && match[1] === id) {
                found.push({name, seq: Number(match[2])});
            } else if (name === `${id}.sb3`) {
                legacy = {name, seq: null};
            }
        }
        found.sort((a, b) => b.seq - a.seq);
        if (legacy) found.push(legacy);
        return found;
    }

    /** Keeps a copy of a damaged file that is about to be rewritten. */
    copyAside (name) {
        try {
            fs.copyFileSync(this.file(name), this.file(`${name}.damaged-${Date.now()}`));
        } catch (e) {
            // nothing to keep
        }
    }

    /**
     * Edits from "<room>.ops". A last line cut off by a crash is ignored.
     * @param {string} id room code
     * @returns {{entries: Array<object>, damaged: boolean}} damaged: the file
     *     must be rewritten before anything is added to it (new edits added
     *     after a broken line would be lost the next time it's read)
     */
    readOpsFile (id) {
        let text;
        try {
            text = fs.readFileSync(this.file(`${id}.ops`), 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT') return {entries: [], damaged: false};
            throw cannotReadNow(e);
        }
        const lines = text.split('\n');
        const entries = [];
        let damaged = text.length > 0 && !text.endsWith('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            try {
                entries.push(JSON.parse(lines[i]));
            } catch (e) {
                damaged = true;
                if (lines.slice(i + 1).some(Boolean)) {
                    this.log(`[${id}] saved edits are damaged after edit ${entries.length}; kept a copy and ignoring the rest`);
                    this.copyAside(`${id}.ops`);
                }
                break;
            }
        }
        return {entries, damaged};
    }

    /**
     * Reads a room. A room without a readable project comes back empty (as a
     * brand-new room); damaged files are moved aside first. Throws (with
     * `temporary` set) when files can't be read right now.
     * @param {string} id room code
     * @param {number} maxDepth deepest nesting allowed inside an edit
     * @returns {object} the room's saved state
     */
    load (id, maxDepth) {
        const result = {
            snapshot: null,
            snapshotSeq: 0,
            snapshotHash: null,
            snapshotFile: null,
            seq: 0,
            ops: [],
            listed: false,
            title: null,
            // Rooms saved before room passwords existed have none.
            passwordHash: null,
            createdAt: null,
            // True when the files on disk should be rewritten (old format or recovered).
            needsRewrite: false
        };

        let meta = {};
        let settingsText = null;
        // Set when the settings file can't be read as settings (dealt with below).
        let settingsProblem = null;
        try {
            settingsText = fs.readFileSync(this.file(`${id}.json`), 'utf8');
        } catch (e) {
            // No settings file next to a project means default settings, so
            // that room opens without a password. That only happens if
            // someone deleted the file by hand (or with rooms saved by older
            // versions): it is written before a room's first snapshot.
            if (e.code !== 'ENOENT') throw cannotReadNow(e);
        }
        if (settingsText !== null) {
            try {
                const parsed = JSON.parse(settingsText);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a settings object');
                meta = parsed;
            } catch (e) {
                settingsProblem = e;
            }
        }

        for (const candidate of this.snapshotFiles(id)) {
            let data;
            try {
                data = fs.readFileSync(this.file(candidate.name));
            } catch (e) {
                // Removed a moment ago: look at the next one.
                if (e.code === 'ENOENT') continue;
                throw cannotReadNow(e);
            }
            if (!isProjectFile(data)) {
                this.log(`[${id}] ${candidate.name} is not a project file; kept it aside`);
                this.moveAside(candidate.name);
                continue;
            }
            let seq = candidate.seq;
            if (seq === null) {
                // Old style: the settings file says which edit the snapshot is at.
                seq = Number.isSafeInteger(meta.snapshotSeq) && meta.snapshotSeq >= 0 ? meta.snapshotSeq : 0;
                result.needsRewrite = true;
            }
            result.snapshot = data;
            result.snapshotSeq = seq;
            result.snapshotFile = candidate.name;
            break;
        }

        if (!result.snapshot) {
            // Nothing to restore: leftovers without a project can't be used.
            for (const name of [`${id}.json`, `${id}.ops`]) {
                if (fs.existsSync(this.file(name))) this.moveAside(name);
            }
            result.needsRewrite = false;
            return result;
        }

        result.passwordHash = savedPasswordHash(meta.passwordHash);
        if (settingsProblem) {
            const salvaged = damagedPasswordHash(settingsText);
            if (salvaged.lost) {
                // The room may have had a password, and which one can't be
                // told any more. Opening it without one could show its
                // project to anyone: it isn't opened, and the file is left as
                // it is, until the server owner has looked at it.
                throw new Error('the room\'s settings are damaged and its password hash can\'t be read; ' +
                    `fix or remove ${id}.json to open it`);
            }
            this.log(`[${id}] room settings are damaged (${settingsProblem.message}); kept a copy and recovering the rest` +
                `${salvaged.hash ? ', its password included' : ''}`);
            this.moveAside(`${id}.json`);
            result.needsRewrite = true;
            // Written into the new settings file with the next save.
            result.passwordHash = salvaged.hash;
        }

        const current = meta.snapshotFile === result.snapshotFile ||
            (result.snapshotFile === `${id}.sb3` && !meta.snapshotFile);
        if (current && typeof meta.snapshotHash === 'string' && meta.snapshotHash.length <= 128) {
            result.snapshotHash = meta.snapshotHash;
        }
        if (!current) result.needsRewrite = true;
        result.listed = meta.listed === true;
        result.title = typeof meta.title === 'string' ? meta.title : null;
        result.createdAt = Number.isFinite(meta.createdAt) ? meta.createdAt : null;

        // The edits after the snapshot: old rooms kept them in the settings file.
        const opsFile = this.readOpsFile(id);
        if (opsFile.damaged) result.needsRewrite = true;
        const entries = (Array.isArray(meta.ops) ? meta.ops : []).concat(opsFile.entries);
        if (Array.isArray(meta.ops) && meta.ops.length) result.needsRewrite = true;
        const bySeq = new Map();
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.seq)) continue;
            if (entry.seq <= result.snapshotSeq || bySeq.has(entry.seq)) continue;
            if (!entry.op || typeof entry.op !== 'object' || nestingTooDeep(entry.op, maxDepth)) continue;
            bySeq.set(entry.seq, entry);
        }
        // Only edits that follow on without a gap can be applied on top.
        let seq = result.snapshotSeq;
        while (bySeq.has(seq + 1)) {
            const entry = bySeq.get(seq + 1);
            const bytes = Number.isFinite(entry.bytes) && entry.bytes > 0 ? entry.bytes : JSON.stringify(entry.op).length;
            result.ops.push({seq: seq + 1, from: typeof entry.from === 'string' ? entry.from : '', op: entry.op, bytes});
            seq++;
        }
        if (bySeq.size > result.ops.length) {
            this.log(`[${id}] ${bySeq.size - result.ops.length} saved edits came after a gap and were skipped`);
        }
        // Anything skipped: write a clean file before adding new edits to it.
        if (result.ops.length !== entries.length) result.needsRewrite = true;
        result.seq = seq;
        return result;
    }

    /**
     * Marks a room as used just now (rooms nobody opens for a long time are
     * deleted; opening a room without editing it writes nothing else).
     * @param {string} id room code
     */
    touch (id) {
        const now = new Date();
        try {
            fs.utimesSync(this.file(`${id}.json`), now, now);
        } catch (e) {
            // not saved yet
        }
    }

    settings (room, snapshotFile) {
        return JSON.stringify({
            version: 2,
            // Near the start: if the file is ever cut off, it most likely
            // still shows whether the room has a password (see damagedPasswordHash).
            passwordHash: typeof room.passwordHash === 'string' ? room.passwordHash : null,
            snapshotFile,
            snapshotSeq: room.snapshotSeq,
            snapshotHash: room.snapshotHash,
            listed: room.listed,
            title: room.title,
            createdAt: room.createdAt
        });
    }

    /**
     * Saves a new snapshot with the edits after it, then removes older files.
     * @param {object} room the room
     * @returns {string} the snapshot's file name
     */
    saveSnapshot (room) {
        fs.mkdirSync(this.dataDir, {recursive: true});
        const name = `${room.id}.${room.snapshotSeq}.sb3`;
        const ops = opsText(room.ops);
        const older = this.snapshotFiles(room.id);
        // Settings first (see the top of this file). Except over a room saved
        // by an older version: its settings hold its edits and say which edit
        // its snapshot is at, so they're replaced only once the new files are there.
        const legacy = older.some(old => old.seq === null);
        if (!legacy) writeFileAtomic(this.file(`${room.id}.json`), this.settings(room, name));
        writeFileAtomic(this.file(name), room.snapshot);
        writeFileAtomic(this.file(`${room.id}.ops`), ops);
        if (legacy) writeFileAtomic(this.file(`${room.id}.json`), this.settings(room, name));
        let added = room.snapshot.length + Buffer.byteLength(ops);
        for (const old of older) {
            if (old.name === name) continue;
            try {
                const size = fs.statSync(this.file(old.name)).size;
                fs.unlinkSync(this.file(old.name));
                added -= size;
            } catch (e) {
                // already gone
            }
        }
        this.countBytes(added);
        return name;
    }

    /** Adds new edits to the end of "<room>.ops". */
    appendOps (room, entries) {
        const text = opsText(entries);
        fs.appendFileSync(this.file(`${room.id}.ops`), text);
        this.countBytes(Buffer.byteLength(text));
    }

    /** Keeps the used-space count right between full counts. */
    countBytes (bytes) {
        if (this.usageCache) this.usageCache.bytes = Math.max(0, this.usageCache.bytes + bytes);
    }

    /** Saves only the settings (listed, title, password hash...). */
    saveSettings (room, snapshotFile) {
        writeFileAtomic(this.file(`${room.id}.json`), this.settings(room, snapshotFile));
    }

    /** Bytes used by all room files (looked up at most once a minute). */
    usedBytes () {
        if (this.usageCache && Date.now() - this.usageCache.at < USAGE_CACHE_MS) return this.usageCache.bytes;
        let names;
        try {
            names = this.listFiles();
        } catch (e) {
            return this.usageCache ? this.usageCache.bytes : 0;
        }
        let bytes = 0;
        for (const name of names) {
            if (!ANY_ROOM_FILE.test(name)) continue;
            try {
                bytes += fs.statSync(this.file(name)).size;
            } catch (e) {
                // removed meanwhile
            }
        }
        this.usageCache = {at: Date.now(), bytes};
        return bytes;
    }

    /**
     * Deletes rooms nobody has used for `maxAgeMs`, and temporary files left by
     * a crash. Rooms that are open right now are never touched.
     * @param {number} maxAgeMs how long an unused room is kept
     * @param {function(string): boolean} isOpen whether a room is open
     * @returns {number} how many rooms were deleted
     */
    deleteUnused (maxAgeMs, isOpen) {
        const now = Date.now();
        const byRoom = new Map();
        for (const name of this.listFiles()) {
            const match = ANY_ROOM_FILE.exec(name);
            if (!match) continue;
            let stat;
            try {
                stat = fs.statSync(this.file(name));
            } catch (e) {
                continue;
            }
            if (TEMP_FILE.test(name) && now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
                try {
                    fs.unlinkSync(this.file(name));
                } catch (e) {
                    // ignore
                }
                continue;
            }
            const info = byRoom.get(match[1]) || {names: [], newest: 0};
            info.names.push(name);
            info.newest = Math.max(info.newest, stat.mtimeMs);
            byRoom.set(match[1], info);
        }
        let deleted = 0;
        for (const [id, info] of byRoom) {
            if (isOpen(id) || now - info.newest < maxAgeMs) continue;
            for (const name of info.names) {
                try {
                    fs.unlinkSync(this.file(name));
                } catch (e) {
                    // ignore
                }
            }
            deleted++;
        }
        if (deleted) this.usageCache = null;
        return deleted;
    }
}

module.exports = {RoomStore, isProjectFile, nestingTooDeep, ANY_ROOM_FILE};
