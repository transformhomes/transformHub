# TH Command Centre (transformHub)

One window for your inbox, projects, tasks, calendar, Teams, OneDrive and Claude.
Windows desktop app built with Electron. Version 0.2.

| Icon | What it is |
|---|---|
| Home | Needs attention (overdue and due today), today's events, next 7 days, focus project |
| Inbox | Outlook on the web |
| AI Projects | Your project list. Open one for its tasks, a button to open Antigravity in its folder, and Arcane |
| Tasks | Add, tick off, delete (with undo). Saved on this computer |
| Calendar | Full month view, side panel with today and the next 14 days, add events. Saved on this computer |
| Teams | Microsoft Teams on the web |
| Files | OneDrive on the web |
| Claude | claude.ai on the web |

Outlook, Teams, OneDrive and Claude are the web versions, signed in once and kept signed in.
Tasks and Calendar are built in and do not read your Outlook calendar or Microsoft To Do.

## Run it (Windows, not inside WSL)

1. Install Node.js 20 or newer for Windows from https://nodejs.org (LTS).
2. In PowerShell in this folder:

       npm install
       npm start

Keys: Ctrl+1 to Ctrl+8 switch section, Ctrl+R reloads the current section.

## Your projects and name

The app creates its settings file on first run at `%APPDATA%\th-command-centre\config.json`.
The committed default only has an example project. To use your own list, edit that file
(cog icon in the left rail opens it), or copy `config.dale.json` over it before first run.
`config.dale.json` holds your real project names and folders, and is ignored by git so it
never goes to GitHub.

Settings you can change: `userName`, `projects` (id, name, folder), `agentCommand`
(default `agy`, the Antigravity command), `arcaneUrl`, `dataDir`, and the `sections` list.
Restart the app after editing. Upgrading from 0.1: your old settings are kept as
`config.v1.bak.json` and replaced with the new layout.

## Where your data lives

Tasks and events: `%APPDATA%\th-command-centre\data\data.json`, on this computer's drive.
Every save keeps the previous good copy as `data.json.bak`, writes through a temporary file
so a crash cannot leave a half-written file, and a damaged file is set aside as
`data.json.corrupt-<time>` instead of being overwritten. To keep it somewhere else (for
example a OneDrive folder for backup), set `dataDir` in the settings file.

## Antigravity button

"Open in Antigravity" runs `agy "<project folder>"`. It needs Antigravity installed with the
`agy` command on your PATH. If it is not found, the page says so. The command name comes from
the settings file, and the folder must be one listed in your projects.

## Make an installer (optional)

       npm run dist

## Known limits

- Outlook is the web version, not the classic desktop program (which cannot be embedded).
- Claude here is claude.ai on the web, not the Claude desktop app. If Google sign-in is
  refused inside the app, sign in to Claude with your email link instead.
- Events cannot be edited yet: delete and re-add.
- Chat, Docs, a side drawer and a music player are not built.
- Tested on Linux in a virtual display, not yet on Windows. Sign-in to Microsoft and Claude has
  not been tested.

## Putting it on GitHub

The repository transformhomes/transformHub is currently public. Consider making it private
(Settings, then Danger Zone, then Change visibility) until the app is stable, and decide on a
licence before sharing it. No licence file is included.

       git init
       git add .
       git status          (check config.dale.json is NOT listed)
       git commit -m "Initial commit: TH Command Centre 0.2"
       git branch -M main
       git remote add origin https://github.com/transformhomes/transformHub.git
       git push -u origin main
