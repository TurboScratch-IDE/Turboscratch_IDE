/* eslint-disable valid-jsdoc */
/**
 * TurboScratch IDE real-time collaboration session.
 *
 * Talks to collab-server over WebSocket. All edits in a room are put in one
 * order by the server (each gets a sequence number). This file deals with the
 * connection, ordering, snapshots, chat and presence; vm-sync.js turns local
 * edits into "ops" and applies other people's ops to the project.
 *
 * Self-healing: whenever the room goes quiet, the server stores a snapshot and
 * tells everyone its fingerprint. Anyone whose project ended up different
 * (for example two people changed the same thing at the same moment) reloads
 * the room's copy, so everybody converges again.
 *
 * Copyright (C) 2026 TurboScratch IDE contributors. GPL-3.0.
 */

import log from '../log';
import {base64ToArrayBuffer, arrayBufferToBase64} from '../tw-base64-utils';
import VMSync from './vm-sync';
import {getState, setState, resetState, pushToast} from './store';
import {saveName, saveServer, serverHttpUrl} from './settings';

const PROTOCOL_VERSION = 1;
const PRESENCE_THROTTLE_MS = 250;
const PING_INTERVAL_MS = 15000;
const DEAD_CONNECTION_MS = 45000;
const MAX_MESSAGE_CHARS = 190 * 1024 * 1024;
// Server errors that reconnecting can't fix: the session ends with the message.
const FATAL_ERRORS = ['protocol', 'no-project', 'server-full', 'room-full', 'bad-room', 'origin'];
const MIN_AUTO_RESYNC_INTERVAL_MS = 60000;
// Free hosting plans put idle servers to sleep; waking one can take ~1 minute.
const WAKE_UP_TIMEOUT_MS = 90000;
// A new connection sometimes fails on the way even though the server is fine
// (some tunnels, like playit.gg's HTTPS tunnels, drop a share of new browser
// connections). Before saying the server can't be reached, the first
// connection is tried again after each of these delays.
const FIRST_CONNECT_RETRY_DELAYS_MS = [1000, 2000, 3000];

/**
 * Asks the server's normal web address for /health first. A sleeping free
 * server wakes up on that request, which is more reliable than waiting on a
 * WebSocket handshake. Failures are ignored: the WebSocket attempt that
 * follows reports any real problem.
 */
