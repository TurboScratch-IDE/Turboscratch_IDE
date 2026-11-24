/**
 * The room list ("Open rooms"): rooms that people chose to show to everyone
 * on the collaboration server, so friends can join without an invite link.
 *
 * Copyright (C) 2026 TurboScratch IDE contributors. GPL-3.0.
 */
import {useEffect, useState} from 'react';
import {serverHttpUrl} from './settings';

const REFRESH_MS = 5000;
const TYPING_DELAY_MS = 600;
const MAX_ROOMS = 100;

const isServerUrl = serverUrl => /^wss?:\/\/[^\s/]+/i.test(serverUrl.trim());

/**
 * Keeps only what the list shows, in the shape it expects.
 * @param {*} raw one room from the server's answer
 * @returns {?object} the room, or null if it doesn't look right
 */
const cleanRoom = raw => {
    if (!raw || typeof raw.room !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(raw.room)) return null;
    return {
        room: raw.room,
        title: typeof raw.title === 'string' && raw.title ? raw.title.slice(0, 60) : null,
        people: Number.isInteger(raw.people) && raw.people > 0 ? raw.people : 0,
        names: Array.isArray(raw.names) ?
            raw.names.filter(name => typeof name === 'string').slice(0, 5)
                .map(name => name.slice(0, 24)) :
            []
    };
};

class NoRoomList extends Error {}

/**
 * @param {string} serverUrl the ws:// or wss:// server address
 * @param {AbortSignal} signal cancels the request
 * @returns {Promise<Array<{room: string, title: ?string, people: number, names: string[]}>>} the rooms
 */
const fetchRoomList = async (serverUrl, signal) => {
    const response = await fetch(`${serverHttpUrl(serverUrl)}/rooms`, {cache: 'no-store', signal});
    // Servers from before the room list existed answer 404.
    if (response.status === 404) throw new NoRoomList();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.rooms)) throw new Error('Unexpected answer');
    return data.rooms.slice(0, MAX_ROOMS).map(cleanRoom)
        .filter(Boolean);
};

/**
 * The room list of a server, refreshed every few seconds while it's shown.
 * @param {string} serverUrl the ws:// or wss:// server address
 * @returns {{rooms: ?Array, error: ?string}} rooms is null until the first answer
 */
const useRoomList = serverUrl => {
    const [result, setResult] = useState({rooms: null, error: null});
    useEffect(() => {
        setResult({rooms: null, error: null});
        if (!isServerUrl(serverUrl)) return;
        let stopped = false;
        let controller = null;
        let timer = null;
        const load = async () => {
            controller = new AbortController();
            try {
                const rooms = await fetchRoomList(serverUrl, controller.signal);
                if (!stopped) setResult({rooms, error: null});
            } catch (e) {
                if (stopped) return;
                setResult(previous => ({
                    // Keep showing the last list if one refresh fails.
                    rooms: previous.rooms,
                    error: e instanceof NoRoomList ?
                        'This server doesn\'t have a room list yet (it needs an update).' :
                        'Couldn\'t load the room list from this server.'
                }));
            }
            if (!stopped) timer = setTimeout(load, REFRESH_MS);
        };
        // Wait until the address has stopped changing (someone typing it).
        timer = setTimeout(load, TYPING_DELAY_MS);
        return () => {
            stopped = true;
            clearTimeout(timer);
            if (controller) controller.abort();
        };
    }, [serverUrl]);
    return result;
};

export {fetchRoomList, isServerUrl, useRoomList};
