// TurboScratch IDE desktop app: the main process.
// It opens the bundled editor in app windows and decides what may open where.

const {app, BrowserWindow, Menu, dialog, screen, session, shell} = require('electron');
const path = require('path');
const {registerAppScheme, handleAppScheme} = require('./app-protocol');
const policy = require('./policy');
const {buildMenu} = require('./menu');
const {REPO_URL, checkForUpdates} = require('./updates');

const isMac = process.platform === 'darwin';
const isDev = !app.isPackaged;

const LINKS = {
    website: 'https://turboscratch-ide.github.io/',
    source: REPO_URL,
    license: 'https://www.gnu.org/licenses/gpl-3.0.html'
};

// Only used when running from source: installed apps get their icon from the
// .app bundle or the .exe.
const DEV_ICON = path.join(__dirname, '..', 'build', 'icon.png');

const LEAVE_DIALOG = {
    type: 'warning',
    message: 'You have unsaved changes. Leave anyway?',
    detail: 'If you leave now, your changes are lost. Save your project first to keep them.',
    buttons: ['Leave', 'Stay'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
};

// True while the app is trying to quit (Cmd+Q, or Exit on Windows)
let quitting = false;

const openExternal = url => {
    if (!policy.isExternalUrl(url)) {
        return;
    }
    // Lets automatic tests check the link rules without opening a browser
    if (process.env.TSC_DESKTOP_TEST_NO_EXTERNAL === '1') {
        console.log(`[test] Would open in the browser: ${url}`);
        return;
    }
    shell.openExternal(url).catch(err => {
        console.warn('Could not open link:', err.message);
    });
};

const getMainWindow = () => (
    BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find(win => !win.isDestroyed()) || null
);

// The editor's "Leave site?" check (beforeunload) silently blocks closing in
// Electron, because there is no browser to show the question. So we ask.
const guardUnsavedChanges = win => {
    let closeRequested = false;
    let askingToClose = false;

    // 'close' comes before the page's beforeunload, so it tells us why the
    // page is being unloaded.
    win.on('close', () => {
        closeRequested = true;
    });

    win.webContents.on('will-prevent-unload', event => {
        if (closeRequested) {
            // Closing the window (or quitting). Electron has already stopped
            // the close and any quit. We ask a moment later instead of inside
            // this event, because a dialog inside it breaks keyboard focus on
            // Windows (TurboWarp Desktop ran into this), and close the window
            // ourselves if the person picks Leave.
            closeRequested = false;
            const wasQuitting = quitting;
            quitting = false;
            if (askingToClose) {
                return;
            }
            askingToClose = true;
            setTimeout(async () => {
                const {response} = await dialog.showMessageBox(win, LEAVE_DIALOG);
                askingToClose = false;
                if (response === 0 && !win.isDestroyed()) {
                    win.destroy();
                    if (wasQuitting) {
                        app.quit();
                    }
                }
            });
            return;
        }

        // Reloading or going to another app page. Only preventDefault() during
        // this event lets the page go on, so this question has to wait here.
        if (dialog.showMessageBoxSync(win, LEAVE_DIALOG) === 0) {
            event.preventDefault();
        }
    });
};

const offerReloadAfterCrash = win => {
    win.webContents.on('render-process-gone', async (event, details) => {
        if (details.reason === 'clean-exit' || win.isDestroyed()) {
            return;
        }
        const {response} = await dialog.showMessageBox(win, {
            type: 'error',
            message: 'The editor stopped working',
            detail: 'Reload it to keep going. If you lost work, look in File > Restore points.',
            buttons: ['Reload', 'Close window'],
            defaultId: 0,
            cancelId: 1,
            noLink: true
        });
        if (win.isDestroyed()) return;
        if (response === 0) {
            win.webContents.reload();
        } else {
            win.destroy();
        }
    });
};

/**
 * Opens an app page (the editor, addon settings, credits...) in a new window.
 * Each window gets its own page process, so a busy project in one window
 * doesn't slow down the others.
 */
const createAppWindow = (url = policy.START_URL) => {
    const isAddons = new URL(url).pathname === '/addons.html';
    const {width: screenWidth, height: screenHeight} = screen.getPrimaryDisplay().workAreaSize;
    const width = Math.min(isAddons ? 1000 : 1280, screenWidth);
    const height = Math.min(isAddons ? 720 : 800, screenHeight);

    // Place new windows a little down and right of the current one (not for
    // a full-screen or maximized one: there is no room)
    const current = BrowserWindow.getFocusedWindow();
    const position = current && !current.isFullScreen() && !current.isMaximized() ? {
        x: current.getBounds().x + 30,
        y: current.getBounds().y + 30
    } : {};

    const win = new BrowserWindow({
        width,
        height,
        ...position,
        minWidth: 640,
        minHeight: 480,
        title: 'TurboScratch IDE',
        icon: isDev && !isMac ? DEV_ICON : undefined,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
            spellcheck: false,
            // Keep timers running at full speed when the window is minimized
            // or covered, or collaboration thinks the connection died (its
            // heartbeat is a timer) and running projects slow down.
            backgroundThrottling: false,
            // The preload can't ask for the app version itself (it is sandboxed)
            additionalArguments: [`--tsc-desktop-version=${app.getVersion()}`]
        }
    });

    win.once('ready-to-show', () => win.show());
    guardUnsavedChanges(win);
    offerReloadAfterCrash(win);
    win.loadURL(url);
    return win;
};

