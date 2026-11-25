/* eslint-disable valid-jsdoc */
/**
 * Talks to the TurboScratch server's community API (accounts, posted
 * projects, friends, studios). It's the same server used for collaboration:
 * ws://host:8090 for rooms means http://host:8090 for the API.
 */

import {arrayBufferToBase64} from '../tw-base64-utils';

const TOKEN_KEY = 'tsc:account-token';

const safeGet = key => {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
};

const safeSet = (key, value) => {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch (e) {
        // ignore
    }
};

const getToken = () => safeGet(TOKEN_KEY);
const setToken = token => safeSet(TOKEN_KEY, token);

/**
 * The account server's web address, or null if this editor has none.
 *
 * For safety this never comes from an invite link or a server someone typed
 * for collaboration (that would let a crafted link collect passwords and
 * sign-ins). It's either the server built into this website, or, for the
 * editor started on your own computer, the server running next to it.
 */
const getApiBase = () => {
    let base = null;
    if (process.env.TSC_COLLAB_SERVER) {
        base = process.env.TSC_COLLAB_SERVER.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
    } else if (location.protocol === 'http:' && location.hostname) {
        base = `http://${location.hostname}:8090`;
    }
    // Never send passwords or sign-ins unencrypted from a secure page.
    if (base && location.protocol === 'https:' && !/^https:\/\//i.test(base)) return null;
    return base;
};

class ApiError extends Error {
    constructor (status, message) {
        super(message);
        this.status = status;
    }
}

const request = async (method, path, body) => {
    const base = getApiBase();
    if (!base) {
        throw new ApiError(0, 'This editor isn\'t connected to a TurboScratch server yet.');
    }
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const options = {method, headers};
    if (body) options.body = JSON.stringify(body);
    let res;
    try {
        res = await fetch(`${base}${path}`, options);
    } catch (e) {
        throw new ApiError(0, `Couldn't reach the TurboScratch server (${base}). ` +
            'If it\'s a free server that was asleep, wait a minute and try again.');
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    if (!res.ok) {
        throw new ApiError(res.status, (data && data.error) || `The server said no (${res.status})`);
    }
    return data;
};

const enc = encodeURIComponent;

const api = {
    signup: (nickname, password) => request('POST', '/api/signup', {nickname, password}),
    login: (nickname, password) => request('POST', '/api/login', {nickname, password}),
    logout: () => request('POST', '/api/logout'),
    me: () => request('GET', '/api/me'),
    user: nickname => request('GET', `/api/users/${enc(nickname)}`),

    projects: (offset = 0) => request('GET', `/api/projects?offset=${offset}`),
    project: id => request('GET', `/api/projects/${id}`),
    projectFile: id => request('GET', `/api/projects/${id}/file`),
    postProject: (title, description, sb3) => request('POST', '/api/projects', {
        title,
        description,
        data: arrayBufferToBase64(sb3)
    }),
    updateProject: (id, title, description, sb3) => {
        const body = {title, description};
        if (sb3) body.data = arrayBufferToBase64(sb3);
        return request('PUT', `/api/projects/${id}`, body);
    },
    deleteProject: id => request('DELETE', `/api/projects/${id}`),

    friends: () => request('GET', '/api/friends'),
    addFriend: nickname => request('POST', '/api/friends/requests', {nickname}),
    acceptFriend: requestId => request('POST', `/api/friends/requests/${requestId}/accept`),
    declineFriend: requestId => request('POST', `/api/friends/requests/${requestId}/decline`),
    removeFriend: nickname => request('DELETE', `/api/friends/${enc(nickname)}`),

    studios: () => request('GET', '/api/studios'),
    studio: id => request('GET', `/api/studios/${id}`),
    createStudio: (title, description) => request('POST', '/api/studios', {title, description}),
    deleteStudio: id => request('DELETE', `/api/studios/${id}`),
    inviteToStudio: (id, nickname) => request('POST', `/api/studios/${id}/invites`, {nickname}),
    acceptStudioInvite: inviteId => request('POST', `/api/studios/invites/${inviteId}/accept`),
    declineStudioInvite: inviteId => request('POST', `/api/studios/invites/${inviteId}/decline`),
    addToStudio: (id, projectId) => request('POST', `/api/studios/${id}/projects`, {projectId}),
    removeFromStudio: (id, projectId) => request('DELETE', `/api/studios/${id}/projects/${projectId}`),
    removeStudioMember: (id, nickname) => request('DELETE', `/api/studios/${id}/members/${enc(nickname)}`)
};

export {
    api,
    ApiError,
    getApiBase,
    getToken,
    setToken
};
