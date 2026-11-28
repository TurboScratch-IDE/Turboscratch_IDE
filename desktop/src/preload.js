// Runs in every app page before the page's own code, sandboxed: it can only
// use Electron's renderer modules (no Node.js, no require of our own files).
//
// Keep this tiny. The editor runs extension and project code in the same page,
// so anything given to the page here is also given to that code.

const {contextBridge} = require('electron');

const isAppPage = location.protocol === 'tsc-app:' && location.host === 'editor';

// Lets the editor know it runs in the desktop app. Nothing in it can do anything.
const getVersion = () => {
    const prefix = '--tsc-desktop-version=';
    const arg = process.argv.find(item => item.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : '';
};

// Electron has no window.prompt(). The editor already waits for prompt()
// with await (like in TurboWarp Desktop), so this replacement shows a small
// dialog inside the page and returns a Promise: the typed text for OK, or
// null for Cancel and Escape, like the browser's prompt.
//
// This function is copied into the page (it can't use anything from this
// file), and everything it builds lives in a shadow root so the editor's
// styles can't change it.
const installPrompt = () => {
    const STYLE = `
        :host { all: initial; }
        dialog {
            box-sizing: border-box;
            width: min(420px, calc(100vw - 32px));
            padding: 20px;
            border: none;
            border-radius: 12px;
            background: #ffffff;
            color: #1f2937;
            font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
        }
        dialog::backdrop { background: rgba(0, 0, 0, 0.4); }
        p {
            margin: 0 0 12px;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            max-height: 40vh;
            overflow-y: auto;
        }
        input {
            box-sizing: border-box;
            width: 100%;
            padding: 8px 10px;
            border: 1px solid #9ca3af;
            border-radius: 8px;
            background: #ffffff;
            color: inherit;
            font: inherit;
        }
        input:focus { outline: 2px solid #4f46e5; outline-offset: 1px; border-color: #4f46e5; }
        .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
        button {
            min-width: 80px;
            padding: 7px 14px;
            border: 1px solid #9ca3af;
            border-radius: 8px;
            background: #f3f4f6;
            color: #1f2937;
            font: inherit;
            cursor: pointer;
        }
        button.ok { border-color: #4f46e5; background: #4f46e5; color: #ffffff; }
        button:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
        @media (prefers-color-scheme: dark) {
            dialog { background: #1f2430; color: #f3f4f6; }
            input { background: #111827; border-color: #4b5563; }
            button { background: #374151; border-color: #4b5563; color: #f3f4f6; }
            button.ok { border-color: #6366f1; background: #6366f1; color: #ffffff; }
        }
    `;

    const showPrompt = (message, defaultValue) => new Promise(resolve => {
        const host = document.createElement('div');
        host.setAttribute('data-tsc-desktop-prompt', '');
        const root = host.attachShadow({mode: 'open'});

        const style = document.createElement('style');
        style.textContent = STYLE;

        const dialog = document.createElement('dialog');
        dialog.setAttribute('aria-labelledby', 'message');

        const form = document.createElement('form');
        form.method = 'dialog';

        const text = document.createElement('p');
        text.id = 'message';
        // textContent, never innerHTML: the message can come from a project
        text.textContent = message;

        const input = document.createElement('input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-labelledby', 'message');
        input.value = defaultValue;

        const buttons = document.createElement('div');
        buttons.className = 'buttons';
        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.textContent = 'Cancel';
        const okButton = document.createElement('button');
        okButton.type = 'submit';
        okButton.className = 'ok';
        okButton.value = 'ok';
        okButton.textContent = 'OK';
        buttons.append(cancelButton, okButton);

        form.append(text, input, buttons);
        dialog.append(form);
        root.append(style, dialog);

        // Enter submits the form (OK). Escape closes the dialog without OK.
        cancelButton.addEventListener('click', () => dialog.close('cancel'));
        dialog.addEventListener('close', () => {
            const value = dialog.returnValue === 'ok' ? input.value : null;
            host.remove();
            resolve(value);
        });

        (document.body || document.documentElement).append(host);
        dialog.returnValue = '';
        dialog.showModal();
        input.focus();
        input.select();
    });

    // One dialog at a time: a second prompt() waits for the first one
    let queue = Promise.resolve();
    const prompt = (message, defaultValue) => {
        const text = message === undefined ? '' : String(message);
        const value = defaultValue === undefined || defaultValue === null ? '' : String(defaultValue);
        const result = queue.then(() => showPrompt(text, value));
        queue = result.catch(() => {});
        return result;
    };

    Object.defineProperty(window, 'prompt', {
        value: prompt,
        writable: true,
        configurable: true,
        enumerable: true
    });
};

if (isAppPage) {
    contextBridge.exposeInMainWorld('TurboScratchDesktop', {
        isDesktop: true,
        version: getVersion(),
        platform: process.platform
    });
    contextBridge.executeInMainWorld({func: installPrompt});
}
