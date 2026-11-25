/* eslint-disable react/jsx-no-bind */
import classNames from 'classnames';
import PropTypes from 'prop-types';
import React, {useEffect, useRef, useState} from 'react';
import Modal from '../../containers/modal.jsx';
import {getState, subscribe, useCollabState} from '../../lib/tsc-collab/store';
import {MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH} from '../../lib/tsc-collab/session';
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

// Server error codes about the room password: the join form points at the
// password box when the last join ended with one of these.
const PASSWORD_ERRORS = ['password-needed', 'wrong-password', 'too-many-tries', 'bad-password'];
const TOO_SHORT_HINT = `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`;

/**
 * A password box with a Show button. The password is hidden while typing
 * (someone could be looking at the screen), but kids can check what they
 * typed before joining.
 * @param {object} props the value, what to do when it changes, and how it looks. Give it an
 *     id that a <label htmlFor> points at, or a label (read out by screen readers).
 *     describedBy is the id of a message about this box (like a password error), so a
 *     screen reader reads it out when the box gets focus.
 * @returns {React.ReactElement} the box and its button
 */
const PasswordInput = ({
    id,
    label,
    value,
    onChange,
    onKeyDown,
    inputRef,
    invalid,
    describedBy,
    autoFocus,
    placeholder
}) => {
    const [shown, setShown] = useState(false);
    return (
        <div className={styles.passwordBox}>
            <input
                id={id}
                aria-label={label}
                ref={inputRef}
                className={classNames(styles.input, {[styles.inputError]: invalid})}
                type={shown ? 'text' : 'password'}
                value={value}
                maxLength={MAX_PASSWORD_LENGTH}
                // Browsers fill in saved passwords for "current-password"
                // boxes, which could put the person's account password here.
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={autoFocus}
                placeholder={placeholder}
                aria-invalid={invalid ? 'true' : null}
                aria-describedby={describedBy || null}
                onChange={e => onChange(e.target.value)}
                onKeyDown={onKeyDown}
            />
            {/* The spoken name starts with the word on the button, so people
                who use voice control can say what they see. It already says
                what clicking does, so there's no "pressed" state on top. */}
            <button
                type="button"
                className={styles.secondaryButton}
                aria-label={shown ? 'Hide password' : 'Show password'}
                title={shown ? 'Hide the password' : 'Show the password'}
                onClick={() => setShown(!shown)}
            >
                {shown ? 'Hide' : 'Show'}
            </button>
        </div>
    );
};
PasswordInput.propTypes = {
    autoFocus: PropTypes.bool,
    describedBy: PropTypes.string,
    id: PropTypes.string,
    inputRef: PropTypes.object,
    invalid: PropTypes.bool,
    label: PropTypes.string,
    onChange: PropTypes.func.isRequired,
    onKeyDown: PropTypes.func,
    placeholder: PropTypes.string,
    value: PropTypes.string.isRequired
};

/**
 * "Open rooms": rooms anyone on the server can join with one click. A room
 * with a password asks for it first, right in the list.
 * @param {object} props the server address, whether joining is possible yet, and what to do on Join
 * @returns {React.ReactElement} the list
 */
