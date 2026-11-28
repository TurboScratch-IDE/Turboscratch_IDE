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
import {isDesktopApp, saveName, saveServer, serverHttpUrl} from './settings';

const PROTOCOL_VERSION = 1;
const PRESENCE_THROTTLE_MS = 250;
const PING_INTERVAL_MS = 15000;
const DEAD_CONNECTION_MS = 45000;
const MAX_MESSAGE_CHARS = 190 * 1024 * 1024;
// Server errors that reconnecting can't fix: the session ends with the message.
// Trying the same password again can't fix a password error either: the
// person has to type it again in the join form.
const FATAL_ERRORS = [
    'protocol', 'no-project', 'server-full', 'room-full', 'bad-room', 'origin',
    'password-needed', 'wrong-password', 'too-many-tries', 'bad-password'
];
// Room passwords are 4 to 100 characters long. The server refuses others, so
// they're checked here first to tell the person straight away.
const MIN_PASSWORD_LENGTH = 4;
const MAX_PASSWORD_LENGTH = 100;
const WARNING_COLOR = '#ffb020';
const DANGER_COLOR = '#e5484d';
const MIN_AUTO_RESYNC_INTERVAL_MS = 60000;
// Free hosting plans put idle servers to sleep; waking one can take ~1 minute.
const WAKE_UP_TIMEOUT_MS = 90000;
// A new connection sometimes fails on the way even though the server is fine
// (some tunnels, like playit.gg's HTTPS tunnels, drop a share of new browser
// connections). Before saying the server can't be reached, the first
// connection is tried again after each of these delays.
const FIRST_CONNECT_RETRY_DELAYS_MS = [1000, 2000, 3000];
// A server that's busy (checking many room passwords at once, say) answers
// a join with "busy" before letting it in. That join is tried again after
// each of these delays before the person is told.
const BUSY_RETRY_DELAYS_MS = [1000, 2000, 4000];
// The close code we use when we close a connection only to connect again
// (it looked dead). The server then keeps our place like after a dropped
// connection, so someone who got in before the room had its password isn't
// shut out. Leaving the room is a plain close: then the place isn't kept.
const RECONNECT_CLOSE_CODE = 4000;
const ROOM_UNLOCKED_MESSAGE = 'This room came back without its password, so you were taken out of it ' +
    'to keep your project private. Join again if you expected this.';
// A password was typed, but the room (or the whole server) has none.
const NO_PASSWORD_MESSAGE = 'This room has no password, so you weren\'t let in, to keep your project private. ' +
    'To join it anyway, empty the password box and join again.';
const NO_PASSWORDS_ON_SERVER_MESSAGE = 'This server doesn\'t support room passwords yet, so you weren\'t let in. ' +
    'Empty the password box to join without one.';
// Joined by choice after one of those, but the room asked for our project.
const NO_PROJECT_MESSAGE = 'This room has no project and no password. It may not be your friends\' room, ' +
    'so your project wasn\'t shared.';
