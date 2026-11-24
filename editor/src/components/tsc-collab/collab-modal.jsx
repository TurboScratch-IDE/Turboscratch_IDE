/* eslint-disable react/jsx-no-bind */
import PropTypes from 'prop-types';
import React, {useEffect, useRef, useState} from 'react';
import Modal from '../../containers/modal.jsx';
import {useCollabState} from '../../lib/tsc-collab/store';
import {
    defaultServerUrl,
    loadSavedName,
    loadSavedServer,
    makeRoomCode,
    makeInviteLink,
    isLocalHostname
} from '../../lib/tsc-collab/settings';
import {isServerUrl, useRoomList} from '../../lib/tsc-collab/room-list';
import {getAccountState} from '../../lib/tsc-community/store';
import styles from './collab-modal.css';

const Avatar = ({name, color, small}) => (
    <span
        className={small ? styles.avatarSmall : styles.avatar}
        style={{background: color}}
        title={name}
    >
        {(name || '?').trim()
            .charAt(0)
            .toUpperCase()}
    </span>
);
Avatar.propTypes = {
    color: PropTypes.string,
    name: PropTypes.string,
    small: PropTypes.bool
};

/**
 * "Open rooms": rooms anyone on the server can join with one click.
 * @param {object} props the server address, whether joining is possible yet, and what to do on Join
 * @returns {React.ReactElement} the list
 */
const RoomList = ({serverUrl, canJoin, needsName, onPick}) => {
    const {rooms, error} = useRoomList(serverUrl);
    let content;
    if (rooms && rooms.length > 0) {
        content = (
            <ul className={styles.roomList}>
                {rooms.map(listed => (
                    <li
                        key={listed.room}
                        className={styles.roomItem}
                    >
                        <div className={styles.roomInfo}>
                            <div className={styles.roomTitle}>{listed.title || listed.room}</div>
                            <div className={styles.roomMeta}>
                                {`${listed.room} · ${listed.people} ${listed.people === 1 ? 'person' : 'people'}: `}
                                {listed.names.join(', ')}
                                {listed.people > listed.names.length ? '…' : ''}
                            </div>
                        </div>
                        <button
                            type="button"
                            className={styles.primaryButton}
                            disabled={!canJoin}
                            onClick={() => onPick(listed.room)}
                        >
                            {'Join'}
                        </button>
                    </li>
                ))}
            </ul>
        );
    } else if (rooms) {
        content = (
            <div className={styles.roomListEmpty}>
                {'No open rooms right now. Create one below, and others will see it here.'}
            </div>
        );
    } else if (!error) {
        content = <div className={styles.roomListEmpty}>{'Looking for rooms…'}</div>;
    }
    return (
        <div className={styles.field}>
            <span className={styles.label}>{'Open rooms'}</span>
            {content}
            {error && <span className={styles.hint}>{error}</span>}
            {needsName && rooms && rooms.length > 0 && (
                <span className={styles.hint}>{'Type your name above to join a room.'}</span>
            )}
        </div>
    );
};
RoomList.propTypes = {
    canJoin: PropTypes.bool,
    needsName: PropTypes.bool,
    onPick: PropTypes.func.isRequired,
    serverUrl: PropTypes.string.isRequired
};

// The person's last choice for "Show a new room in Open rooms". It's kept
// here (not in the form) so it survives a failed or cancelled join, which
// shows a fresh form.
let listedChoice = null;

