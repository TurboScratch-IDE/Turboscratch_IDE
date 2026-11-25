/* eslint-disable valid-jsdoc */
/**
 * The debugger console: a running record of what the project does, shown in
 * the Console panel (the Console button in the menu bar).
 *
 * It records the green flag and stop, what sprites say and think, broadcasts,
 * variable and list changes (checked a few times a second), clones, compiler
 * problems, and the Debugger addon's log / warn / error / breakpoint blocks.
 */

import {clipText} from './text-utils';

const MAX_ENTRIES = 500;
const MAX_TEXT = 300;
const VARIABLE_CHECK_MS = 200;
const MAX_TRACKED_VARIABLES = 400;
const MAX_CHANGES_PER_CHECK = 12;
const MERGE_LOOKBACK = 8;

// The Debugger addon's blocks, by their internal procedure code.
const ADDON_LOG_BLOCKS = {
    '\u200B\u200Blog\u200B\u200B %s': 'log',
    '\u200B\u200Bwarn\u200B\u200B %s': 'warn',
    '\u200B\u200Berror\u200B\u200B %s': 'error',
    '\u200B\u200Bbreakpoint\u200B\u200B': 'breakpoint'
};

let entries = [];
let nextId = 1;
const listeners = new Set();
let notifyQueued = false;
let attachedVm = null;

const clip = (value, max = MAX_TEXT) => clipText(value, max);

const notify = () => {
    if (notifyQueued) return;
    notifyQueued = true;
    // Busy projects can add many entries per frame. Entries are changed in
    // place, and the screen gets a fresh copy at most every 100 ms.
    setTimeout(() => {
        notifyQueued = false;
        const snapshot = entries.slice();
        for (const listener of listeners) listener(snapshot);
    }, 100);
};

const targetName = target => {
    if (!target) return '';
    if (target.isStage) return 'Stage';
    return target.sprite ? target.sprite.name : target.getName();
};

/**
 * Adds an entry. If the same entry is among the newest few (a loop that says,
 * broadcasts and makes clones over and over), that entry's counter goes up
 * instead, so loops don't flood the console.
 */
const addEntry = (kind, sprite, text) => {
    const now = Date.now();
    let same = -1;
    for (let i = entries.length - 1; i >= Math.max(0, entries.length - MERGE_LOOKBACK); i--) {
        const entry = entries[i];
        if (entry.kind === 'flag' || entry.kind === 'stop' || entry.kind === 'project') break;
        if (entry.kind === kind && entry.sprite === sprite && entry.text === text) {
            same = i;
            break;
        }
    }
    if (same >= 0) {
        // A new object, so the screen knows this row changed.
        entries[same] = Object.assign({}, entries[same], {count: entries[same].count + 1, lastTime: now});
    } else {
        entries.push({id: nextId++, time: now, lastTime: now, kind, sprite, text, count: 1});
        // Trim in batches so a busy project doesn't shift the list every time.
        if (entries.length > MAX_ENTRIES + 50) entries.splice(0, entries.length - MAX_ENTRIES);
    }
    notify();
};

const clearConsole = () => {
    entries = [];
    notify();
};

/** The newest entries (at most MAX_ENTRIES), oldest first. */
const getEntries = () => (entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries);

const subscribe = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

// ---- variable watching ------------------------------------------------------

let knownValues = new Map();

/** Something that changes whenever the variable's value changes (cheap for big lists). */
const signature = variable => {
    const value = variable.value;
    if (variable.type === 'list') {
        // Every item for any normal list; huge lists only by their start and end.
        if (value.length <= 5000) return `${value.length}\u0001${value.join('\u0001')}`;
        return `${value.length}\u0001${value.slice(0, 50).join('\u0001')}\u0002${value.slice(-50).join('\u0001')}`;
    }
    return `${typeof value}:${value}`;
};

const describeValue = variable => {
    if (variable.type === 'list') {
        const items = variable.value;
        const shown = items.slice(0, 8).map(item => clip(item, 40))
            .join(', ');
        return `[${shown}${items.length > 8 ? ', …' : ''}] (${items.length} items)`;
    }
    return clip(variable.value, 120);
};

const eachVariable = (runtime, callback) => {
    let count = 0;
    for (const target of runtime.targets) {
        if (!target.isOriginal) continue;
        for (const id of Object.keys(target.variables)) {
            const variable = target.variables[id];
            if (variable.type !== '' && variable.type !== 'list') continue;
            if (++count > MAX_TRACKED_VARIABLES) return;
            callback(target, id, variable);
        }
    }
};

const rememberVariables = runtime => {
    knownValues = new Map();
    eachVariable(runtime, (target, id, variable) => {
        knownValues.set(`${target.id}:${id}`, signature(variable));
    });
};

const checkVariables = runtime => {
    const changes = [];
    const seen = new Map();
    eachVariable(runtime, (target, id, variable) => {
        const key = `${target.id}:${id}`;
        const current = signature(variable);
        seen.set(key, current);
        if (knownValues.has(key) && knownValues.get(key) !== current) {
            changes.push({target, variable});
        }
    });
    knownValues = seen;
    if (changes.length > MAX_CHANGES_PER_CHECK) {
        addEntry('variable', '', `${changes.length} variables changed at once`);
        return;
    }
    for (const {target, variable} of changes) {
        const where = target.isStage ? 'Stage' : targetName(target);
        const kind = variable.type === 'list' ? 'list' : 'variable';
        addEntry(kind, where, `${variable.name} = ${describeValue(variable)}`);
    }
};

