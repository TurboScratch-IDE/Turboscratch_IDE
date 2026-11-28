# TurboScratch IDE desktop app

The editor as an app for Windows and Mac, made with [Electron](https://www.electronjs.org/).
It shows the same editor as the website, from files inside the app, so it starts
without internet. Collaborate, Open rooms and accounts still need the internet.

## Run it from source

You need Node.js 22. On the Mac in this project, put it on PATH first:
`export PATH="$HOME/.local/node/bin:$PATH"`.

```sh
cd desktop
npm install
npm run build-editor   # builds editor/ for the app and copies it here (a few minutes)
npm start              # opens the app
npm test               # unit tests (path safety, link rules, versions)
```

Run `npm run build-editor` again after changing the editor. It bakes in the
collaboration server `wss://turboscratch-rooms.playit.plus`; set
`TSC_COLLAB_SERVER` to use another one.

## Make installers

```sh
npm run dist:mac   # dist/TurboScratch-IDE-mac-x64.dmg and -mac-arm64.dmg (needs a Mac)
npm run dist:win   # dist/TurboScratch-IDE-windows-setup.exe
```

Releases are built by `.github/workflows/desktop.yml` when a `v*` tag is pushed.
The version comes from `version` in `package.json`.

The apps are not signed with a paid certificate. On a Mac they are "ad-hoc"
signed, which Apple chips need to run them at all.

## How it works

| File | What it does |
| --- | --- |
| `src/main.js` | Windows, menu, unsaved-changes question, link and permission rules |
| `src/app-protocol.js` | Serves the editor from `tsc-app://editor/` |
| `src/app-files.js` | Turns a `tsc-app://` address into a file, refusing anything outside the editor folder |
| `src/policy.js` | Which links open where, and which permissions pages get |
| `src/preload.js` | Gives the page `window.TurboScratchDesktop` and a `prompt()` dialog |
| `src/updates.js` | Looks for a newer GitHub release and offers the download page |
| `scripts/build-editor.js` | Builds the editor for the app |
| `scripts/make-icons.js` | Makes `build/icon.png` and `build/icon.ico` from `branding/turboscratch-icon.svg` |

Never change the `tsc-app://editor` address or the app name "TurboScratch IDE":
saved settings, restore points, the backpack and sign-in are stored under them.