const RoomList = ({serverUrl, canJoin, needsName, onPick}) => {
    const {rooms, error} = useRoomList(serverUrl);
    // The room whose password box is open (one at a time), and what's typed in it.
    const [askingFor, setAskingFor] = useState(null);
    const [password, setPassword] = useState('');
    // Each room's Join button, to give it keyboard focus back after Cancel
    // (Cancel itself disappears with the password box).
    const joinButtons = useRef({});
    const passwordBox = useRef(null);
    const handleRowJoin = listed => {
        if (!listed.locked) {
            onPick(listed.room, '');
        } else if (askingFor !== listed.room) {
            setAskingFor(listed.room);
            setPassword('');
        } else if (passwordBox.current) {
            // Its box is already open: a second click (like the second half
            // of a double-click) keeps it open with what's typed, and puts
            // the typing back in the box (the click moved it to the button).
            passwordBox.current.focus();
        }
    };
    const cancelPassword = () => {
        const button = joinButtons.current[askingFor];
        if (button) button.focus();
        setAskingFor(null);
    };
    const passwordLongEnough = password.length >= MIN_PASSWORD_LENGTH;
    const joinWithPassword = () => {
        if (canJoin && passwordLongEnough) onPick(askingFor, password);
    };
    const handlePasswordKey = e => {
        if (e.key !== 'Enter') return;
        // This list sits inside the join form: Enter must not submit that
        // form (it would join the room typed below instead).
        e.preventDefault();
        joinWithPassword();
    };
    let content;
    if (rooms && rooms.length > 0) {
        content = (
            <ul className={styles.roomList}>
                {rooms.map(listed => {
                    const asking = listed.locked && askingFor === listed.room;
                    return (
                        <li
                            key={listed.room}
                            className={styles.roomItem}
                        >
                            <div className={styles.roomRow}>
                                <div className={styles.roomInfo}>
                                    <div className={styles.roomTitle}>
                                        {listed.locked && (
                                            <span
                                                className={styles.lock}
                                                role="img"
                                                aria-label="Has a password"
                                                title="This room has a password"
                                            >
                                                {'🔒'}
                                            </span>
                                        )}
                                        {listed.title || listed.room}
                                    </div>
                                    <div className={styles.roomMeta}>
                                        {`${listed.room} · ${listed.people} ` +
                                            `${listed.people === 1 ? 'person' : 'people'}: `}
                                        {listed.names.join(', ')}
                                        {listed.people > listed.names.length ? '…' : ''}
                                    </div>
                                </div>
                                {/* Always "Join", even while the password box is
                                    open: a Cancel in this spot would catch the
                                    second click of a double-click. */}
                                <button
                                    type="button"
                                    className={styles.primaryButton}
                                    disabled={!canJoin}
                                    ref={button => {
                                        joinButtons.current[listed.room] = button;
                                    }}
                                    onClick={() => handleRowJoin(listed)}
                                >
                                    {'Join'}
                                </button>
                            </div>
                            {asking && (
                                <div className={styles.row}>
                                    <PasswordInput
                                        autoFocus
                                        inputRef={passwordBox}
                                        value={password}
                                        placeholder="Room password"
                                        label={`Password for ${listed.title || listed.room}`}
                                        onChange={setPassword}
                                        onKeyDown={handlePasswordKey}
                                    />
                                    <button
                                        type="button"
                                        className={styles.primaryButton}
                                        disabled={!canJoin || !passwordLongEnough}
                                        onClick={joinWithPassword}
                                    >
                                        {'Join'}
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.secondaryButton}
                                        onClick={cancelPassword}
                                    >
                                        {'Cancel'}
                                    </button>
                                </div>
                            )}
                            {asking && password.length > 0 && !passwordLongEnough && (
                                <span className={styles.hint}>{TOO_SHORT_HINT}</span>
                            )}
                        </li>
                    );
                })}
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

// The person's last choice for "Show a new room in Open rooms", and the
// room name they typed. They're kept here (not in the form) so they survive
// a failed or cancelled join, which shows a fresh form.
let listedChoice = null;
let titleChoice = '';
// The room password typed in the join form, kept the same way: otherwise a
// join that failed for another reason (server busy, couldn't connect) would
// show an empty box, and clicking Join again would quietly create the room
// with no password. It only lives here, in memory, never in localStorage.
// It's forgotten once a join worked, when they leave, and after a password
// error (then it was wrong, so they type it again).
let passwordChoice = '';
let lastStatus = getState().status;
subscribe(state => {
    if (state.status === lastStatus) return;
    lastStatus = state.status;
    // "syncing" comes right after the server's welcome; "idle" after leaving.
    if (state.status === 'syncing' || state.status === 'idle' ||
        (state.status === 'error' && PASSWORD_ERRORS.includes(state.errorCode))) {
        passwordChoice = '';
    }
});

const JoinForm = ({
    initialRoom,
    lastRoom,
    initialServer,
    error,
    errorCode,
    projectReady,
    projectChanged,
    projectTitle,
    onJoin
}) => {
    const passwordError = PASSWORD_ERRORS.includes(errorCode);
    const account = getAccountState().user;
    const [name, setName] = useState(loadSavedName() || (account ? account.nickname : ''));
    // After a password error, show the room that asked for the password,
    // even if an invite link named another one. The same for a room that
    // turned out to have no password ('room-unlocked'): joining it again
    // with the password box empty means that room.
    const sameRoomAgain = passwordError || errorCode === 'room-unlocked';
    const [room, setRoom] = useState((sameRoomAgain && lastRoom) || initialRoom || lastRoom || makeRoomCode());
    // The server this website comes with ('' when it has none).
    const defaultServer = defaultServerUrl();
    const [server, setServer] = useState(initialServer || loadSavedServer() || defaultServer);
    const [showAdvanced, setShowAdvanced] = useState(!!initialServer || !server);
    // New rooms are shown in "Open rooms" unless the person unticks this.
    // Someone who came with an invite link means to join a private room, so
    // for them it starts unticked.
    const [listed, setListedState] = useState(listedChoice === null ? !initialRoom : listedChoice);
    const setListed = value => {
        listedChoice = value;
        setListedState(value);
    };
    const [title, setTitleState] = useState(titleChoice);
    const setTitle = value => {
        titleChoice = value;
        setTitleState(value);
    };
    const [password, setPasswordState] = useState(passwordError ? '' : passwordChoice);
    const setPassword = value => {
        passwordChoice = value;
        setPasswordState(value);
    };
    // The password box is marked red after a password error, until they type.
    const [passwordEdited, setPasswordEdited] = useState(false);
    // The room has no password, but the box still has one: the error says
    // to empty the box to join anyway.
    const unlockedWithPassword = errorCode === 'room-unlocked' && password.length > 0;
    const passwordRef = useRef(null);
    useEffect(() => {
        if ((passwordError || unlockedWithPassword) && passwordRef.current) passwordRef.current.focus();
    }, []);

    const roomValid = /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(room.trim());
    const serverValid = isServerUrl(server);
    // No room can have a shorter password, so it can't be right.
    const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
    const canJoinAny = projectReady && name.trim().length > 0 && serverValid;
    const canJoin = canJoinAny && roomValid && !passwordTooShort;
    // A server named by an invite link isn't contacted before the person
    // decides to join (they might not trust it).
    const inviteServerForeign = !!initialServer && initialServer !== defaultServer;
    const foreignInviteServer = inviteServerForeign && server.trim() === initialServer;
    // Set while the password error is still about what's in the box (until they type).
    const showPasswordError = passwordError && !passwordEdited && !!error;
    let passwordHint;
    if (passwordTooShort) {
        passwordHint = TOO_SHORT_HINT;
    } else if (unlockedWithPassword) {
        passwordHint = 'Empty this box to join the room without a password.';
    } else {
        // With a password typed, a room without one isn't joined (it could
        // be a stranger's room with the same code).
        passwordHint = 'Leave empty for no password. A new room gets this password; to join a room with ' +
            'a password, type it here. With a password typed, you only join a room that has one.';
    }

    const join = (roomCode, roomPassword, fromList) => onJoin({
        name: name.trim(),
        room: roomCode.trim().toLowerCase(),
        serverUrl: server.trim(),
        // A room picked from the list already exists. If it has just closed,
        // joining creates it again: keep that one private.
        listed: fromList ? false : listed,
        // Only used for a new room. Empty means "use the project's name".
        title: title.trim(),
        password: roomPassword
    });

    const handleSubmit = e => {
        e.preventDefault();
        if (canJoin) join(room, password, false);
    };

    const handlePick = (roomCode, roomPassword) => {
        // eslint-disable-next-line no-alert
        if (projectChanged && !confirm(
            'Joining a room replaces the project you have open with the room\'s project. ' +
            'Changes you haven\'t saved will be lost. Join anyway?'
        )) return;
        join(roomCode, roomPassword, true);
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
            {error && (
                // role="alert" reads it out as it appears; the password box
                // also points at it, so moving focus there reads it again.
                <div
                    id="tscCollabJoinError"
                    role="alert"
                    className={styles.error}
                >
                    {error}
                </div>
            )}
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
            <label className={styles.field}>
                <span className={styles.label}>{'Room name (optional)'}</span>
                <input
                    className={styles.input}
                    maxLength={60}
                    value={title}
                    placeholder={projectTitle || 'e.g. Platformer team'}
                    onChange={e => setTitle(e.target.value)}
                />
                <span className={styles.hint}>{'Used when you create a new room.'}</span>
            </label>
            <div className={styles.field}>
                <label
                    className={styles.label}
                    htmlFor="tscCollabJoinPassword"
                >
                    {'Room password (optional)'}
                </label>
                <PasswordInput
                    id="tscCollabJoinPassword"
                    inputRef={passwordRef}
                    value={password}
                    invalid={passwordError && !passwordEdited}
                    describedBy={showPasswordError || (unlockedWithPassword && error) ? 'tscCollabJoinError' : null}
                    onChange={value => {
                        setPassword(value);
                        setPasswordEdited(true);
                    }}
                />
                <span className={styles.hint}>
                    {passwordHint}
                </span>
            </div>
            <label className={styles.checkRow}>
                <input
                    type="checkbox"
                    checked={listed}
                    onChange={e => setListed(e.target.checked)}
                />
                <span>
                    {/* With a password, people can see the room in the list but not get in without it. */}
                    {password.length > 0 ?
                        'Show a new room in Open rooms, so people on this server can find it ' +
                            '(they still need the password). ' :
                        'Show a new room in Open rooms, so anyone on this server can join it without a link. '}
                    {'Untick it to keep the room private.'}
                </span>
            </label>
            {/* The warning is about the server in the box: once they switch to
                another one, it's no longer true, but the invite's room isn't
                there either. */}
            {foreignInviteServer && (
                <div className={styles.error}>
                    {`This invite uses a different server: ${initialServer}. Only join if you trust whoever sent ` +
                        'the link: that server will see your name and the project.'}
                </div>
            )}
            {inviteServerForeign && !foreignInviteServer && (
                <p className={styles.hint}>
                    {'Your friend\'s room is on the invite\'s server. On this server, Join makes a new room instead.'}
                </p>
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
                <div className={styles.field}>
                    <label
                        className={styles.label}
                        htmlFor="tscCollabServer"
                    >
                        {'Collaboration server'}
                    </label>
                    <input
                        id="tscCollabServer"
                        className={styles.input}
                        value={server}
                        placeholder="wss://your-collab-server.example.com"
                        spellCheck={false}
                        onChange={e => setServer(e.target.value)}
                    />
                    {defaultServer && server.trim() !== defaultServer && (
                        <button
                            type="button"
                            className={classNames(styles.editLink, styles.useDefault)}
                            onClick={() => setServer(defaultServer)}
                        >
                            {'Use the default server'}
                        </button>
                    )}
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
                </div>
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
    errorCode: PropTypes.string,
    lastRoom: PropTypes.string,
    projectChanged: PropTypes.bool,
    projectReady: PropTypes.bool,
    projectTitle: PropTypes.string,
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

/**
 * Changes the room's name. Anyone in the room can do it.
 * @param {object} props the current name, and what to do on Save or Cancel
 * @returns {React.ReactElement} the form
 */
const RenameForm = ({initial, disabled, onSave, onCancel}) => {
    const [value, setValue] = useState(initial);
    const handleSubmit = e => {
        e.preventDefault();
        if (!disabled) onSave(value.trim());
    };
    return (
        <form
            className={styles.settingForm}
            onSubmit={handleSubmit}
        >
            <label
                className={styles.label}
                htmlFor="tscCollabRoomName"
            >
                {'Room name'}
            </label>
            <div className={styles.row}>
                <input
                    id="tscCollabRoomName"
                    className={styles.input}
                    maxLength={60}
                    value={value}
                    placeholder="e.g. Platformer team"
                    autoFocus
                    onChange={e => setValue(e.target.value)}
                />
                <button
                    type="submit"
                    className={styles.primaryButton}
                    disabled={disabled}
                >
                    {'Save'}
                </button>
                <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={onCancel}
                >
                    {'Cancel'}
                </button>
            </div>
            <span className={styles.hint}>{'Leave it empty to remove the name.'}</span>
        </form>
    );
};
RenameForm.propTypes = {
    disabled: PropTypes.bool,
    initial: PropTypes.string.isRequired,
    onCancel: PropTypes.func.isRequired,
    onSave: PropTypes.func.isRequired
};

/**
 * Sets or changes the room's password. People in the room now aren't thrown
 * out, but anyone whose connection drops may need the new password to get
 * back in (always after the server restarts), so the hint asks to tell them.
 * @param {object} props whether saving is possible now, and what to do on Save or Cancel
 * @returns {React.ReactElement} the form
 */
const PasswordForm = ({disabled, onSave, onCancel}) => {
    const [value, setValue] = useState('');
    const tooShort = value.length < MIN_PASSWORD_LENGTH;
    const handleSubmit = e => {
        e.preventDefault();
        if (!disabled && !tooShort) onSave(value);
    };
    return (
        <form
            className={styles.settingForm}
            onSubmit={handleSubmit}
        >
            <label
                className={styles.label}
                htmlFor="tscCollabNewPassword"
            >
                {'New room password'}
            </label>
            <div className={styles.row}>
                <PasswordInput
                    id="tscCollabNewPassword"
                    autoFocus
                    value={value}
                    onChange={setValue}
                />
                <button
                    type="submit"
                    className={styles.primaryButton}
                    disabled={disabled || tooShort}
                >
                    {'Save'}
                </button>
                <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={onCancel}
                >
                    {'Cancel'}
                </button>
            </div>
            <span className={styles.hint}>
                {value && tooShort ?
                    TOO_SHORT_HINT :
                    'Tell everyone here the new password: they need it if their connection drops.'}
            </span>
        </form>
    );
};
PasswordForm.propTypes = {
    disabled: PropTypes.bool,
    onCancel: PropTypes.func.isRequired,
    onSave: PropTypes.func.isRequired
};

const RoomView = ({state, onLeave, onResync, onSendChat, onSetListed, onRename, onSetPassword}) => {
    const [copied, setCopied] = useState(false);
    // What's being changed right now: null, 'name' or 'password'.
    const [editing, setEditing] = useState(null);
    const live = state.status === 'connected';
    // Older servers can't rename rooms or give them a password.
    const canChange = !!state.lockSupported;
    const listedText = state.locked ?
        'Shown in Open rooms: people on this server can find it there, but they need the password to join.' :
        'Shown in Open rooms: anyone on this server can join without a link.';

    // Closing a form (or removing the password) takes away the control that
    // had keyboard focus. Focus then falls back to the page, where the
    // dialog no longer hears Escape and screen readers lose their place, so
    // it goes back to the button that opened the form.
    const rootRef = useRef(null);
    const nameButtonRef = useRef(null);
    const passwordButtonRef = useRef(null);
    // Which button gets focus back: 'name', 'password' or null.
    const focusBack = useRef(null);
    const closeForm = which => {
        focusBack.current = which;
        setEditing(null);
    };
    useEffect(() => {
        const which = focusBack.current;
        if (!which) return;
        const active = document.activeElement;
        // Only when focus was actually lost: a removed password stays
        // pending until the server confirms it, and the person may have
        // clicked somewhere else meanwhile.
        if (active && active !== document.body && document.body.contains(active)) return;
        const button = which === 'name' ? nameButtonRef.current : passwordButtonRef.current;
        focusBack.current = null;
        if (button && !button.disabled) {
            button.focus();
            return;
        }
        // Not there, or can't be used now (reconnecting): the dialog itself.
        const dialog = rootRef.current && rootRef.current.closest('[role="dialog"]');
        if (dialog) dialog.focus();
    }, [editing, state.locked]);

    const handleRename = title => {
        if (onRename(title) !== false) closeForm('name');
    };
    const handleSetPassword = password => {
        if (onSetPassword(password) !== false) closeForm('password');
    };
    const handleRemovePassword = () => {
        // eslint-disable-next-line no-alert
        if (!confirm('Remove the room\'s password? Then anyone with the room code can join.')) return;
        // The button goes away once the server confirms (the room isn't
        // locked any more); focus moves to "Set password" then.
        if (onSetPassword(null) !== false) focusBack.current = 'password';
    };
    // The invite link never has the password in it: links get passed around.
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
        <div
            className={styles.room}
            ref={rootRef}
        >
            {state.status === 'reconnecting' && (
                <div className={styles.error}>{'Connection lost. Reconnecting…'}</div>
            )}
            <div className={styles.roomHeader}>
                <div className={styles.roomHeading}>
                    <div className={styles.label}>{'Room'}</div>
                    <div className={styles.roomNameRow}>
                        <span className={state.title ? styles.roomName : styles.roomCode}>
                            {state.title || state.room}
                        </span>
                        {canChange && editing !== 'name' && (
                            <button
                                type="button"
                                className={styles.editLink}
                                disabled={!live}
                                ref={nameButtonRef}
                                onClick={() => setEditing('name')}
                            >
                                {state.title ? 'Rename' : 'Add a name'}
                            </button>
                        )}
                    </div>
                    {state.title && <div className={styles.roomMeta}>{`Code: ${state.room}`}</div>}
                </div>
                <div className={styles.invite}>
                    <button
                        type="button"
                        className={styles.primaryButton}
                        onClick={handleCopy}
                    >
                        {copied ? 'Copied!' : 'Copy invite link'}
                    </button>
                    {state.locked && (
                        <span className={styles.hint}>{'Friends also need the room password.'}</span>
                    )}
                </div>
            </div>
            {canChange && editing === 'name' && (
                <RenameForm
                    initial={state.title || ''}
                    disabled={!live}
                    onSave={handleRename}
                    onCancel={() => closeForm('name')}
                />
            )}
            {canChange && editing === 'password' && (
                <PasswordForm
                    disabled={!live}
                    onSave={handleSetPassword}
                    onCancel={() => closeForm('password')}
                />
            )}
            {canChange && editing !== 'password' && (
                <div className={styles.settingRow}>
                    <span className={styles.settingText}>
                        {state.locked ? 'Password protected 🔒' : 'No password'}
                    </span>
                    <button
                        type="button"
                        className={classNames(styles.secondaryButton, styles.smallButton)}
                        disabled={!live}
                        ref={passwordButtonRef}
                        onClick={() => setEditing('password')}
                    >
                        {state.locked ? 'Change password' : 'Set password'}
                    </button>
                    {state.locked && (
                        <button
                            type="button"
                            className={classNames(styles.secondaryButton, styles.smallButton)}
                            disabled={!live}
                            onClick={handleRemovePassword}
                        >
                            {'Remove password'}
                        </button>
                    )}
                </div>
            )}
            {!canChange && state.listSupported && (
                <p className={styles.hint}>
                    {'This server is an older version: you can\'t name this room or give it a password.'}
                </p>
            )}
            {/* (A server without Open rooms gets one hint below that covers both.) */}
            {state.listSupported ? (
                <label className={styles.checkRow}>
                    <input
                        type="checkbox"
                        checked={!!state.listed}
                        disabled={state.status !== 'connected'}
                        onChange={e => onSetListed(e.target.checked)}
                    />
                    <span>
                        {state.listed ? listedText : 'Not in Open rooms: people need the invite link or the room ' +
                            'code to join. Tick to show it in Open rooms.'}
                    </span>
                </label>
            ) : (
                <p className={styles.hint}>
                    {canChange ?
                        'This server is an older version without Open rooms. Share the invite link instead.' :
                        'This server is an older version without Open rooms, room names or room passwords. ' +
                        'Share the invite link instead.'}
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
    onRename: PropTypes.func.isRequired,
    onResync: PropTypes.func.isRequired,
    onSendChat: PropTypes.func.isRequired,
    onSetListed: PropTypes.func.isRequired,
    onSetPassword: PropTypes.func.isRequired,
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
                onRename={props.onRename}
                onResync={props.onResync}
                onSendChat={props.onSendChat}
                onSetListed={props.onSetListed}
                onSetPassword={props.onSetPassword}
            />
        );
    } else {
        body = (
            <JoinForm
                error={state.error}
                errorCode={state.errorCode}
                initialRoom={props.initialRoom}
                initialServer={props.initialServer}
                lastRoom={state.room}
                projectChanged={!!props.projectChanged}
                projectReady={props.projectReady !== false}
                projectTitle={props.projectTitle}
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
    onRename: PropTypes.func.isRequired,
    onResync: PropTypes.func.isRequired,
    onSendChat: PropTypes.func.isRequired,
    onSetListed: PropTypes.func.isRequired,
    onSetPassword: PropTypes.func.isRequired,
    projectChanged: PropTypes.bool,
    projectReady: PropTypes.bool,
    projectTitle: PropTypes.string
};

export {Avatar};
export default CollabModal;
