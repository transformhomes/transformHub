# TH Command Centre (transformHub)

One window for your inbox, projects, tasks, calendar, Teams, OneDrive and Claude.
Windows desktop app built with Electron. See package.json for the version.

| Icon | What it is |
|---|---|
| Home | Needs attention (overdue and due today), today's events, next 7 days, focus project |
| Inbox | Outlook on the web |
| AI Projects | Your project list and a read-only folder browser (tree in the side panel) |
| Tasks | Add, tick off, delete (with undo). Saved on this computer. Can also show Microsoft To Do (experimental, read-only) |
| Calendar | Full month view, side panel with today and the next 14 days, add events. Saved on this computer. Can also show your Outlook calendar (read-only, see below) |
| Teams | Microsoft Teams on the web |
| Files | OneDrive on the web |
| Claude | claude.ai on the web |

Outlook, Teams, OneDrive and Claude are the web versions, signed in once and kept signed in.
Tasks and Calendar are built in.

## Quick start (Windows)
Double-click `transformHub.cmd`. It installs what it needs the first time, then opens the app with no console window. `Start-transformHub.ps1 -Shortcut` adds a desktop shortcut.

## Run it (Windows, not inside WSL)

1. Install Node.js 20 or newer for Windows from https://nodejs.org (LTS).
2. In PowerShell in this folder:

       npm install
       npm start

Keys. In the built-in pages (Home, AI Projects, Tasks, Calendar): Ctrl+1 to Ctrl+9 switch section, Ctrl+R reloads, Ctrl+K opens search and commands.
In web tabs (Outlook, Teams, OneDrive, Claude, DOMO) those keys belong to the site, so use Alt+1 to Alt+9 to switch section, F5 to reload and Ctrl+Shift+K for search.
Ctrl+\ shows or hides the activity panel everywhere.

## AI Projects as a file browser
Open AI Projects and the side panel becomes a folder tree of your projects. Click a folder to open it in the main area, click a file to preview it (text and images), and use Open or Show in Explorer for anything else. It is read-only: nothing is deleted or changed, programs and scripts are never run from here, and it cannot go outside your project folders.

## Light and dark, and the logo
The sun/moon button in the header switches between light and dark; your choice is remembered. Until you choose, the app follows Windows. If a file called `transformHub.png` sits in the app folder, it shows at the top of the left rail and is used as the window icon. The logo and icon files are not stored in this repository.

## Microsoft To Do in Tasks (experimental, read-only)
Add `"msTodo": { "enabled": true }` to your settings file (next to `userName`) and restart. The app then reads your To Do tasks from the To Do web page, using the same Microsoft sign-in as the Inbox tab, every 10 minutes. They show in the Tasks page and the activity panel (titles only, read-only; tick them off in To Do). It reads the page layout, so a Microsoft change can break it: the Tasks page then says so and offers a diagnostic that contains no task text. Sign in to Microsoft in the Inbox tab first.

## Icons
Rail icons are colour-coded by type. Web tabs show the site's own icon once you have opened the tab once.

## Adding a web tab (for example a dashboard)
Add a section to your personal settings file: `{ "id": "domo", "label": "DOMO", "icon": "chart", "type": "web", "url": "https://your-dashboard-link" }`. Keep company dashboard links in your personal settings file only, never in the files you commit. Sign-in happens inside the app; whether your company's single sign-on works there is untested.

## Your projects and name

The app creates its settings file on first run at `%APPDATA%\th-command-centre\config.json`.
The committed default only has an example project. To use your own list, edit that file
(cog icon in the left rail opens it). A personal `config.dale.json` can hold real project
names and folders; it is ignored by git so it never goes to GitHub.

Settings you can change: `userName`, `calendarFeeds`, `projects` (id, name, folder), `arcaneUrl`, `dataDir`, `msTodo` and the `sections` list.
Restart the app after editing. Upgrading from 0.1: your old settings are kept as
`config.v1.bak.json` and replaced with the new layout.

## Where your data lives

Tasks and events: `%APPDATA%\th-command-centre\data\data.json`, on this computer's drive.
Every save keeps the previous good copy as `data.json.bak`, writes through a temporary file
so a crash cannot leave a half-written file, and a damaged file is set aside as
`data.json.corrupt-<time>` instead of being overwritten. To keep it somewhere else (for
example a OneDrive folder for backup), set `dataDir` in the settings file.

## Show your Outlook calendar (read-only)

In Outlook on the web: Settings, Calendar, Shared calendars, Publish a calendar. Choose the
calendar and permission, click Publish, and copy the **ICS** link. Then add it to your
settings file (`%APPDATA%\th-command-centre\config.json`, cog icon opens it):

       "calendarFeeds": [ { "name": "Outlook", "url": "PASTE_THE_ICS_LINK_HERE" } ],

Restart the app. Outlook events then show in the Calendar tab (teal, with the feed name) and on
Home. They are read-only: change them in Outlook. The app refreshes every 15 minutes and from the
"Refresh now" button, and keeps showing the last good copy if a refresh fails.

The link is a secret: anyone with it can read that calendar. Keep it only in your settings file.
It is never sent to the pages, written to the cache or logged. Only the title, date and time of
each event are kept (no attendees, notes or locations). `config.json` and `config.dale.json` are
ignored by git. To cancel the link, unpublish the calendar in Outlook on the web.

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

## Licence

No licence file is included; the code is for Transform Homes internal use.