// ---- hooking into the project -----------------------------------------------

const attachConsole = vm => {
    if (!vm || attachedVm === vm) return;
    attachedVm = vm;
    const runtime = vm.runtime;

    runtime.on('PROJECT_LOADED', () => {
        clearConsole();
        addEntry('project', '', 'Project loaded');
        rememberVariables(runtime);
    });
    // The green flag stops everything first; only log a stop that wasn't
    // followed right away by a green flag.
    let stopPending = false;
    let lastStopAll = 0;
    runtime.on('PROJECT_START', () => {
        stopPending = false;
        lastStopAll = 0;
        addEntry('flag', '', 'Green flag clicked');
    });
    runtime.on('PROJECT_STOP_ALL', () => {
        lastStopAll = Date.now();
        // Who stopped it: a "stop all" block (a script is running right now),
        // or the stop sign.
        const thread = runtime.sequencer && runtime.sequencer.activeThread;
        let reason = 'Stop sign clicked (everything stopped)';
        let sprite = '';
        if (thread && thread.target) {
            reason = 'a "stop all" block stopped everything';
            sprite = targetName(thread.target);
        }
        stopPending = true;
        Promise.resolve().then(() => {
            if (!stopPending) return;
            stopPending = false;
            addEntry('stop', sprite, reason);
        });
    });
    runtime.on('PROJECT_RUN_STOP', () => {
        // After the stop sign, "all scripts finished" would just repeat it.
        if (Date.now() - lastStopAll > 1000) addEntry('stop', '', 'All scripts finished');
    });
    runtime.on('SAY', (target, type, text) => {
        if (text === '' || text === null || typeof text === 'undefined') return;
        addEntry(type === 'think' ? 'think' : 'say', targetName(target), clip(text));
    });
    runtime.on('targetWasCreated', (target, source) => {
        if (target.isOriginal || !target.sprite) return;
        // Same text every time, so a burst of clones shows as one line (×N).
        addEntry('clone', targetName(source || target), 'created a clone');
    });
    runtime.on('COMPILE_ERROR', (target, error) => {
        const message = error && error.message ? error.message : String(error);
        addEntry('warn', targetName(target),
            `A script couldn't use the fast compiler and runs slower instead: ${clip(message, 200)}`);
    });
    runtime.on('RUNTIME_PAUSED', () => addEntry('breakpoint', '', 'Project paused by the debugger'));
    runtime.on('RUNTIME_UNPAUSED', () => addEntry('breakpoint', '', 'Project resumed'));

    // Broadcasts start hats with a BROADCAST_OPTION field.
    const originalStartHats = runtime.startHats;
    runtime.startHats = function (opcode, matchFields, target) {
        if (opcode === 'event_whenbroadcastreceived' && matchFields && matchFields.BROADCAST_OPTION) {
            addEntry('broadcast', '', `broadcast "${clip(matchFields.BROADCAST_OPTION, 100)}"`);
        }
        return originalStartHats.call(this, opcode, matchFields, target);
    };

    // The Debugger addon's log/warn/error/breakpoint blocks. Both the
    // compiler and the interpreter look the block up every time it runs, so
    // this works no matter when the addon was turned on.
    const originalGetAddonBlock = runtime.getAddonBlock;
    const wrapped = new WeakMap();
    runtime.getAddonBlock = function (procedureCode) {
        const block = originalGetAddonBlock.call(this, procedureCode);
        const kind = ADDON_LOG_BLOCKS[procedureCode];
        if (!block || !kind || typeof block.callback !== 'function') return block;
        if (!wrapped.has(block)) {
            wrapped.set(block, Object.assign({}, block, {
                // util is the block utility (it has .target), for both the
                // compiler and the interpreter.
                callback: (args, util) => {
                    const sprite = util && util.target ? targetName(util.target) : '';
                    if (kind === 'breakpoint') {
                        addEntry('breakpoint', sprite, 'breakpoint block reached');
                    } else {
                        addEntry(kind, sprite, clip(args && typeof args.content !== 'undefined' ? args.content : ''));
                    }
                    return block.callback(args, util);
                }
            }));
        }
        return wrapped.get(block);
    };

    let lastCheck = 0;
    let wasRunning = false;
    runtime.on('AFTER_EXECUTE', () => {
        const now = Date.now();
        if (now - lastCheck < VARIABLE_CHECK_MS) return;
        // Variables only change while scripts run; check once more after
        // they stop, then rest until something runs again.
        const running = runtime.threads.length > 0;
        if (!running && !wasRunning) return;
        wasRunning = running;
        lastCheck = now;
        checkVariables(runtime);
    });

    rememberVariables(runtime);
};

export {
    attachConsole,
    addEntry,
    clearConsole,
    getEntries,
    subscribe
};