const wakeServer = async serverUrl => {
    if (typeof fetch !== 'function' || typeof AbortController !== 'function') return;
    const httpUrl = `${serverHttpUrl(serverUrl)}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WAKE_UP_TIMEOUT_MS);
    try {
        await fetch(httpUrl, {cache: 'no-store', signal: controller.signal});
    } catch (e) {
        // ignore
    } finally {
        clearTimeout(timer);
    }
};

let chatKey = 0;

class CollabSession {
    constructor () {
        this.vm = null;
        this.sync = null;
        this.ws = null;
        this.joinParams = null;
        this.wantConnected = false;
        this.everWelcomed = false;
        this.reconnectAttempts = 0;
        this.firstConnectFailures = 0;
        this.reconnectTimer = null;
        this.pingTimer = null;
        this.lastMessageAt = 0;
        // Given by the server in welcome; sent back when reconnecting.
        this.resumeToken = null;
        // The last error the server sent before closing the connection.
        this.lastServerError = null;

        // Highest sequence number of other people's ops applied here (in order).
        this.appliedSeq = 0;
        // Highest sequence number the server gave one of our own ops.
        this.ackSeq = 0;
        // Ops sent that the server has not acknowledged yet.
        this.pendingAcks = 0;
        this.nextRef = 1;

        // Incoming messages that change the project are handled strictly in
        // order. `generation` changes on every (re)connect so tasks queued by an
        // old connection are skipped instead of running alongside the new one.
        this.incoming = Promise.resolve();
        this.generation = 0;
        this.lastAutoResync = 0;
        this.snapshotWanted = false;
        this.snapshotRetryTimer = null;

        this.presenceTimer = null;
        this.lastPresenceTarget = null;

        this.handleLocalOp = this.handleLocalOp.bind(this);
        this.handleTargetsUpdate = this.handleTargetsUpdate.bind(this);
    }

    /**
     * Called once the editor's VM exists. Safe to call more than once.
     * @param {VirtualMachine} vm the editor's VM
     */
    attachVM (vm) {
        if (this.vm === vm) return;
        if (this.vm) {
            this.vm.removeListener('targetsUpdate', this.handleTargetsUpdate);
            if (this.sync) this.sync.uninstall();
        }
        this.vm = vm;
        this.sync = new VMSync(vm, this.handleLocalOp);
        this.sync.onFatal = message => this.fail(message);
        this.sync.install();
        vm.on('targetsUpdate', this.handleTargetsUpdate);
    }

    isLive () {
        return getState().status === 'connected';
    }

    /** The room's state this client has fully caught up with. */
    currentSeq () {
        return Math.max(this.appliedSeq, this.ackSeq);
    }

    // ---- connection -------------------------------------------------------

    /**
     * @param {object} params where and who
     * @param {boolean} params.listed show a NEW room in the room list (ignored for existing rooms)
     * @param {string} params.title the room's name in the room list (ignored for existing rooms)
     */
    join ({serverUrl, room, name, listed, title}) {
        if (!this.vm) throw new Error('Collaboration is not ready yet');
        this.leave(true);
        saveName(name);
        saveServer(serverUrl);
        this.joinParams = {serverUrl, room, name, listed: !!listed, title: title || null};
        this.resumeToken = null;
        this.wantConnected = true;
        this.everWelcomed = false;
        this.reconnectAttempts = 0;
        this.firstConnectFailures = 0;
        setState({
            status: 'connecting',
            error: null,
            room,
            serverUrl,
            listed: false,
            listSupported: false,
            me: null,
            peers: [],
            chat: [],
            unreadChat: 0
        });
        const params = this.joinParams;
        wakeServer(serverUrl).then(() => {
            // Still the same join (not cancelled or replaced meanwhile)?
            if (this.wantConnected && this.joinParams === params && !this.ws) this.openSocket();
        });
    }

    leave (quiet) {
        this.wantConnected = false;
        clearTimeout(this.reconnectTimer);
        this.closeSocket();
        if (!quiet) resetState();
    }

    closeSocket () {
        this.generation++;
        this.snapshotWanted = false;
        clearTimeout(this.snapshotRetryTimer);
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        if (this.sync) this.sync.setCapturing(false);
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
            try {
                ws.close();
            } catch (e) {
                // ignore
            }
        }
        this.pendingAcks = 0;
    }

    openSocket () {
        const {serverUrl, room, name, listed, title} = this.joinParams;
        let ws;
        try {
            ws = new WebSocket(serverUrl);
        } catch (e) {
            this.fail(`That server address doesn't look right: ${serverUrl}`);
            return;
        }
        this.generation++;
        this.ws = ws;
        this.pendingAcks = 0;
        this.lastMessageAt = Date.now();

        ws.onopen = () => {
            this.lastMessageAt = Date.now();
            this.send({
                t: 'hello',
                protocol: PROTOCOL_VERSION,
                room,
                name,
                color: getState().me ? getState().me.color : null,
                // Only used if this creates the room.
                listed,
                title,
                // After a dropped connection: lets a room creator whose project
                // hadn't arrived yet take their place back.
                resume: this.resumeToken
            });
            // Notice connections that silently died (Wi-Fi dropped, laptop slept).
            clearInterval(this.pingTimer);
            this.pingTimer = setInterval(() => {
                if (this.ws !== ws) return;
                if (Date.now() - this.lastMessageAt > DEAD_CONNECTION_MS) {
                    log.warn('[collab] connection looks dead, reconnecting');
                    ws.close();
                    this.handleClose(ws);
                    return;
                }
                this.send({t: 'ping'});
            }, PING_INTERVAL_MS);
        };
        ws.onmessage = e => {
            this.lastMessageAt = Date.now();
            let message;
            try {
                message = JSON.parse(e.data);
            } catch (err) {
                return;
            }
            this.handleMessage(message);
        };
        ws.onclose = () => this.handleClose(ws);
        ws.onerror = () => {
            // onclose handles it
        };
    }

    handleClose (ws) {
        if (this.ws !== ws) return;
        this.closeSocket();
        if (!this.wantConnected) return;
        const {serverUrl} = this.joinParams;
        if (!this.everWelcomed) {
            if (this.firstConnectFailures < FIRST_CONNECT_RETRY_DELAYS_MS.length) {
                // Still "Connecting to the server…" as far as the person can tell.
                const delay = FIRST_CONNECT_RETRY_DELAYS_MS[this.firstConnectFailures++];
                log.warn(`[collab] could not connect to ${serverUrl}, trying again in ${delay} ms`);
                this.reconnectTimer = setTimeout(() => {
                    if (this.wantConnected && !this.ws) this.openSocket();
                }, delay);
                return;
            }
            this.fail(
                `Couldn't connect to the collaboration server at ${serverUrl}. ` +
                'Is it running? (Start it with "npm start" in the collab-server folder.)'
            );
            return;
        }
        // The server may have just said why it closed the connection.
        const reason = this.lastServerError && Date.now() - this.lastServerError.at < 10000 ?
            this.lastServerError.message :
            null;
        this.lastServerError = null;
        if (reason) {
            pushToast(`${reason} Reconnecting…`, '#ffb020');
        } else if (getState().status === 'connected') {
            pushToast('Connection lost. Changes you make until it reconnects won\'t be shared.', '#ffb020');
        }
        setState({status: 'reconnecting'});
        const delay = Math.min(10000, 1000 * Math.pow(2, this.reconnectAttempts++));
        this.reconnectTimer = setTimeout(() => {
            if (this.wantConnected) this.openSocket();
        }, delay);
    }

    fail (message) {
        this.leave(true);
        setState({status: 'error', error: message, peers: [], me: null});
    }

    send (message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
            return true;
        }
        return false;
    }

    /** Run a task after every earlier incoming task has finished. */
    enqueue (task) {
        const generation = this.generation;
        this.incoming = this.incoming
            .then(() => (generation === this.generation ? task() : null))
            .catch(e => {
                log.error('[collab] error handling message', e);
            });
        return this.incoming;
    }

    // ---- incoming ---------------------------------------------------------

    handleMessage (message) {
        switch (message.t) {
        case 'welcome':
            this.everWelcomed = true;
            this.reconnectAttempts = 0;
            this.resumeToken = typeof message.resume === 'string' ? message.resume : null;
            setState({
                status: 'syncing',
                error: null,
                // The server cleans up names (invisible characters...): show
                // the name everyone else sees.
                me: {
                    id: message.id,
                    name: typeof message.name === 'string' ? message.name : this.joinParams.name,
                    color: message.color
                },
                peers: message.peers || [],
                listed: message.listed === true,
                // Older servers have no room list (no "listed" in welcome).
                listSupported: typeof message.listed === 'boolean'
            });
            // If the server restarts and forgets the room, whoever reconnects
            // first creates it again: it must come back as it really was
            // (listed or not, same title), not as this person's join form said.
            this.joinParams.listed = message.listed === true;
            this.joinParams.title = typeof message.title === 'string' ? message.title : null;
            break;

        case 'room-info': {
            const listed = message.listed === true;
            this.joinParams.listed = listed;
            if (listed === getState().listed) break;
            setState({listed});
            const me = getState().me;
            const who = me && message.by === me.id ? 'You' : this.peerName(message.by);
            this.addSystemChat(listed ?
                `${who} put this room in Open rooms. Anyone on this server can join.` :
                `${who} hid this room from Open rooms. People who know the room code can still join.`);
            break;
        }

        case 'need-snapshot':
            // We're first in a new room: our project becomes the room's project.
            this.enqueue(async () => {
                this.appliedSeq = this.ackSeq = message.seq || 0;
                const generation = this.generation;
                const sent = await this.uploadSnapshotNow();
                if (generation !== this.generation) return;
                if (!sent) {
                    // Nobody could join a room without a project; don't pretend.
                    this.fail('Your project couldn\'t be shared: it may be too big for the collaboration ' +
                        'server. Try a smaller project.');
                    return;
                }
                this.becomeLive();
                this.addSystemChat(getState().listed ?
                    `You created room "${getState().room}". It's in Open rooms, so others can join it from there.` :
                    `You created room "${getState().room}". Share the invite link!`);
            });
            break;

        case 'snapshot':
            this.enqueue(async () => {
                this.sync.setCapturing(false);
                setState({status: 'syncing'});
                try {
                    await this.sync.loadSnapshot(base64ToArrayBuffer(message.data));
                } catch (e) {
                    log.error('[collab] could not load the room project', e);
                    // Don't keep going on a half-loaded project: it could later
                    // be uploaded as the room's project and wipe everyone's work.
                    this.fail('Could not load the room\'s project. Try joining again.');
                    return;
                }
                this.appliedSeq = message.seq;
                this.ackSeq = message.seq;
            });
            break;

        case 'caught-up':
            this.enqueue(() => {
                this.becomeLive();
            });
            break;

        case 'op':
            this.enqueue(async () => {
                if (message.seq <= this.appliedSeq) return;
                this.appliedSeq = message.seq;
                await this.sync.applyRemote(message.op, this.peerName(message.from));
            });
            break;

        case 'ack':
            // Queued like everything else: the server numbered our edit after
            // every op it sent us before this ack, so only once those are
            // applied may our project say it's at this number (a snapshot
            // labelled with it would otherwise miss someone else's edit).
            this.enqueue(() => {
                this.pendingAcks = Math.max(0, this.pendingAcks - 1);
                if (message.seq > this.ackSeq) this.ackSeq = message.seq;
                this.trySnapshotUpload();
            });
            break;

        case 'request-snapshot':
            this.snapshotWanted = true;
            this.trySnapshotUpload();
            break;

        case 'checkpoint':
            this.enqueue(() => this.verifyCheckpoint(message));
            break;

        case 'peer-join':
            setState(s => ({peers: s.peers.filter(p => p.id !== message.peer.id).concat([message.peer])}));
            pushToast(`${message.peer.name} joined`, message.peer.color);
            this.addSystemChat(`${message.peer.name} joined`);
            break;

        case 'peer-leave': {
            const peer = getState().peers.find(p => p.id === message.id);
            setState(s => ({peers: s.peers.filter(p => p.id !== message.id)}));
            if (peer) {
                pushToast(`${peer.name} left`, peer.color);
                this.addSystemChat(`${peer.name} left`);
            }
            break;
        }

        case 'presence':
            setState(s => ({
                peers: s.peers.map(p => (p.id === message.id ? Object.assign({}, p, {presence: message.presence}) : p))
            }));
            break;

        case 'chat': {
            const mine = getState().me && message.id === getState().me.id;
            setState(s => ({
                chat: s.chat.concat([{
                    key: ++chatKey,
                    id: message.id,
                    name: message.name,
                    color: message.color,
                    text: message.text,
                    time: message.time,
                    mine
                }]).slice(-200),
                unreadChat: mine ? s.unreadChat : s.unreadChat + 1
            }));
            if (!mine) pushToast(`${message.name}: ${message.text.slice(0, 60)}`, message.color);
            break;
        }

        case 'error':
            // Errors that reconnecting can't fix end the session with a message.
            if (!this.everWelcomed || FATAL_ERRORS.includes(message.code)) {
                this.fail(message.message || 'The server refused the connection.');
            } else {
                log.warn('[collab] server error', message);
                // Shown when the connection closes (most errors close it).
                if (typeof message.message === 'string') {
                    this.lastServerError = {message: message.message, at: Date.now()};
                }
            }
            break;
        }
    }

    becomeLive () {
        if (!this.wantConnected) return;
        setState({status: 'connected'});
        this.sync.setCapturing(true);
        this.lastPresenceTarget = null;
        this.sendPresenceSoon();
        // The server may have asked for a snapshot while we were catching up.
        this.trySnapshotUpload();
    }

    /** True when none of our own edits are still on their way to the server. */
    isQuiet () {
        return this.pendingAcks === 0 && !this.sync.hasPendingOutgoing();
    }

    /**
     * The server asked for a snapshot. It must contain exactly the ops up to
     * its sequence number, so it's only taken when none of our own edits are
     * in flight, from inside the incoming queue. Queuing it right when we
     * become quiet (e.g. on an ack) guarantees every op the server sent before
     * that ack is applied first, without holding up the queue while waiting.
     */
    trySnapshotUpload () {
        if (!this.snapshotWanted || !this.isLive()) return;
        if (!this.isQuiet()) {
            // Our edits may still be leaving the outgoing queue; look again soon.
            clearTimeout(this.snapshotRetryTimer);
            this.snapshotRetryTimer = setTimeout(() => this.trySnapshotUpload(), 200);
            return;
        }
        this.snapshotWanted = false;
        this.enqueue(async () => {
            if (!this.isQuiet()) {
                this.snapshotWanted = true;
                this.trySnapshotUpload();
                return;
            }
            await this.uploadSnapshotNow();
        });
    }

    /** @returns {Promise<boolean>} whether the snapshot was sent */
    async uploadSnapshotNow () {
        if (!this.vm.runtime.getTargetForStage()) {
            // Never offer an empty project as the room's copy.
            log.warn('[collab] not uploading a snapshot: no project loaded');
            return false;
        }
        const generation = this.generation;
        const {seq, data, hash} = await this.sync.saveSnapshot(() => this.currentSeq());
        // Zipping takes a while. If the connection was replaced meanwhile, this
        // snapshot's numbers belong to the old connection: never send it.
        if (generation !== this.generation) return false;
        const message = JSON.stringify({t: 'snapshot', seq, hash, data: arrayBufferToBase64(data)});
        if (message.length > MAX_MESSAGE_CHARS) {
            pushToast('This project is too big to share through the collaboration server.', null);
            return false;
        }
        return this.send(message);
    }

    /**
     * The room just saved a snapshot. If we're at exactly the same point,
     * our project should match it; if not, reload the room's copy.
     */
    async verifyCheckpoint (message) {
        if (!this.isLive() || typeof message.hash !== 'string') return;
        if (this.currentSeq() !== message.seq || !this.isQuiet()) return;
        const hash = await this.sync.fingerprint();
        if (hash === message.hash) return;
        if (Date.now() - this.lastAutoResync < MIN_AUTO_RESYNC_INTERVAL_MS) return;
        this.lastAutoResync = Date.now();
        log.warn('[collab] project differs from the room, reloading it');
        pushToast('Your project got out of sync, so it was reloaded from the room.', null);
        this.resync();
    }

    // ---- outgoing ---------------------------------------------------------

    handleLocalOp (op) {
        if (!this.isLive()) return;
        const message = JSON.stringify({t: 'op', ref: this.nextRef++, op});
        if (message.length > MAX_MESSAGE_CHARS) {
            pushToast('That change is too big to share (try a smaller file).', null);
            return;
        }
        if (this.send(message)) {
            this.pendingAcks++;
        }
    }

    handleTargetsUpdate () {
        this.sendPresenceSoon();
    }

    sendPresenceSoon () {
        if (this.presenceTimer || !this.isLive()) return;
        this.presenceTimer = setTimeout(() => {
            this.presenceTimer = null;
            if (!this.isLive()) return;
            const target = this.vm.editingTarget ? this.vm.editingTarget.getName() : null;
            if (target === this.lastPresenceTarget) return;
            this.lastPresenceTarget = target;
            this.send({t: 'presence', presence: {target}});
        }, PRESENCE_THROTTLE_MS);
    }

    sendChat (text) {
        this.send({t: 'chat', text});
    }

    /** Show the room in the room list, or make it private (invite link only). */
    setListed (listed) {
        if (!this.isLive()) return;
        this.send({t: 'room-settings', listed: !!listed});
    }

    addSystemChat (text) {
        setState(s => ({
            chat: s.chat.concat([{key: ++chatKey, text, system: true, time: Date.now()}]).slice(-200)
        }));
    }

    markChatRead () {
        if (getState().unreadChat !== 0) setState({unreadChat: 0});
    }

    /** Throw away the local copy and reload the project from the room. */
    resync () {
        if (!this.isLive()) return;
        this.sync.setCapturing(false);
        setState({status: 'syncing'});
        this.send({t: 'resync'});
    }

    peerName (id) {
        const peer = getState().peers.find(p => p.id === id);
        return peer ? peer.name : 'Someone';
    }
}

let session = null;
const getCollabSession = () => {
    if (!session) session = new CollabSession();
    return session;
};

// The class itself is exported for the unit tests.
export {getCollabSession, CollabSession};