/**
 * window.open() and target=_blank links, for every window.
 * @param {Electron.WebContents} contents
 * @returns {Electron.WindowOpenHandlerResponse}
 */
const handleWindowOpen = (contents, {url}) => {
    switch (policy.windowOpenAction(contents.getURL(), url)) {
    case 'app-window':
        createAppWindow(url);
        return {action: 'deny'};
    case 'packager':
        // A real child window, so the packager can message the editor that
        // opened it. It is a website, so it gets no preload, and it keeps the
        // safe defaults (sandbox, no Node.js).
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                width: 1100,
                height: 800,
                autoHideMenuBar: true,
                webPreferences: {
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                    webviewTag: false
                }
            }
        };
    case 'external':
        openExternal(url);
        return {action: 'deny'};
    default:
        return {action: 'deny'};
    }
};

const applyLinkRules = contents => {
    contents.setWindowOpenHandler(details => handleWindowOpen(contents, details));

    contents.on('will-navigate', (event, legacyUrl) => {
        const targetUrl = event.url || legacyUrl;
        const action = policy.navigationAction(contents.getURL(), targetUrl);
        if (action === 'allow') {
            return;
        }
        // Links that would replace the editor with a website (or a file that
        // was dropped in the wrong place) never load in the app window.
        event.preventDefault();
        if (action === 'external') {
            openExternal(targetUrl);
        }
    });

    // Electron has no right-click menu for text boxes on its own
    contents.on('context-menu', (event, params) => {
        let template;
        if (params.isEditable) {
            template = [
                {role: 'undo'},
                {role: 'redo'},
                {type: 'separator'},
                {role: 'cut'},
                {role: 'copy'},
                {role: 'paste'},
                {type: 'separator'},
                {role: 'selectAll'}
            ];
        } else if (params.selectionText) {
            template = [{role: 'copy'}];
        } else {
            return;
        }
        Menu.buildFromTemplate(template).popup({
            window: BrowserWindow.fromWebContents(contents) || undefined
        });
    });
};

// Camera and microphone: a project can switch them on just by using the video
// sensing or loudness blocks. A browser asks first, so the app asks too.
// "Allow" counts until the app is closed; after "Don't allow" it asks again
// the next time a project wants the device.
const MEDIA_QUESTIONS = {
    video: {
        message: 'Allow TurboScratch IDE to use your camera?',
        detail: 'The project wants to use the camera (for example for video sensing blocks).'
    },
    audio: {
        message: 'Allow TurboScratch IDE to use your microphone?',
        detail: 'The project wants to use the microphone (for example to record a sound or for the loudness block).'
    }
};
// 'video' or 'audio' -> the open or allowed question (a promise), and true once allowed
const mediaQuestions = new Map();
const mediaAnswers = new Map();

