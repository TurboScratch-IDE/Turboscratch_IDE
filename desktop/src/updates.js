// Checks GitHub for a newer release and offers to open the download page.
// It never downloads or installs anything itself: the app is not signed, so
// people install new versions the same way they installed this one.

const {app, dialog, net, shell} = require('electron');
const {isNewerVersion} = require('./version');

const REPO_URL = 'https://github.com/TurboScratch-IDE/Turboscratch_IDE';
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const LATEST_RELEASE_API = 'https://api.github.com/repos/TurboScratch-IDE/Turboscratch_IDE/releases/latest';
const TIMEOUT_MS = 10 * 1000;

/**
 * @returns {Promise<{version: string, url: string}|null>} null when there is
 * no published release yet
 */
const fetchLatestRelease = async () => {
    const response = await net.fetch(LATEST_RELEASE_API, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`GitHub answered ${response.status}`);
    }
    const release = await response.json();
    const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    // Only ever open a page of our own repository, whatever the answer says
    const url = typeof release.html_url === 'string' && release.html_url.startsWith(`${REPO_URL}/releases/`) ?
        release.html_url :
        RELEASES_URL;
    return {version, url};
};

/**
 * @param {object} options
 * @param {boolean} options.manual true when the person picked "Check for updates",
 * so they also hear about "no update" and errors. The check at start stays quiet.
 * @param {() => Electron.BrowserWindow|null} options.getWindow window to attach the dialog to
 */
const checkForUpdates = async ({manual, getWindow}) => {
    const currentVersion = app.getVersion();
    const showBox = boxOptions => {
        const win = getWindow();
        return win && !win.isDestroyed() ?
            dialog.showMessageBox(win, boxOptions) :
            dialog.showMessageBox(boxOptions);
    };

    let latest;
    try {
        latest = await fetchLatestRelease();
    } catch (e) {
        console.warn('Update check failed:', e.message);
        if (manual) {
            await showBox({
                type: 'warning',
                message: 'Could not check for updates',
                detail: 'Are you connected to the internet? You can try again later from the Help menu.',
                buttons: ['OK']
            });
        }
        return;
    }

    if (latest && isNewerVersion(latest.version, currentVersion)) {
        const {response} = await showBox({
            type: 'info',
            message: `A new version of TurboScratch IDE is ready: ${latest.version}`,
            detail: `You have version ${currentVersion}. Open the download page to get the new one.`,
            buttons: ['Open download page', 'Not now'],
            defaultId: 0,
            cancelId: 1
        });
        if (response === 0) {
            shell.openExternal(latest.url);
        }
        return;
    }

    if (manual) {
        await showBox({
            type: 'info',
            message: 'You have the newest version',
            detail: `TurboScratch IDE ${currentVersion} is up to date.`,
            buttons: ['OK']
        });
    }
};

module.exports = {
    REPO_URL,
    checkForUpdates
};