// Servers from before the desktop app existed refuse it like an unknown
// website, and their message talks about "that website".
const DESKTOP_APP_REFUSED_MESSAGE = 'This server doesn\'t let the desktop app in yet. Its owner needs to update ' +
    'it. Until then, use the TurboScratch website to join.';

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
        // Where and who, and the room password the person typed. The password
        // only ever lives here, in memory: never in localStorage or in the
        // store, and it's forgotten on leave.
        this.joinParams = null;
        this.wantConnected = false;
        this.everWelcomed = false;
        // Whether the current connection got its welcome (it's in the room).
        // Errors before that are the server refusing the hello.
        this.welcomed = false;
        // The last room password we asked the server to set. It becomes the
        // password we reconnect with once the server says it was set.
        this.pendingPassword = null;
        // Whether we know the room has a password (a welcome or room-info
        // said so, and nobody removed it since). Kept when the person tries
        // the same room again.
        this.knownLocked = false;
        // Whether the room must have a password: we know it has one, or the
        // person typed one for this join. Sent in hello: if the server
        // forgot the room, it then refuses to create it again without a
        // password, instead of letting the first person who reconnects
        // bring it back open to everyone. A welcome into a room without one
        // is then left at once (see 'welcome').
        this.expectLocked = false;
        // Set when the person joins again, with the password box empty,
        // right after being taken out of a room that had no password: they
        // were told, and chose to join it as it is now. Only for that
        // join's welcome.
        this.acceptUnlocked = false;
        // Set once a join got into a room without a password only because
        // of that choice. Whoever is in it may not be the person's friends,
        // so it never gets our project (see 'need-snapshot').
        this.unlockedByChoice = false;
        this.reconnectAttempts = 0;
        this.firstConnectFailures = 0;
        this.busyRetries = 0;
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
     * @param {string} params.password a NEW room gets this password; an existing room with a
     *     password needs it to let you in, and an existing room without one isn't joined.
     *     Empty means none.
     */
    join ({serverUrl, room, name, listed, title, password}) {
        if (!this.vm) throw new Error('Collaboration is not ready yet');
        const previous = this.joinParams;
        const sameRoom = !!previous && previous.serverUrl === serverUrl && previous.room === room;
        const before = getState();
        const typedPassword = typeof password === 'string' && password ? password : null;
        this.leave(true);
        // Trying the same room again (say, after "This room has a password")
        // still knows it has one; another room starts fresh.
        if (!sameRoom) this.knownLocked = false;
        // A typed password means "a room with a password": a room without
        // one isn't joined (it may be a stranger's room with the same code).
        // Only for this join: trying again with the box empty doesn't
        // expect one, unless we know the room has one.
        this.expectLocked = this.knownLocked || !!typedPassword;
        // Joining the same room again, with the password box empty, after
        // being taken out of a room without a password ("room-unlocked") is
        // the person's choice to join it as it is. If we know it had a
        // password, the hello still says so, so a room the server forgot
        // isn't made again open: that needs the password typed.
        this.acceptUnlocked = sameRoom && !typedPassword && before.status === 'error' &&
            before.errorCode === 'room-unlocked';
        this.unlockedByChoice = false;
        // Only the name and server are remembered for next time, never the password.
        saveName(name);
        saveServer(serverUrl);
        this.joinParams = {
            serverUrl,
            room,
            name,
            listed: !!listed,
            title: title || null,
            password: typedPassword
        };
        this.resumeToken = null;
        this.wantConnected = true;
        this.everWelcomed = false;
        this.reconnectAttempts = 0;
        this.firstConnectFailures = 0;
        this.busyRetries = 0;
        setState({
            status: 'connecting',
            error: null,
            errorCode: null,
            room,
            serverUrl,
            title: null,
            listed: false,
            listSupported: false,
            locked: false,
            lockSupported: false,
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
        // Nothing reconnects after this, so the password isn't needed any more.
        if (this.joinParams) this.joinParams.password = null;
        this.pendingPassword = null;
        if (!quiet) {
            // They chose to leave (quiet is for a failed join or a new one).
            this.setKnownLocked(false);
            resetState();
        }
    }

    /**
     * What we now know about the room: whether it has a password (the
     * server said so, or we left and know nothing any more).
     * @param {boolean} locked whether it has one
     */
    setKnownLocked (locked) {
        this.knownLocked = locked;
        this.expectLocked = locked;
    }

    /**
     * Stop using the current connection: nothing more from it is handled.
     * @param {boolean} reconnecting true when we close it only to connect
     *     again, so the server keeps our place (see RECONNECT_CLOSE_CODE).
     */
    closeSocket (reconnecting) {
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
                if (reconnecting) {
                    ws.close(RECONNECT_CLOSE_CODE, 'reconnecting');
                } else {
                    ws.close();
                }
            } catch (e) {
                // ignore
            }
        }
        this.pendingAcks = 0;
    }

    openSocket () {
        const {serverUrl, room, name, listed, title, password} = this.joinParams;
        let ws;
        try {
            ws = new WebSocket(serverUrl);
        } catch (e) {
            this.fail(`That server address doesn't look right: ${serverUrl}`);
            return;
        }
        this.generation++;
        this.ws = ws;
        this.welcomed = false;
        this.pendingAcks = 0;
        this.lastMessageAt = Date.now();

        ws.onopen = () => {
            this.lastMessageAt = Date.now();
            const hello = {
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
            };
            // Sent on every (re)connect: a room with a password lets us in
            // with it, and a room the server forgot comes back with the same
            // password instead of open to everyone.
            if (password) hello.password = password;
            // Without the password, a room the server forgot is then not
            // created again open: we get "password-needed" instead. (With a
            // password, a new room gets it, as always.)
            if (this.expectLocked) hello.expectLocked = true;
            this.send(hello);
            // Notice connections that silently died (Wi-Fi dropped, laptop slept).
            clearInterval(this.pingTimer);
            this.pingTimer = setInterval(() => {
                if (this.ws !== ws) return;
                if (Date.now() - this.lastMessageAt > DEAD_CONNECTION_MS) {
                    log.warn('[collab] connection looks dead, reconnecting');
                    // handleClose closes it with the "reconnecting" code.
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
        // Everything after this connects again (or gives up on a first
        // connection that never got in). A connection that already closed
        // isn't closed twice: then this does nothing.
        this.closeSocket(true);
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
            pushToast(`${reason} Reconnecting…`, WARNING_COLOR);
        } else if (getState().status === 'connected') {
            pushToast('Connection lost. Changes you make until it reconnects won\'t be shared.', WARNING_COLOR);
        }
        setState({status: 'reconnecting'});
        const delay = Math.min(10000, 1000 * Math.pow(2, this.reconnectAttempts++));
        this.reconnectTimer = setTimeout(() => {
            if (this.wantConnected) this.openSocket();
        }, delay);
    }

    /**
     * End the session and show the join form with this message.
     * @param {string} message what went wrong, in plain words
     * @param {?string} code the server's error code, if the server refused us
     */
    fail (message, code) {
        // Someone who was in the room may have the dialog closed: without a
        // notice, the button would just quietly go back to "Collaborate"
        // while they keep editing alone.
        const wasInRoom = this.wantConnected && this.everWelcomed;
        this.leave(true);
        setState({status: 'error', error: message, errorCode: code || null, peers: [], me: null});
        if (wasInRoom) {
            const notice = `${message} You're not in the room any more: click Collaborate to join again.`;
            pushToast(notice, DANGER_COLOR);
            this.addSystemChat(notice);
        }
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
        case 'welcome': {
            const firstWelcome = !this.everWelcomed;
            const chosen = firstWelcome && this.acceptUnlocked;
            // We know this room has a password, or the person typed one, but
            // it let us in as a room without one (or an older server without
            // passwords did). The server may have forgotten the room, and
            // someone without the password made it again: they'd get our
            // project, edits and chat. So leave before anything else from
            // this connection is used: no project upload, no edits, no chat.
            // What we know stays, so a room the server forgot still isn't
            // made again open; joining again by hand with the password box
            // empty is the person's choice (acceptUnlocked).
            if (this.expectLocked && message.locked !== true && !chosen) {
                log.warn('[collab] the room has no password, leaving it');
                let text = ROOM_UNLOCKED_MESSAGE;
                if (firstWelcome && this.joinParams.password) {
                    // They typed a password for this join (and never got in).
                    text = typeof message.locked === 'boolean' ? NO_PASSWORD_MESSAGE : NO_PASSWORDS_ON_SERVER_MESSAGE;
                }
                this.fail(text, 'room-unlocked');
                break;
            }
            // Let in only because they chose to join the room as it is: until
            // the room's own project has loaded, ours never becomes its project.
            // A server without room passwords (no boolean "locked") can't have
            // lost a password, so there the room may get our project as usual,
            // unless we knew the room had a password.
            if (chosen && message.locked !== true && (typeof message.locked === 'boolean' || this.expectLocked)) {
                this.unlockedByChoice = true;
            }
            this.acceptUnlocked = false;
            this.everWelcomed = true;
            this.welcomed = true;
            this.reconnectAttempts = 0;
            this.resumeToken = typeof message.resume === 'string' ? message.resume : null;
            const title = typeof message.title === 'string' && message.title ? message.title : null;
            const locked = message.locked === true;
            // Older servers have no room passwords (no "locked" in welcome).
            const lockSupported = typeof message.locked === 'boolean';
            setState({
                status: 'syncing',
                error: null,
                errorCode: null,
                // The server cleans up names (invisible characters...): show
                // the name everyone else sees.
                me: {
                    id: message.id,
                    name: typeof message.name === 'string' ? message.name : this.joinParams.name,
                    color: message.color
                },
                peers: message.peers || [],
                title,
                listed: message.listed === true,
                // Older servers have no room list (no "listed" in welcome).
                listSupported: typeof message.listed === 'boolean',
                locked,
                lockSupported
            });
            // If the server restarts and forgets the room, whoever reconnects
            // first creates it again: it must come back as it really was
            // (listed or not, same title), not as this person's join form said.
            this.joinParams.listed = message.listed === true;
            this.joinParams.title = title;
            if (!locked) {
                // The same goes for the password: a room without one must
                // not come back with one, or the others couldn't get in any
                // more. (A room we expected to have one, or a typed
                // password, never gets here, unless the person chose to
                // join it again as it is, with the password box empty.)
                this.joinParams.password = null;
            }
            this.setKnownLocked(locked);
            break;
        }

        case 'room-info':
            this.handleRoomInfo(message);
            break;

        case 'need-snapshot':
            if (this.unlockedByChoice) {
                // A room without a password and without a project, joined
                // by choice: whoever made it may have used our friends' room
                // code to get our project. Leave before it's sent.
                log.warn('[collab] not sharing the project with a room without a password');
                this.fail(NO_PROJECT_MESSAGE, 'room-unlocked');
                break;
            }
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
                const {room, listed, locked} = getState();
                this.addSystemChat((listed ?
                    `You created room "${room}". It's in Open rooms, so others can join it from there.` :
                    `You created room "${room}". Share the invite link!`) +
                    (locked ? ' Friends also need the room password.' : ''));
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
                // We now have the room's own project: sending it back later
                // (after a server restart) shares nothing new.
                this.unlockedByChoice = false;
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
            // The answer to a room-settings change we asked for (a password
            // that was too short, or a server too busy to set it). We're
            // still in the room: just say so. (Servers from before "for"
            // sent these without it, so they're recognised by their code.)
            if (message.for === 'room-settings' || (this.welcomed && (message.code === 'bad-password' ||
                (message.code === 'busy' && this.pendingPassword !== null)))) {
                this.handleSettingsError(message);
                break;
            }
            // A busy server may let the join in a moment later: try again
            // (still "Connecting…") before telling the person.
            if (!this.everWelcomed && message.code === 'busy' && this.busyRetries < BUSY_RETRY_DELAYS_MS.length) {
                this.retryBusyJoin();
                break;
            }
            // Errors that reconnecting can't fix end the session with a message.
            if (!this.everWelcomed || FATAL_ERRORS.includes(message.code)) {
                let text = message.message || 'The server refused the connection.';
                if (message.code === 'origin' && isDesktopApp()) text = DESKTOP_APP_REFUSED_MESSAGE;
                this.fail(text, typeof message.code === 'string' ? message.code : null);
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

    /**
     * The server answered the join with "busy" before letting us in: drop
     * this connection and try again a bit later. Cancel (leave) stops it.
     */
    retryBusyJoin () {
        const delay = BUSY_RETRY_DELAYS_MS[this.busyRetries++];
        log.warn(`[collab] the server is busy, trying again in ${delay} ms`);
        // We never got in, so a plain close (the server closes it anyway).
        this.closeSocket();
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            if (this.wantConnected && !this.ws) this.openSocket();
        }, delay);
    }

    /**
     * The server refused a room-settings change we sent, and the connection
     * stays open. It's shown, never kept as the reason for a later
     * disconnect, and the password we asked for is never used to reconnect.
     */
    handleSettingsError (message) {
        this.pendingPassword = null;
        let text;
        if (typeof message.message === 'string' && message.message) {
            text = message.message;
        } else if (message.code === 'busy') {
            text = 'The server was too busy to change the room\'s settings. Try again in a minute.';
        } else {
            text = 'That password can\'t be used.';
        }
        pushToast(text, WARNING_COLOR);
        this.addSystemChat(text);
    }

    /**
     * Someone in the room changed its settings: Open rooms, its name or its
     * password. ("changed" says which; older servers only send this for
     * Open rooms, and without "changed" or "locked".)
     */
    handleRoomInfo (message) {
        const before = getState();
        const listed = message.listed === true;
        const title = typeof message.title === 'string' && message.title ? message.title : null;
        const locked = typeof message.locked === 'boolean' ? message.locked : before.locked;
        const mine = !!before.me && message.by === before.me.id;
        const who = mine ? 'You' : this.peerName(message.by);
        // A room the server forgot is created again from these: keep them
        // as the room really is now.
        this.joinParams.listed = listed;
        this.joinParams.title = title;
        if (locked) this.setKnownLocked(true);
        setState({listed, title, locked});

        switch (message.changed) {
        case 'title':
            this.addSystemChat(title ?
                `${who} renamed the room to "${title}"` :
                `${who} removed the room's name`);
            break;
        case 'password-set':
            if (mine && this.pendingPassword) {
                // Our own change went through: reconnect with the new
                // password from now on, or we'd lock ourselves out.
                this.joinParams.password = this.pendingPassword;
                this.pendingPassword = null;
            } else {
                // Someone else's: the password we had (if any) is now wrong.
                // Sending it again on a reconnect would count as a wrong
                // guess, and enough of those lock everyone out for a while.
                // Without one, the server just answers "password-needed"
                // (unless it remembers us), which counts for nothing.
                this.joinParams.password = null;
            }
            this.addSystemChat(mine ?
                'You set a new password for this room. Friends who join need it.' :
                `${who} set a new password for this room. Ask them for it: ` +
                'you\'ll need it if you get disconnected.');
            break;
        case 'password-removed':
            // (A password change we sent may still be on its way: the server
            // takes a moment to scramble it, so pendingPassword stays for it.)
            this.joinParams.password = null;
            this.setKnownLocked(false);
            this.addSystemChat(`${who} removed the room's password. Anyone with the room code can join now.`);
            break;
        default:
            // 'listed', or an older server that only has Open rooms.
            if (listed === before.listed) break;
            if (!listed) {
                this.addSystemChat(`${who} hid this room from Open rooms. ` +
                    'People who know the room code can still join.');
            } else if (locked) {
                this.addSystemChat(`${who} put this room in Open rooms. People on this server can find it there, ` +
                    'but they need the password to join.');
            } else {
                this.addSystemChat(`${who} put this room in Open rooms. Anyone on this server can join.`);
            }
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

    /**
     * Give the room a new name ('' removes it, then the room code is shown).
     * Everyone sees the change when the server sends room-info.
     * @param {string} title the new name
     * @returns {boolean} whether it was sent
     */
    renameRoom (title) {
        if (!this.isLive()) return false;
        return this.send({t: 'room-settings', title: typeof title === 'string' ? title.trim() : ''});
    }

    /**
     * Set or change the room's password, or remove it (null or '').
     * The password we reconnect with only changes once the server confirms
     * it, so a refused change can't lock us out.
     * @param {?string} password the new password, 4 to 100 characters
     * @returns {boolean} whether it was sent (false for a wrong length)
     */
    setRoomPassword (password) {
        if (!this.isLive()) return false;
        if (typeof password !== 'string' || password === '') {
            return this.send({t: 'room-settings', password: null});
        }
        if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) return false;
        if (!this.send({t: 'room-settings', password})) return false;
        this.pendingPassword = password;
        return true;
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
export {getCollabSession, CollabSession, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH};
