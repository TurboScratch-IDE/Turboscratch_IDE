/* eslint-disable valid-jsdoc */
/**
 * Helpers for collaboration settings: saved name/server, room codes and
 * invite links (?room=abc&collab_server=ws://...).
 */

const NAME_KEY = 'tsc:collab-name';
const SERVER_KEY = 'tsc:collab-server';
// The website's own default server at the moment the server above was saved.
const SERVER_DEFAULT_KEY = 'tsc:collab-server-default';

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

const isLocalHostname = hostname => (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === ''
);

/**
 * The default server when the build doesn't name one: the server started
 * next to the editor on your own computer (http), or none at all on an https
 * website like GitHub Pages ('' means "ask").
 */
const pageDefaultServerUrl = () => {
    if (location.protocol === 'https:') return '';
    const host = location.hostname || 'localhost';
    return `ws://${host}:8090`;
};

/**
 * Where to look for the collaboration server by default:
 *  - a hosted build can bake one in (TSC_COLLAB_SERVER when building);
 *  - when the editor runs from your own computer (http), the server started
 *    next to it on port 8090;
 *  - on an https website like GitHub Pages there's no server next to the
 *    page, so the person has to type one in ('' means "ask").
 */
const defaultServerUrl = () => process.env.TSC_COLLAB_SERVER || pageDefaultServerUrl();

/**
 * Remembers the server someone joined, and which default server the website
 * had then, so loadSavedServer can tell when the website got a new one.
 * @param {string} server the server's address
 */
const saveServer = server => {
    safeSet(SERVER_KEY, server);
    safeSet(SERVER_DEFAULT_KEY, defaultServerUrl());
};

/**
 * The server someone used last time, or null to use the default.
 * Someone who once typed a server (maybe because the website had none) would
 * otherwise never notice when the website gets a default server of its own:
 * their old one would stay in the box. So when the website's default changed
 * since the server was saved, the new default wins, once. A server they pick
 * after that is kept again.
 * @returns {?string} the saved server, or null when there's none or it's out of date
 */
const loadSavedServer = () => {
    const saved = safeGet(SERVER_KEY);
    if (!saved) return null;
    let savedDefault = safeGet(SERVER_DEFAULT_KEY);
    // Saved by an editor from before this was remembered: back then, the
    // website's default was whatever the page itself gives ('' on https).
    if (savedDefault === null) savedDefault = pageDefaultServerUrl();
    return savedDefault === defaultServerUrl() ? saved : null;
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