const askForMedia = (mediaType, win) => {
    if (!mediaQuestions.has(mediaType)) {
        const question = MEDIA_QUESTIONS[mediaType];
        const options = {
            type: 'question',
            message: question.message,
            detail: question.detail,
            buttons: ['Allow', 'Don\'t allow'],
            defaultId: 1,
            cancelId: 1,
            noLink: true
        };
        // Saved right away, so two requests at once show only one question
        mediaQuestions.set(mediaType, (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
            .then(({response}) => response === 0, () => false)
            .then(allowed => {
                if (allowed) {
                    mediaAnswers.set(mediaType, true);
                } else {
                    mediaQuestions.delete(mediaType);
                }
                return allowed;
            }));
    }
    return mediaQuestions.get(mediaType);
};

const setUpPermissions = () => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
        if (!policy.isPermissionAllowed(permission, details.requestingUrl)) {
            callback(false);
            return;
        }
        if (permission !== 'media') {
            callback(true);
            return;
        }
        const mediaTypes = (details.mediaTypes || []).filter(type => MEDIA_QUESTIONS[type]);
        if (mediaTypes.length === 0) {
            callback(false);
            return;
        }
        const win = contents && BrowserWindow.fromWebContents(contents);
        const answers = [];
        for (const type of mediaTypes) {
            answers.push(await askForMedia(type, win));
        }
        callback(answers.every(Boolean));
    });
    ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
        if (!policy.isPermissionAllowed(permission, requestingOrigin || details.requestingUrl)) {
            return false;
        }
        if (permission === 'media') {
            // Only "yes" after the person said yes. Otherwise the page makes a
            // request, which asks the question above.
            return mediaAnswers.get(details.mediaType) === true;
        }
        return true;
    });
};

const showAbout = async () => {
    const version = app.getVersion();
    const options = {
        type: 'info',
        title: 'About TurboScratch IDE',
        message: `TurboScratch IDE ${version}`,
        detail: [
            'Build Scratch projects together.',
            '',
            'Based on TurboWarp and Scratch. TurboScratch IDE is not affiliated with ' +
                'or endorsed by the Scratch Foundation or TurboWarp.',
            '',
            'Copyright © 2026 TurboScratch IDE contributors.',
            'This is free software under the GNU General Public License version 3 (GPL-3.0). ' +
                'It comes with NO WARRANTY.',
            `Source code: ${REPO_URL}`,
            '',
            `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`
        ].join('\n'),
        buttons: ['OK', 'Source code', 'License'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
    };
    const win = getMainWindow();
    const {response} = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
    if (response === 1) {
        // The exact code this version was made from
        openExternal(`${REPO_URL}/tree/v${version}`);
    } else if (response === 2) {
        openExternal(LINKS.license);
    }
};

const runUpdateCheck = manual => {
    checkForUpdates({manual, getWindow: getMainWindow}).catch(err => {
        console.warn('Update check failed:', err);
    });
};

const start = () => {
    // Runs before 'ready': Electron needs both of these early
    app.enableSandbox();
    registerAppScheme();

    app.on('second-instance', () => {
        // Opening the app again just brings the open window to the front
        const win = getMainWindow();
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        } else {
            createAppWindow();
        }
    });

    app.on('web-contents-created', (event, contents) => {
        contents.on('will-attach-webview', e => e.preventDefault());
        applyLinkRules(contents);
    });

    app.on('before-quit', () => {
        quitting = true;
    });

    app.on('window-all-closed', () => {
        // On macOS apps stay open without windows, until Cmd+Q
        if (!isMac || quitting) {
            app.quit();
        }
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createAppWindow();
        }
    });

    app.whenReady().then(() => {
        if (process.platform === 'win32') {
            // Must match the installer's shortcuts so the taskbar groups windows
            app.setAppUserModelId('io.github.turboscratch-ide.desktop');
        }
        if (isMac && isDev) {
            try {
                app.dock.setIcon(DEV_ICON);
            } catch (e) {
                // No icon yet (npm run make-icons); the default one is fine
            }
        }

        handleAppScheme();
        setUpPermissions();
        Menu.setApplicationMenu(buildMenu({
            isMac,
            isDev,
            newWindow: () => createAppWindow(),
            showAbout,
            checkForUpdates: () => runUpdateCheck(true),
            openExternal,
            links: LINKS
        }));

        const firstWindow = createAppWindow();
        // Look for a new version once, after the editor has loaded, so it
        // doesn't slow down the start. It stays quiet unless there is one.
        firstWindow.webContents.once('did-finish-load', () => {
            setTimeout(() => runUpdateCheck(false), 5000);
        });
    });
};

// A second copy of the app hands over to the first one and quits
if (app.requestSingleInstanceLock()) {
    start();
} else {
    app.quit();
}
