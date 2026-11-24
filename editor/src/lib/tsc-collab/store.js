/**
 * Tiny observable store for TurboScratch collaboration state, shared by the
 * session (which writes) and React components (which read via useCollabState).
 */
import {useEffect, useState} from 'react';

const initialState = {
    /** idle | connecting | syncing | connected | reconnecting | error */
    status: 'idle',
    error: null,
    room: null,
    serverUrl: null,
    /** Whether the room shows up in the room list ("Open rooms"). */
    listed: false,
    /** False on older servers that have no room list. */
    listSupported: false,
    /** @type {null|{id: string, name: string, color: string}} */
    me: null,
    /** @type {Array<{id: string, name: string, color: string, presence: {target?: string}}>} */
    peers: [],
    // [{key, id, name, color, text, time, mine, system?}]
    chat: [],
    unreadChat: 0,
    /** Short-lived notices like "Alex joined" shown near the menu button. */
    toasts: []
};

let state = initialState;
const listeners = new Set();

const getState = () => state;

const setState = patch => {
    state = Object.assign({}, state, typeof patch === 'function' ? patch(state) : patch);
    for (const listener of listeners) listener(state);
};

const subscribe = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

const resetState = () => {
    setState(Object.assign({}, initialState, {chat: state.chat}));
};

let toastCounter = 0;
const pushToast = (text, color) => {
    const key = ++toastCounter;
    setState(s => ({toasts: s.toasts.concat([{key, text, color}]).slice(-3)}));
    setTimeout(() => {
        setState(s => ({toasts: s.toasts.filter(t => t.key !== key)}));
    }, 4000);
};

const useCollabState = () => {
    const [current, setCurrent] = useState(state);
    useEffect(() => subscribe(setCurrent), []);
    return current;
};

export {
    getState,
    setState,
    subscribe,
    resetState,
    pushToast,
    useCollabState
};
