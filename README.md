# TH Command Centre (transformHub)

One window for your inbox, files, tasks, calendar, Teams, OneDrive and Claude.
Windows desktop app built with Electron. See package.json for the version.

| Icon | What it is |
|---|---|
| Home | Needs attention (overdue and due today), today's events, next 7 days, focus project |
| Inbox | Outlook on the web |
| Explorer | A read-only folder browser: favourites and your drives, with the folder tree in the side panel |
| Tasks | Add, tick off, delete (with undo). Saved on this computer. Can also show Microsoft To Do (experimental, read-only) |
| Calendar | Full month view, side panel with today and the next 14 days, add events. Saved on this computer. Can also show your Outlook calendar (read-only, see below) |
| Teams | Microsoft Teams on the web |
| Files | OneDrive on the web |
| Claude | claude.ai on the web |

Outlook, Teams, OneDrive and Claude are the web versions. Each person signs in once with their own account and stays signed in; sign-ins are stored on that person's own Windows profile, not in this code.
Tasks and Calendar are built in.

## Quick start (Windows)
Double-click `transformHub.cmd`. It installs what it needs the first time, then opens the app with no console window. `Start-transformHub.ps1 -Shortcut` adds a desktop shortcut.

## Run it (Windows, not inside WSL)

1. Install Node.js 20 or newer for Windows from https://nodejs.org (LTS).
2. In PowerShell in this folder:

       npm install
       npm start

Keys. In the built-in pages (Home, Explorer, Tasks, Calendar): Ctrl+1 to Ctrl+9 switch section, Ctrl+R reloads, Ctrl+K opens search and commands.
In web tabs (Outlook, Teams, OneDrive, Claude, dashboards) those keys belong to the site, so use Alt+1 to Alt+9 to switch section, F5 to reload and Ctrl+Shift+K for search.
Ctrl+\ shows or hides the side panel everywhere.

## Explorer
Open Explorer and the side panel becomes a folder tree with two groups. **Favourites** holds your configured project folders and any folder you star. **This PC** holds your drives (C:\ by default). Hover over a folder and click the star to add or remove it from Favourites; the same button is on each folder's page. Click a folder to open it in the main area, click a file to preview it (text and images), and use Open or Show in File Explorer for anything else.

It is read-only: nothing is deleted or changed, programs and scripts are never run from here, and it cannot go outside the folders you set up. System and sign-in folders are never shown on a drive (Windows, Program Files, ProgramData, AppData, the recycle bin, and key stores such as .ssh and .aws).

Drives: on Windows, C:\ and D:\ are shown if they exist. To change that, add this to your settings file (a drive letter, or a name and folder):

       "explorer": { "drives": ["C:\\", "D:\\"] }

## Apps in the side panel
List the programs you want one click away in your settings file. They appear under **Apps** in the Explorer side panel, on the Explorer page and in Ctrl+K search. `types` is optional: files of those types get an **Open with** button in the Explorer.

       "apps": [
         { "name": "Typora", "path": "D:\\Program Files\\Typora\\Typora.exe", "types": [".md"] },
         { "name": "Acrobat", "path": "D:\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe", "types": [".pdf"] },
         { "name": "Chrome", "path": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "types": [".html", ".htm"] }
       ]

The path must be the program's `.exe` file. Only programs in this list can be started, and the Explorer itself still never runs programs or scripts.

## Light and dark, and the logo
The sun/moon button in the header switches between light and dark; your choice is remembered. Until you choose, the app follows Windows. If `thumbnail.png` (or `transformHub.png`) sits in the app folder, it shows at the top of the left rail. The window and taskbar icon is `thumbnail.ico` if present (or `transformHub.ico`, then the PNG); `Make-Icon.ps1` builds the .ico from the PNG. The logo and icon files are not stored in this repository.

## Microsoft To Do in Tasks (experimental, read-only)
Add `"msTodo": { "enabled": true }` to your settings file (next to `userName`) and restart. The app then reads your To Do tasks from the To Do web page, using the same Microsoft sign-in as the Inbox tab, every 10 minutes. They show in the Tasks page and the side panel (titles only, read-only; tick them off in To Do). It reads the page layout, so a Microsoft change can break it: the Tasks page then says so and offers a diagnostic that contains no task text. Sign in to Microsoft in the Inbox tab first.

## Icons
Rail icons are colour-coded by type. Web tabs show the site's own icon once you have opened the tab once.

## Adding a web tab (for example a dashboard)
Add a section to your settings file: `{ "id": "domo", "label": "DOMO", "icon": "chart", "type": "web", "url": "https://your-dashboard-link" }`. Keep company dashboard links in your settings file only, never in the files you commit. Sign-in happens inside the app; whether your company's single sign-on works there is untested.

## Your folders and name

The app creates its settings file on first run at `%APPDATA%\th-command-centre\config.json`.
The committed default only has an example project. To use your own list, edit that file
(the cog in the left rail opens it). A copy of your settings kept in this folder as
`config.personal.json` (or any `config.*.json` except the default) is ignored by git, so real folder names and links never go to GitHub.

Settings you can change: `userName`, `calendarFeeds`, `projects` (id, name, folder), `explorer` (drives), `apps`, `arcaneUrl`, `dataDir`, `msTodo` and the `sections` list.
Restart the app after editing. Upgrading from 0.1: your old settings are kept as
`config.v1.bak.json` and replaced with the new layout. The old "AI Projects" tab is renamed Explorer automatically; a name you chose yourself is kept.
Favourites you star are remembered per person in `ui-state.json` next to the settings file.

## Where your data lives

Tasks and events: `%APPDATA%\th-command-centre\data\data.json`, on this computer's drive.
Every save keeps the previous good copy as `data.json.bak`, writes through a temporary file
so a crash cannot leave a half-written file, and a damaged file is set aside as
`data.json.corrupt-<time>` instead of being overwritten. To keep it somewhere else (for
example a OneDrive folder for backup), set `dataDir` in the settings file.

## Show your Outlook calendar (read-only)

In Outlook on the web: Settings, Calendar, Shared calendars, Publish a calendar. Choose the
calendar and permission, click Publish, and copy the **ICS** link. Then add it to your
settings file (`%APPDATA%\th-command-centre\config.json`, the cog opens it):

       "calendarFeeds": [ { "name": "Outlook", "url": "PASTE_THE_ICS_LINK_HERE" } ],

Restart the app. Outlook events then show in the Calendar tab (teal, with the feed name) and on
Home. They are read-only: change them in Outlook. The app refreshes every 15 minutes and from the
"Refresh now" button, and keeps showing the last good copy if a refresh fails.

The link is a secret: anyone with it can read that calendar. Keep it only in your settings file.
It is never sent to the pages, written to the cache or logged. Only the title, date and time of
each event are kept (no attendees, notes or locations). `config.json` and `config.personal.json` are
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
