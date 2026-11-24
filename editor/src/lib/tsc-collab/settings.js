/* eslint-disable valid-jsdoc */
/**
 * Helpers for collaboration settings: saved name/server, room codes and
 * invite links (?room=abc&collab_server=ws://...).
 */

const NAME_KEY = 'tsc:collab-name';
const SERVER_KEY = 'tsc:collab-server';

const safeGet = key => {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
};

const safeSet = (key, value) => {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        // ignore (private mode, storage disabled)
    }
};

const loadSavedName = () => safeGet(NAME_KEY) || '';
const saveName = name => safeSet(NAME_KEY, name);
const loadSavedServer = () => safeGet(SERVER_KEY) || '';
const saveServer = server => safeSet(SERVER_KEY, server);

const isLocalHostname = hostname => (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === ''
);

/**
 * Where to look for the collaboration server by default:
 *  - a hosted build can bake one in (TSC_COLLAB_SERVER when building);
 *  - when the editor runs from your own computer (http), the server started
 *    next to it on port 8090;
 *  - on an https website like GitHub Pages there's no server next to the
 *    page, so the person has to type one in ('' means "ask").
 */
const defaultServerUrl = () => {
    if (process.env.TSC_COLLAB_SERVER) return process.env.TSC_COLLAB_SERVER;
    if (location.protocol === 'https:') return '';
    const host = location.hostname || 'localhost';
    return `ws://${host}:8090`;
};

/** A collaboration server's normal web address (ws://host:8090 → http://host:8090). */
const serverHttpUrl = serverUrl => serverUrl.trim()
    .replace(/^ws(s?):\/\//i, 'http$1://')
    .replace(/\/+$/, '');

const WORDS_A = ['turbo', 'pixel', 'cosmic', 'rapid', 'sunny', 'neon', 'happy', 'mega', 'super', 'swift'];
const WORDS_B = ['cats', 'rockets', 'blocks', 'gobos', 'dragons', 'comets', 'robots', 'waves', 'stars', 'tacos'];

const makeRoomCode = () => {
    const pick = list => list[Math.floor(Math.random() * list.length)];
    const number = Math.floor(Math.random() * 900) + 100;
    return `${pick(WORDS_A)}-${pick(WORDS_B)}-${number}`;
};

const makeInviteLink = (room, serverUrl) => {
    const url = new URL(location.href);
    url.hash = '';
    url.searchParams.set('room', room);
    // Always include the server so friends end up on the same one, whatever
    // server they used last time.
    if (serverUrl) {
        url.searchParams.set('collab_server', serverUrl);
    } else {
        url.searchParams.delete('collab_server');
    }
    return url.toString();
};

/** Reads ?room= and ?collab_server= from the page URL (invite links). */
const readInviteFromUrl = () => {
    try {
        const params = new URLSearchParams(location.search);
        const room = params.get('room');
        const server = params.get('collab_server');
        if (!room) return null;
        return {
            room,
            serverUrl: server && /^wss?:\/\//.test(server) ? server : null
        };
    } catch (e) {
        return null;
    }
};

export {
    loadSavedName,
    saveName,
    loadSavedServer,
    saveServer,
    isLocalHostname,
    defaultServerUrl,
    serverHttpUrl,
    makeRoomCode,
    makeInviteLink,
    readInviteFromUrl
};
