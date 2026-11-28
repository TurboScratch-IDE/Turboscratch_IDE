// Builds the editor for the desktop app and copies it to desktop/editor/.
//   npm run build-editor
// Works on Mac, Windows and Linux (plain Node, no shell scripts).
//
// The app needs its own editor build: the website's build has its
// /Turboscratch_IDE/ address baked into every file path, and on the app's
// tsc-app:// address the editor can only find the TurboScratch server if it
// is baked in at build time.

const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_COLLAB_SERVER = 'wss://turboscratch-rooms.playit.plus';
const DEFAULT_WEBSITE_URL = 'https://turboscratch-ide.github.io/Turboscratch_IDE/editor.html';

const DESKTOP_DIR = path.resolve(__dirname, '..');
const EDITOR_SOURCE_DIR = path.resolve(DESKTOP_DIR, '..', 'editor');
const EDITOR_BUILD_DIR = path.join(EDITOR_SOURCE_DIR, 'build');
const APP_EDITOR_DIR = path.join(DESKTOP_DIR, 'editor');

const fail = message => {
    console.error(`\nbuild-editor: ${message}`);
    process.exit(1);
};

// An empty value (for example an unset GitHub variable) means "use the default"
const fromEnv = (name, fallback) => (process.env[name] || '').trim() || fallback;

const collabServer = fromEnv('TSC_COLLAB_SERVER', DEFAULT_COLLAB_SERVER);
const websiteUrl = fromEnv('TSC_WEBSITE_URL', DEFAULT_WEBSITE_URL);

const env = {
    ...process.env,
    NODE_ENV: 'production',
    // The default 'filehash' routing only works on http(s) pages
    ROUTING_STYLE: 'hash',
    TSC_COLLAB_SERVER: collabServer,
    // Invite links made in the app point at the website, so friends can open them
    TSC_WEBSITE_URL: websiteUrl
};
// No ROOT: file paths stay relative, which works at tsc-app://editor/.
// No service worker: the app's files are already on disk.
for (const name of ['ROOT', 'ENABLE_SERVICE_WORKER', 'STATIC_PATH', 'EXTRA_META']) {
    delete env[name];
}

// Runs npm the same way on every system. Under "npm run", npm tells us where
// its own script is, and running that with Node avoids Windows' npm.cmd.
const runNpm = (args, cwd) => {
    const npmScript = process.env.npm_execpath;
    const result = npmScript && /\.c?js$/.test(npmScript) ?
        spawnSync(process.execPath, [npmScript, ...args], {cwd, env, stdio: 'inherit'}) :
        spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
            cwd,
            env,
            stdio: 'inherit',
            shell: process.platform === 'win32'
        });
    if (result.error) {
        fail(`could not run npm: ${result.error.message}`);
    }
    if (result.status !== 0) {
        fail(`"npm ${args.join(' ')}" in ${cwd} failed (exit code ${result.status}).`);
    }
};

// Checks that a value really ended up inside the built JavaScript
const buildContains = text => {
    const jsDir = path.join(EDITOR_BUILD_DIR, 'js');
    const stack = [jsDir];
    while (stack.length > 0) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes(text)) {
                return true;
            }
        }
    }
    return false;
};

if (!fs.existsSync(path.join(EDITOR_SOURCE_DIR, 'package.json'))) {
    fail(`the editor source was not found at ${EDITOR_SOURCE_DIR}`);
}

if (!fs.existsSync(path.join(EDITOR_SOURCE_DIR, 'node_modules'))) {
    console.log('Installing editor packages first (this takes a few minutes)...');
    runNpm(['ci', '--no-audit', '--no-fund'], EDITOR_SOURCE_DIR);
}

console.log('Building the editor for the desktop app:');
console.log(`  collaboration server: ${collabServer}`);
console.log(`  website for invite links: ${websiteUrl}`);
runNpm(['run', 'build'], EDITOR_SOURCE_DIR);

if (!fs.existsSync(path.join(EDITOR_BUILD_DIR, 'editor.html'))) {
    fail('the editor build has no editor.html');
}
if (!buildContains(collabServer)) {
    fail(`the collaboration server ${collabServer} is missing from the built editor`);
}
if (!buildContains(websiteUrl)) {
    // Older editor code ignores TSC_WEBSITE_URL. The app still works, but
    // invite links made in it would not open for friends.
    console.warn(`\nWARNING: the built editor does not contain ${websiteUrl}, ` +
        'so invite links made in the app will not work for friends.');
}

console.log(`\nCopying the editor to ${APP_EDITOR_DIR}`);
fs.rmSync(APP_EDITOR_DIR, {recursive: true, force: true});
fs.cpSync(EDITOR_BUILD_DIR, APP_EDITOR_DIR, {recursive: true});
console.log('Done. Start the app with "npm start", or make installers with "npm run dist".');
