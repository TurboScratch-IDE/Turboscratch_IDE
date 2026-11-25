/* eslint-disable react/jsx-no-bind */
import classNames from 'classnames';
import PropTypes from 'prop-types';
import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {clearConsole, getEntries, subscribe} from '../../lib/tsc-console/console';
import consoleIcon from './console-icon.svg';
import styles from './console-panel.css';

// Keeps the list scrolled to the bottom, unless the person scrolled up to read.
const useStickToBottom = deps => {
    const ref = useRef(null);
    const atBottom = useRef(true);
    const onScroll = () => {
        const el = ref.current;
        if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    useLayoutEffect(() => {
        const el = ref.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    }, deps);
    return [ref, onScroll];
};

const useConsoleEntries = () => {
    const [entries, setEntries] = useState(getEntries());
    useEffect(() => {
        setEntries(getEntries());
        return subscribe(setEntries);
    }, []);
    return entries;
};

const KIND_LABELS = {
    project: 'project',
    flag: 'flag',
    stop: 'stop',
    say: 'say',
    think: 'think',
    broadcast: 'broadcast',
    variable: 'variable',
    list: 'list',
    clone: 'clone',
    log: 'log',
    warn: 'warn',
    error: 'error',
    breakpoint: 'pause'
};

const formatTime = time => {
    const date = new Date(time);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const ConsolePanel = ({onClose}) => {
    const entries = useConsoleEntries();
    const [listRef, onScroll] = useStickToBottom([entries]);
    const [position, setPosition] = useState(null);
    const panelRef = useRef(null);

    // Drag the panel by its header.
    const startDrag = e => {
        if (e.button !== 0 || e.target.closest('button')) return;
        const panel = panelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        const move = event => {
            const x = Math.min(Math.max(event.clientX - offsetX, 0), window.innerWidth - rect.width);
            const y = Math.min(Math.max(event.clientY - offsetY, 0), window.innerHeight - 48);
            setPosition({x, y});
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    };

    return (
        <div
            className={styles.panel}
            ref={panelRef}
            style={position ? {left: position.x, top: position.y, right: 'auto', bottom: 'auto'} : null}
            role="dialog"
            aria-label="Debugger console"
        >
            <div
                className={styles.header}
                onMouseDown={startDrag}
            >
                <span className={styles.headerIcon}>
                    <img
                        src={consoleIcon}
                        alt=""
                        draggable={false}
                        width={18}
                        height={18}
                    />
                </span>
                <div className={styles.headerTitle}>
                    <div className={styles.name}>{'Console'}</div>
                    <div className={styles.subtitle}>{'What your project does'}</div>
                </div>
                <button
                    className={styles.closeButton}
                    title="Close"
                    aria-label="Close"
                    onClick={onClose}
                >
                    {'×'}
                </button>
            </div>
            <div className={styles.body}>
                <div className={styles.consoleToolbar}>
                    <span className={styles.consoleCount}>
                        {entries.length === 1 ? '1 entry' : `${entries.length} entries`}
                    </span>
                    <button
                        className={styles.smallButton}
                        onClick={clearConsole}
                        disabled={entries.length === 0}
                    >
                        {'Clear'}
                    </button>
                </div>
                <div
                    className={styles.consoleList}
                    ref={listRef}
                    onScroll={onScroll}
                >
                    {entries.length === 0 ? (
                        <div className={styles.consoleEmpty}>
                            {'Nothing here yet. Click the green flag: what sprites say and think, broadcasts, ' +
                                'variable changes, clones and problems show up here. Turn on the Debugger addon ' +
                                'to use its log, warn, error and breakpoint blocks too.'}
                        </div>
                    ) : entries.map(entry => (
                        <div
                            key={entry.id}
                            className={classNames(styles.consoleRow, styles[`kind-${entry.kind}`])}
                        >
                            <span className={styles.consoleTime}>{formatTime(entry.time)}</span>
                            <span className={styles.consoleKind}>{KIND_LABELS[entry.kind] || entry.kind}</span>
                            <span className={styles.consoleText}>
                                {entry.sprite && <span className={styles.consoleSprite}>{entry.sprite}</span>}
                                {entry.text}
                                {entry.count > 1 && <span className={styles.consoleRepeat}>{`×${entry.count}`}</span>}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

ConsolePanel.propTypes = {
    onClose: PropTypes.func.isRequired
};

export default ConsolePanel;