const JoinForm = ({initialRoom, lastRoom, initialServer, error, projectReady, projectChanged, onJoin}) => {
    const account = getAccountState().user;
    const [name, setName] = useState(loadSavedName() || (account ? account.nickname : ''));
    const [room, setRoom] = useState(initialRoom || lastRoom || makeRoomCode());
    const [server, setServer] = useState(initialServer || loadSavedServer() || defaultServerUrl());
    const [showAdvanced, setShowAdvanced] = useState(!!initialServer || !server);
    // New rooms are shown in "Open rooms" unless the person unticks this.
    // Someone who came with an invite link means to join a private room, so
    // for them it starts unticked.
    const [listed, setListedState] = useState(listedChoice === null ? !initialRoom : listedChoice);
    const setListed = value => {
        listedChoice = value;
        setListedState(value);
    };

    const roomValid = /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(room.trim());
    const serverValid = isServerUrl(server);
    const canJoinAny = projectReady && name.trim().length > 0 && serverValid;
    const canJoin = canJoinAny && roomValid;
    // A server named by an invite link isn't contacted before the person
    // decides to join (they might not trust it).
    const foreignInviteServer = !!initialServer && initialServer !== defaultServerUrl() &&
        server.trim() === initialServer;

    const join = (roomCode, fromList) => onJoin({
        name: name.trim(),
        room: roomCode.trim().toLowerCase(),
        serverUrl: server.trim(),
        // A room picked from the list already exists. If it has just closed,
        // joining creates it again: keep that one private.
        listed: fromList ? false : listed
    });

    const handleSubmit = e => {
        e.preventDefault();
        if (canJoin) join(room, false);
    };

    const handlePick = roomCode => {
        // eslint-disable-next-line no-alert
        if (projectChanged && !confirm(
            'Joining a room replaces the project you have open with the room\'s project. ' +
            'Changes you haven\'t saved will be lost. Join anyway?'
        )) return;
        join(roomCode, true);
    };

    return (
        <form
            className={styles.form}
            onSubmit={handleSubmit}
        >
            <p className={styles.intro}>
                {'Build one project together, live. Everyone in the same room sees each other\'s '}
                {'block, sprite, costume and sound changes as they happen.'}
            </p>
            {error && <div className={styles.error}>{error}</div>}
            <label className={styles.field}>
                <span className={styles.label}>{'Your name'}</span>
                <input
                    className={styles.input}
                    maxLength={24}
                    value={name}
                    placeholder="e.g. Alex"
                    autoFocus={!name}
                    onChange={e => setName(e.target.value)}
                />
            </label>
            {serverValid && !foreignInviteServer && (
                <RoomList
                    serverUrl={server.trim()}
                    canJoin={canJoinAny}
                    needsName={!name.trim()}
                    onPick={handlePick}
                />
            )}
            <label className={styles.field}>
                <span className={styles.label}>{'Create a room, or join one by its code'}</span>
                <div className={styles.row}>
                    <input
                        className={styles.input}
                        maxLength={40}
                        value={room}
                        spellCheck={false}
                        onChange={e => setRoom(e.target.value.replace(/\s/g, '-'))}
                    />
                    <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => setRoom(makeRoomCode())}
                    >
                        {'New code'}
                    </button>
                </div>
                {!roomValid && (
                    <span className={styles.hint}>{'Use letters, numbers, - and _ (max 40).'}</span>
                )}
            </label>
            <label className={styles.checkRow}>
                <input
                    type="checkbox"
                    checked={listed}
                    onChange={e => setListed(e.target.checked)}
                />
                <span>
                    {'Show a new room in Open rooms, so anyone on this server can join it without a link. '}
                    {'Untick it to keep the room private.'}
                </span>
            </label>
            {initialServer && initialServer !== defaultServerUrl() && (
                <div className={styles.error}>
                    {`This invite uses a different server: ${initialServer}. Only join if you trust whoever sent ` +
                        'the link: that server will see your name and the project.'}
                </div>
            )}
            <div className={styles.notice}>
                <strong>{'New room?'}</strong>
                {' Your current project becomes the shared project. '}
                <strong>{'Existing room?'}</strong>
                {' Your editor switches to the room\'s project, so save your work first.'}
            </div>
            <button
                type="button"
                className={styles.linkButton}
                onClick={() => setShowAdvanced(!showAdvanced)}
            >
                {showAdvanced ? '▾ Server' : '▸ Server'}
            </button>
            {showAdvanced && (
                <label className={styles.field}>
                    <span className={styles.label}>{'Collaboration server'}</span>
                    <input
                        className={styles.input}
                        value={server}
                        placeholder="wss://your-collab-server.example.com"
                        spellCheck={false}
                        onChange={e => setServer(e.target.value)}
                    />
                    <span className={styles.hint}>
                        {'Start it with "npm start" in the collab-server folder. '}
                        {'Everyone in a room must use the same server.'}
                    </span>
                    {location.protocol === 'https:' && !/^wss:\/\//.test(server.trim()) && (
                        <span className={styles.hint}>
                            {'This website uses https, so browsers only let it connect to secure wss:// ' +
                                'servers. To collaborate with a server on your own computer, use the editor ' +
                                'you start with start-turboscratch.command instead.'}
                        </span>
                    )}
                </label>
            )}
            <div className={styles.footer}>
                <button
                    type="submit"
                    className={styles.primaryButton}
                    disabled={!canJoin}
                >
                    {projectReady ? 'Join room' : 'Loading editor…'}
                </button>
            </div>
        </form>
    );
};
JoinForm.propTypes = {
    error: PropTypes.string,
    lastRoom: PropTypes.string,
    projectChanged: PropTypes.bool,
    projectReady: PropTypes.bool,
    initialRoom: PropTypes.string,
    initialServer: PropTypes.string,
    onJoin: PropTypes.func.isRequired
};

