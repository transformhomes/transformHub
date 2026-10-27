# TH Command Centre (Transform Workstation)

One window for your inbox, files, tasks, calendar, Teams, OneDrive and Claude.
Windows desktop app built with Electron. See package.json for the version.

| Icon | What it is |
|---|---|
| Home | Needs attention (overdue and due today), today's events, next 7 days, focus project |
| Inbox | Outlook on the web |
| Explorer | A read-only folder browser: favourites and your drives, with the folder tree in the side panel |
| Dr. MD | A live Markdown editor with a Home screen and your recent files (see below) |
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

## Right-click in the Explorer
Right-click a file or folder in the Explorer page (or the empty space in a folder) for: Open, Open in File Explorer (or Show in File Explorer for a file), Open with (for apps set up in your settings), **Open in PowerShell here** (in that folder, or the file's folder), **Copy path**, Add to or Remove from favourites (folders), and **Properties** (type, full path, size or item count, created, modified, last opened, read-only). Nothing here deletes, renames or moves files. Like everything in the Explorer, it only works inside your favourites and drives, and the PowerShell window is started with fixed settings so a file name can never be run as a command.

## Apps in the side panel
List the programs you want one click away in your settings file. They appear under **Apps** in the Explorer side panel, on the Explorer page and in Ctrl+K search. `types` is optional: files of those types get an **Open with** button in the Explorer.

       "apps": [
         { "name": "Typora", "path": "D:\\Program Files\\Typora\\Typora.exe", "types": [".md"] },
         { "name": "Acrobat", "path": "D:\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe", "types": [".pdf"] },
         { "name": "Chrome", "path": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "types": [".html", ".htm"] }
       ]

The path must be the program's `.exe` file. Only programs in this list can be started, and the Explorer itself still never runs programs or scripts.

The same list fills the **Apps** panel on the right of the Home page, with each program's own icon. Click a tile to open that program in its own window, outside Transform Workstation. **Add app** lets you pick a program's `.exe` file from this computer; **Edit** shows a cross on each tile to remove it. Adding or removing rewrites the `apps` list in your settings file (up to 24 apps), keeping a copy of the old file the first time as `config.before-apps.bak.json`. Removing only takes the app off the list; it never uninstalls anything.

**File Explorer:** add Windows' own File Explorer as an app with `{ "name": "File Explorer", "path": "C:\\Windows\\explorer.exe" }` (or choose `C:\Windows\explorer.exe` with Add app). It opens a normal Explorer window.

**Icons:** tiles use each program's own icon. If Windows gives a plain blank-window icon for a program that has a real one, Transform Workstation tries to read the icon from the file itself. To force a picture, add `"icon": "C:\\path\\to\\picture.png"` (a .png, .ico or .jpg under 1 MB) to that app. A left-rail item can use a program's icon too, with `"iconFile": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"` on its entry in `sections` (a program, or a .png, .ico or .jpg picture).

## Dr. MD (Markdown editor)
Dr. MD is a separate project (a single-pane editor that formats Markdown as you type). Inside Transform Workstation it opens as its own tab, with a **Home** button that lists your recently opened files. Choose a file there, or use New, Open or Save as. It opens and saves `.md` and `.markdown` files only.

How it stays safe: the Dr. MD page never sends a file path. It asks Transform Workstation to show the normal Open and Save dialogs, and can then only read or write the files you chose (and ones in the recent list). Saving never overwrites a file that changed on disk since you opened it; you are asked what to do. Before the first overwrite of a file, the old copy is kept in `%APPDATA%\th-command-centre\drmd-backups` (the newest 30 are kept). The history stores file names and folders, never content, in `drmd-recents.json` next to your settings, for that person only. Drafts of notes that have not been saved to a file are kept in Dr. MD's own storage on that computer.

Setting it up (once, and again whenever Dr. MD changes):

       # in the Dr. MD project folder
       bun run build:hub

       # in this folder
       npm run drmd -- "D:\Projects\IN_PROGRESS_PROJECTS\DrMD"

That copies the built page into the `drmd` folder here (it is not stored in git), so restart the app afterwards. The section is in `config.default.json`; if your settings file was made earlier, add it yourself:

       { "id": "drmd", "label": "Dr. MD", "icon": "book", "type": "drmd" }

Dr. MD runs from files on this computer and loads nothing from the internet. In its tab, Alt+1 to Alt+9 switch section, like the other tabs that have their own shortcuts.

## Browser tab
A small web browser inside the hub: tabs, an address bar (type a web address or a search), back, forward, reload and stop. Links that want a new window open as a new tab. Shortcuts while it has the focus: Ctrl+T new tab, Ctrl+W close tab, Ctrl+L address bar, Ctrl+Tab next tab, Alt+Left and Alt+Right back and forward, F5 or Ctrl+R reload. Alt+1 to Alt+9 switch section, like the other web tabs.

How it stays separate and safe: it keeps its own sign-ins, cookies and history (the `persist:th-browser` area), apart from Outlook, Teams, Claude and the rest. Pages in it get no connection to the hub, cannot open `file:` addresses, and are refused the camera, microphone, location and notifications (only full screen and copying to the clipboard are allowed). The address bar only opens `http` and `https`; anything else is treated as a search. Searches use Google. Visited addresses (the last 300) are kept in `browser-history.json` next to your settings, for address-bar suggestions. The `...` button clears history, sign-ins and cached files after you confirm. Up to 20 tabs.

The section is in `config.default.json`. If your settings file was made earlier, add it yourself (an optional `"url"` sets the first page, which must be https):

       { "id": "browser", "label": "Browser", "icon": "globe", "type": "browser" }

Not built: Chrome extensions, bookmarks, a history page, find in page, saved passwords, and tabs that remember where they were after a restart. Sign-in pop-ups that depend on a separate window may not complete; use the page's normal sign-in instead.

## Outlook on the Home page
Home shows how many unread emails you have, how many appointments are today and the next one, and a month calendar with dots on days that have events (click a day to see its events). The numbers come from **classic Outlook** running on this computer (Windows only). Transform Workstation only talks to an Outlook that is already open, never starts one, and reads just the unread count in the Inbox and each appointment's title and times (private appointments show as "Private appointment"). It writes and sends nothing. If Outlook is closed, Home says so. It refreshes about every two minutes and when you return to the window.

The new Outlook (the web-based one) cannot be read this way. To turn the feature off, add `"outlookDesktop": false` to your settings file.

## Spell check
Spell check is on in every tab and page (Home, Tasks, Dr. MD, Outlook, Teams, Claude, the Browser and the rest), in **Australian English**. Misspelled words get a red underline; right-click one for suggestions or **Add to dictionary** (words you add are remembered). Right-click in any text box also gives Cut, Copy and Paste. If the Australian dictionary is not available on your computer it falls back to British, then US English. To choose others, add for example `"spellCheckLanguages": ["en-AU", "en-GB"]` to your settings file. The first time a language is used, Windows or Electron may need a moment (and an internet connection) to fetch its dictionary. Some web apps (Outlook, Teams) draw their own right-click menus, and those menus may not show spelling suggestions even though the underline is there.

## Settings page and re-arranging
The **Settings** button (cog, bottom of the left rail) opens a Settings page with plain forms, so nobody needs to edit a text file: your name (for the Home greeting), the spell check language, the tab to open at start-up, Outlook on Home on or off, the **Tabs** (rename, change the icon, change the order with the arrows, show or hide built-in tabs, add or remove website tabs), **Calendar links** (up to 5), and **Project folders** (with a Browse button). Press **Save changes**. Changes to tabs need a restart, and the page has a **Restart now** button. Every save is checked first (web addresses must start with https://, folders need a full path, and so on) and a copy of the old settings file is kept in a `config-backups` folder next to it (the last ten). The **Advanced** section at the bottom lets you edit the whole settings file as text, for things not on the page such as drives, apps and Microsoft To Do. It checks the text and tells you the line of any mistake, and refuses a file that would reset your settings.

**Re-arrange by dragging.** Drag a tab in the left rail up or down to change its order, and drag a tile in the Home **Apps** panel to change the order of your apps. The new order is saved straight away (a copy of the old file is kept the first time as `config.before-reorder.bak.json`). Without a mouse, focus an item and press Alt+Shift+Up/Down (rail) or Alt+Shift+Left/Right (apps). The order of the tabs also decides the Ctrl+1 to Ctrl+9 shortcuts.

## Pick up where you left off (Home)

The bottom of the Home page lists the files and folders you opened lately, newest first, in the style of the Recent list in Microsoft apps. It reads the same Recent list Windows keeps for File Explorer, Word, Excel and PDF viewers, so it only shows names, places and times. Click a row to open it, or "Show in folder" to see where it lives. Filter by Documents, Spreadsheets, PDFs or Folders. Programs and scripts are never listed or run. Turn it off under Settings, Home page.

## Shortcuts for moving around

Alt+Q jumps back to the tab you were on before this one, and pressing it again returns you. It works from every tab, including the website tabs. If a website uses Alt+Q itself, use "Go back to the previous tab" in the Ctrl+K search box instead.

## Search box (Ctrl+K)

The search box also finds files and folders on this PC by name, using the Windows search index (the same one File Explorer uses). It only finds places Windows already indexes, such as Documents and Desktop; add other folders in Windows Settings under Search, then Searching Windows. Press Enter to open a result, or Shift+Enter to show it in its folder. Programs and scripts are never run from here: they are shown in their folder instead.

## Home page background

In Settings, choose a picture (PNG, JPG or WebP, up to 8 MB) to sit behind the Home page, and use the slider to dim it so the writing stays easy to read. A copy is kept inside the app, so the original can be moved or deleted.

## Security and safety

- **Screen lock.** In Settings, choose a PIN. Transform Workstation then covers itself with a PIN screen after the quiet time you pick, when Windows locks or the PC sleeps, and when it starts. Press Ctrl+Shift+L to lock at once. The PIN is stored only as a salted hash in `lock.json` beside your settings. Wrong guesses make the screen wait. If you forget the PIN, close the app, delete `lock.json` and start it again. This keeps people away from your open sign-ins; it does not replace Windows sign-in or BitLocker.
- **Websites stay in their lane.** A website tab only moves within its own site and the Microsoft, Claude and DOMO sign-in sites. Any other link opens in the Browser tab. If a sign-in needs another site, add it to the optional `"allowedHosts": ["example.com"]` list in the settings file. The Bitwarden tab is locked to bitwarden.com and keeps its own storage, apart from every other tab.
- **Untrusted certificates.** The Browser tab will not open a site whose security certificate is wrong, expired or untrusted. It shows a warning page, with no "continue anyway".
- **Stay signed in.** Sign-ins for DOMO last 30 days between restarts. Add other sites with `"keepSignedIn": ["domo.com", "example.com"]` in the settings file (this list replaces the default, so keep domo.com in it).
- **Developer tools** stay shut. For development only, start with the environment variable `TH_DEVTOOLS=1`.
- **Hardening.** `npm run harden` switches off Electron features the hub never uses (running as plain Node.js, the NODE_OPTIONS variable, debugging switches) and turns on encrypted cookies. It runs automatically after `npm install`, and again when you build the installer. Signing in again once is normal after the first run, because older cookies were not encrypted.
- **Settings backups.** The Settings page lists the last ten copies of your settings file, with a Restore button.

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
