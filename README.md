# TurboScratch IDE

A Scratch mod that combines **TurboWarp's** fast compiler, addons and advanced
settings with **real-time collaboration**: several people can edit the same
project at the same time, like in Gandi IDE.

![logo](branding/turboscratch-icon.svg)

## Online

- Website: **https://turboscratch-ide.github.io**
- Editor: **https://turboscratch-ide.github.io/Turboscratch_IDE/editor.html**

The editor is rebuilt and published automatically by GitHub Actions
(`.github/workflows/deploy-pages.yml`) every time `main` is pushed.

GitHub Pages only hosts the editor's web pages; it can't run the collaboration
server. Because the website uses https, browsers only let it connect to a
**secure `wss://` server**. It can't reach a server on your own computer
(`ws://localhost` is blocked). So:

- To collaborate on the same Wi-Fi without hosting anything, use the local editor
  (`start-turboscratch.command`, below).
- To collaborate and use accounts on the website, run the server online. The
  easiest free setup is [Render](https://render.com) plus a free
  [Neon](https://neon.tech) PostgreSQL database: open
  `https://render.com/deploy?repo=https://github.com/TurboScratch-IDE/Turboscratch_IDE`,
  paste the Neon connection string as `DATABASE_URL`, and deploy (see `render.yaml`).
  Then set a repository variable
  `TSC_COLLAB_SERVER` (Settings → Secrets and variables → Actions → Variables) to that
  `wss://` address so the website uses it by default. You can set
  `ALLOWED_ORIGINS=https://turboscratch-ide.github.io` on the server to only accept
  connections from the website.

## Start it on your computer

Double-click **`start-turboscratch.command`** (or run it in Terminal). It
starts two things:

| What | Address |
| --- | --- |
| The editor | http://localhost:8601/editor.html |
| The collaboration server | ws://localhost:8090 |

The first start builds the editor, which takes 1–3 minutes. Press `Ctrl+C` in
the window to stop.

## Work together

1. Click **Collaborate** in the menu bar and type your name.
2. **Open rooms** lists the rooms people are in right now. Click **Join** next to
   one to join it. You don't need a link.
3. Or start your own room: keep the room code (or click **New code**), then
   **Join room**.
   - **New room:** your current project becomes the shared project. With
     "Show a new room in Open rooms" ticked (the default), everyone on the
     server sees it in their list and can join. Untick it to keep the room
     private.
   - **Room name (optional):** the name people see in Open rooms. Without one,
     the room shows your project's name.
   - **Room password (optional):** a new room gets this password (at least 4
     characters). Everyone who wants to join must type it first; only then
     do they get the project. Rooms with a password show a 🔒 in Open rooms.
   - **Existing room:** your editor switches to the room's project, so save
     your own work first. If the room has a password, type it in the password
     box (or in the box that opens when you click **Join** in Open rooms).
   - Inside a room, anyone in it can rename the room and set, change or remove
     its password. People already in the room stay in it, and if their
     connection drops they get back in without typing it (for 6 hours). After
     a password change, tell everyone the new one: someone who clicks **Leave
     room**, or comes back after the server restarted, needs it.
   - If a room that had a password ever comes back without it (for example
     the server lost its files and someone else made the room again), your
     editor leaves it straight away, so your project stays private. The same
     happens when you type a password but the room (or the server) has none:
     empty the password box and join again if you want to join it anyway.
4. For a room that isn't in Open rooms, click **Copy invite link** and send it
   to your friends. (When you open an invite link, the box starts unticked.)
   Anyone in a room can show it in Open rooms or hide it again with the
   checkbox under the room code. Hiding only takes it off the list: people who
   already know the room code can still join.

Friends on the same Wi-Fi must open the editor using your computer's network
address (the launcher prints it, for example `http://192.168.1.20:8601/editor.html`),
not `localhost`. To work together over the internet, the collaboration server
needs to run somewhere everyone can reach (a VPS or a hosting service with
WebSocket support). Then enter its `wss://` address under **Server** in the
Collaborate dialog. **Use the default server** puts the website's own server
back.

## Accounts, posting, friends and studios

Click **Sign in** (top right) to create an account with a **nickname and a
password**. With an account you can:

- **Post** your project so everyone on the server can find and open it
  (**Explore**), and later save new versions of it.
- **Add friends** by nickname; they accept or decline your request.
- **Make studios**: shared collections of projects. The owner invites people by
  nickname, members add their projects, and the owner can remove members.

Passwords are never stored: the server keeps only a salted scrypt hash. Sign-in
attempts are rate-limited. There's no email, so a forgotten password can't be
reset yet, and there are no moderation or report tools yet. Keep that in mind
before inviting people you don't know.

Accounts live on the TurboScratch server. On your computer they're stored in
`collab-server/data/community.sqlite`. Online they need a PostgreSQL database
(`DATABASE_URL`), because free hosting forgets files when it sleeps.

### What syncs live

- Blocks: adding, moving, deleting, editing numbers/text/dropdowns, custom blocks
- Variables and lists (local and global), comments
- Sprites: add, upload, duplicate, delete (and restore), rename, reorder,
  position/size/direction/visibility
- Costumes and backdrops: add, upload, paint-editor changes, rename, delete,
  duplicate, reorder
- Sounds: add, record/upload, sound-editor changes, rename, delete, duplicate, reorder
- Blocks dragged onto another sprite, extensions, TurboWarp's advanced settings
  (FPS, interpolation, limits, stage size)
- Loading a different project (File → Load / New) replaces the project for everyone
- Presence (who is editing which sprite) and a room chat

Rooms are saved in `collab-server/data/` so they survive a server restart, and
even a crash: new edits reach the disk within a fraction of a second. Each room
has a project file (`<room>.<number>.sb3`), a list of the edits since then
(`<room>.ops`) and its settings (`<room>.json`). A damaged file is never
overwritten: it's renamed to `...damaged-<time>` and the server uses whatever
can still be read.

### Collaboration server settings

Set these as environment variables (or in `collab-server/.env`). The defaults
are fine for most servers.

| Setting | Default | What it does |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | (any) | Websites allowed to connect, e.g. `https://turboscratch-ide.github.io` |
| `ROOM_EXPIRE_DAYS` | 90 | Rooms nobody opened for this many days are deleted (0 = keep forever) |
| `MAX_ROOM_STORAGE_MB` | 2048 | No new rooms are created while room files use more than this; existing rooms keep working (0 = no limit) |
| `MAX_PENDING_SEND_MB` | 256 | When this much data is waiting to be sent, people joining big rooms are asked to try again in a moment (0 = no limit) |
| `CREATOR_GRACE_MS` | 15000 | If a room's creator loses their connection before their project arrives, how long they get to come back |
| `FIRST_SNAPSHOT_TIMEOUT_MS` | 180000 | How long people wait for a new room's project before they're told it isn't coming (they keep waiting while it's still uploading) |
| `MAX_OP_LOG_OPS`, `MAX_OP_LOG_MB` | 10000, 100 | How many edits a room can collect before its project must be saved again (normally that happens long before) |
| `ROOM_PASSWORD_TRIES_PER_IP`, `ROOM_PASSWORD_TRIES_PER_ROOM` | 10, 30 | Wrong room passwords allowed every 10 minutes, per address and room, and per room from everyone |
| `ROOM_PASSWORD_HASHES_PER_MINUTE` | 10 | New password rooms and password changes per address per minute |
| `ROOM_PASSWORD_CHECKS_PER_ADDRESS` | 16 | Password checks one address can have running or waiting at once |
| `DROPPED_MEMBER_KEEP_MS` | 21600000 (6 hours) | How long someone whose connection dropped can come back into a room with a password without typing it again |
| `TRUSTED_PROXY_HOPS` | 0 (1 on Render) | How many proxies (like Caddy or a hosting service) sit in front of the server, so the password limits see people's real addresses |

The server is built to be safe on the internet: one person can't crash it with
a strange message, make it run out of memory or disk, or break other rooms.
If your Wi-Fi drops for a moment, the editor reconnects by itself and you keep
your place and colour in the room.

### Known limitations

- If two people change the *same* thing at the same moment, the last change wins.
- An open paint or sound editor doesn't redraw when someone else edits that same
  costume/sound; you'll see a notice. Click another costume or sound and back to
  see their change.
- Not synced: monitors (variable displays on the stage), which costume is
  selected, sprite layer order, the project title, turbo mode.
- Without a password, anyone who knows a room code can join the room. Give rooms
  a password, and only share it with people you trust. Invite links never
  contain the password: tell your friends the password yourself.
- Room passwords are stored only as a salted scrypt hash, and wrong guesses are
  limited (10 per address and 30 for everyone per room, every 10 minutes). If
  someone keeps guessing wrong, new people may have to wait a few minutes
  before they can join; people already in the room aren't affected. Behind a
  tunnel (like playit.gg) the server may see everyone as the same address, so
  these limits then count for everyone together.
- Someone still using an editor from before room passwords (an old page that
  wasn't reloaded) who is in a room when it gets a password stays in, but
  after their connection drops for good or the server restarts, their editor
  keeps trying to reconnect. Reloading the page gets the new editor.
- The "Sprite folders" addon is off by default because it renames and reorders
  things differently on each person's screen, which breaks syncing.
- When something looks out of sync, click **Resync project** in the Collaborate
  dialog to reload the room's copy.

## Ada, the AI coding helper

Click **Ada** in the menu bar to open a panel with two tabs:

- **Console**: a debugger console that records what your project does while it
  runs: the green flag and stop, what sprites say and think, broadcasts,
  variable and list changes, clones, compiler problems, and the Debugger addon's
  log / warn / error / breakpoint blocks. It works without an account or server.
- **Chat**: Ada, an AI helper. She can read your sprites' scripts, check
  variables and sprite positions, read the console, and run your project for a
  few seconds to see what happens, then explain step by step how to fix it. She
  can't change your project; you make the changes. You need to be signed in.

Ada uses the [Claude API](https://platform.claude.com), which costs money per
message, so the server owner needs an API key:

1. Create a key at https://platform.claude.com (it needs billing set up; ask a
   parent if you're not an adult).
2. Copy `collab-server/.env.example` to `collab-server/.env` and put the key after
   `ANTHROPIC_API_KEY=`. Online (Render etc.), add `ANTHROPIC_API_KEY` as an
   environment variable instead.
3. Restart the server. Never put the key in the editor, in chat, or on GitHub:
   `.env` is ignored by git.

The key stays on the server; the browser only talks to your TurboScratch server.
Ada uses Claude Opus 5.5 by default. To spend about 40 times less, set
`TSC_AI_MODEL=claude-haiku-5-5` (a bit less clever). `TSC_AI_NAME` renames her.

To keep the bill under control, the server counts how much Ada is used per day
(saved in the database, so restarts don't reset it) in "AI tokens" (answers count
5×, re-read cached text counts very little). On Claude Opus 5.5, 1,000,000 AI tokens
cost about $4; on Claude Haiku 5.5 about $0.10.

| Setting | Default | What it limits |
| --- | --- | --- |
| `AI_TOKENS_PER_DAY` | 5,000,000 | Everyone together, per day |
| `AI_TOKENS_PER_USER_PER_DAY` | 1,000,000 | One account, per day |
| `AI_TOKENS_PER_IP_PER_DAY` | 2,000,000 | One internet connection, per day |
| `AI_TURNS_PER_DAY` | 150 | Answers per account per day (one question can use several) |
| `AI_MAX_CONCURRENT` | 8 | Answers being written at the same time |

Also set a monthly spending limit in the Claude Console, just in case.

## Folders

| Folder | What's inside |
| --- | --- |
| `editor/` | The editor: TurboWarp's `scratch-gui` plus TurboScratch changes |
| `editor/src/lib/tsc-collab/` | Collaboration engine (session, VM sync, ID-preserving project export) |
| `editor/src/components/tsc-collab/` | Collaborate dialog and menu-bar button |
| `editor/src/lib/tsc-ai/`, `editor/src/components/tsc-ai/` | Ada: debugger console, her tools, chat loop and panel |
| `collab-server/ai/` | Ada's server side (talks to the Claude API) |
| `editor/src/lib/themes/accent/turbo.js` | The TurboScratch color theme (default) |
| `collab-server/` | The collaboration server (`npm start`, tests with `npm test`) |
| `branding/` | Logo and app icons |

## Updating from TurboWarp

`editor/` started from TurboWarp/scratch-gui commit
`757231893bb887d9c20379be8937fe97784b3392`. To pull in newer TurboWarp changes,
compare against that commit.

## License and credits

TurboScratch IDE is based on [TurboWarp](https://turbowarp.org/) by Thomas Weber
and contributors, which is based on [Scratch](https://scratch.mit.edu/) by the
Scratch Foundation and MIT. TurboWarp's changes are licensed under GPL-3.0, so
TurboScratch IDE is GPL-3.0 too: if you share it, share the source code as well.
Scratch is a project of the Scratch Foundation; TurboScratch IDE is not affiliated
with or endorsed by the Scratch Foundation or TurboWarp.