const Chat = ({chat, onSend}) => {
    const [text, setText] = useState('');
    const listRef = useRef(null);
    const newestKey = chat.length ? chat[chat.length - 1].key : 0;
    useEffect(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    }, [newestKey]);
    const handleSubmit = e => {
        e.preventDefault();
        if (text.trim()) {
            onSend(text.trim());
            setText('');
        }
    };
    return (
        <div className={styles.chat}>
            <div
                className={styles.chatList}
                ref={listRef}
            >
                {chat.length === 0 && (
                    <div className={styles.chatEmpty}>{'No messages yet. Say hi!'}</div>
                )}
                {chat.map(message => (
                    message.system ? (
                        <div
                            key={message.key}
                            className={styles.chatSystem}
                        >
                            {message.text}
                        </div>
                    ) : (
                        <div
                            key={message.key}
                            className={styles.chatMessage}
                        >
                            <span
                                className={styles.chatName}
                                style={{color: message.color}}
                            >
                                {message.mine ? 'You' : message.name}
                            </span>
                            <span className={styles.chatText}>{message.text}</span>
                        </div>
                    )
                ))}
            </div>
            <form
                className={styles.row}
                onSubmit={handleSubmit}
            >
                <input
                    className={styles.input}
                    value={text}
                    maxLength={500}
                    placeholder="Message your team…"
                    onChange={e => setText(e.target.value)}
                />
                <button
                    type="submit"
                    className={styles.secondaryButton}
                    disabled={!text.trim()}
                >
                    {'Send'}
                </button>
            </form>
        </div>
    );
};
Chat.propTypes = {
    chat: PropTypes.arrayOf(PropTypes.object).isRequired,
    onSend: PropTypes.func.isRequired
};

const RoomView = ({state, onLeave, onResync, onSendChat, onSetListed}) => {
    const [copied, setCopied] = useState(false);
    const invite = makeInviteLink(state.room, state.serverUrl);
    const handleCopy = () => {
        const done = () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        };
        if (navigator.clipboard) {
            // eslint-disable-next-line no-alert
            navigator.clipboard.writeText(invite).then(done, () => window.prompt('Copy this link:', invite));
        } else {
            // eslint-disable-next-line no-alert
            window.prompt('Copy this link:', invite);
        }
    };
    const everyone = (state.me ? [Object.assign({mine: true}, state.me)] : []).concat(state.peers);
    return (
        <div className={styles.room}>
            {state.status === 'reconnecting' && (
                <div className={styles.error}>{'Connection lost. Reconnecting…'}</div>
            )}
            <div className={styles.roomHeader}>
                <div>
                    <div className={styles.label}>{'Room'}</div>
                    <div className={styles.roomCode}>{state.room}</div>
                </div>
                <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={handleCopy}
                >
                    {copied ? 'Copied!' : 'Copy invite link'}
                </button>
            </div>
            {state.listSupported ? (
                <label className={styles.checkRow}>
                    <input
                        type="checkbox"
                        checked={!!state.listed}
                        disabled={state.status !== 'connected'}
                        onChange={e => onSetListed(e.target.checked)}
                    />
                    <span>
                        {state.listed ?
                            'Shown in Open rooms: anyone on this server can join without a link.' :
                            'Not in Open rooms: people need the invite link or the room code to join. ' +
                            'Tick to show it in Open rooms.'}
                    </span>
                </label>
            ) : (
                <p className={styles.hint}>
                    {'This server is an older version without Open rooms. Share the invite link instead.'}
                </p>
            )}
            {isLocalHostname(location.hostname) && (
                <p className={styles.hint}>
                    {'Tip: friends on other computers can\'t open "localhost". Open this editor with your '}
                    {'computer\'s network address (like http://192.168.1.20:8601) to invite them.'}
                </p>
            )}
            <div className={styles.label}>{`People here (${everyone.length})`}</div>
            <ul className={styles.people}>
                {everyone.map(person => (
                    <li
                        key={person.id || 'me'}
                        className={styles.person}
                    >
                        <Avatar
                            name={person.name}
                            color={person.color}
                        />
                        <span className={styles.personName}>
                            {person.name}
                            {person.mine && <span className={styles.youTag}>{'you'}</span>}
                        </span>
                        <span className={styles.personWhere}>
                            {person.presence && person.presence.target ?
                                `editing ${person.presence.target}` :
                                ''}
                        </span>
                    </li>
                ))}
            </ul>
            <div className={styles.label}>{'Chat'}</div>
            <Chat
                chat={state.chat}
                onSend={onSendChat}
            />
            <div className={styles.footer}>
                <button
                    type="button"
                    className={styles.secondaryButton}
                    title="Reload the shared project from the room if something looks out of sync"
                    onClick={onResync}
                >
                    {'Resync project'}
                </button>
                <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={onLeave}
                >
                    {'Leave room'}
                </button>
            </div>
        </div>
    );
};
RoomView.propTypes = {
    onLeave: PropTypes.func.isRequired,
    onResync: PropTypes.func.isRequired,
    onSendChat: PropTypes.func.isRequired,
    onSetListed: PropTypes.func.isRequired,
    state: PropTypes.object.isRequired
};

const CollabModal = props => {
    const state = useCollabState();
    const newestChatKey = state.chat.length ? state.chat[state.chat.length - 1].key : 0;
    useEffect(() => {
        props.onChatRead();
    }, [newestChatKey]);

    let body;
    if (state.status === 'connecting' || state.status === 'syncing') {
        body = (
            <div className={styles.progressBox}>
                <div className={styles.progress}>
                    <div className={styles.spinner} />
                    {state.status === 'connecting' ? 'Connecting to the server…' : 'Loading the room\'s project…'}
                </div>
                {state.status === 'connecting' && (
                    <p className={styles.hint}>
                        {'A free online server that has been asleep can take up to a minute to wake up.'}
                    </p>
                )}
                <div className={styles.footer}>
                    <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={props.onLeave}
                    >
                        {'Cancel'}
                    </button>
                </div>
            </div>
        );
    } else if (state.status === 'connected' || state.status === 'reconnecting') {
        body = (
            <RoomView
                state={state}
                onLeave={props.onLeave}
                onResync={props.onResync}
                onSendChat={props.onSendChat}
                onSetListed={props.onSetListed}
            />
        );
    } else {
        body = (
            <JoinForm
                error={state.error}
                initialRoom={props.initialRoom}
                initialServer={props.initialServer}
                lastRoom={state.room}
                projectChanged={!!props.projectChanged}
                projectReady={props.projectReady !== false}
                onJoin={props.onJoin}
            />
        );
    }

    return (
        <Modal
            className={styles.modalContent}
            contentLabel="Collaborate"
            id="tscCollabModal"
            onRequestClose={props.onClose}
        >
            <div className={styles.body}>
                {body}
            </div>
        </Modal>
    );
};

CollabModal.propTypes = {
    initialRoom: PropTypes.string,
    initialServer: PropTypes.string,
    onChatRead: PropTypes.func.isRequired,
    onClose: PropTypes.func.isRequired,
    onJoin: PropTypes.func.isRequired,
    onLeave: PropTypes.func.isRequired,
    onResync: PropTypes.func.isRequired,
    onSendChat: PropTypes.func.isRequired,
    onSetListed: PropTypes.func.isRequired,
    projectChanged: PropTypes.bool,
    projectReady: PropTypes.bool
};

export {Avatar};
export default CollabModal;
