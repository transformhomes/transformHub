// Searching file names on this PC. Uses Everything (voidtools) when it is installed (see everything.js), otherwise the
// Windows search index (the same index File Explorer's search box uses).
// Only file and folder names are searched, and nothing is changed.
const { execFile } = require('child_process');

const MAX_RESULTS = 20;
const NOISE = /\\(AppData|node_modules|\$Recycle\.Bin|\.git|\.cache)(\\|$)/i;

// The search words are the only thing typed by a person that reaches the query, so keep letters, numbers, spaces, dot, dash and underscore.
function cleanQuery(q) {
  return String(q == null ? '' : q).normalize('NFC').replace(/[^\p{L}\p{N} ._-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// The words arrive in the TH_SEARCH environment variable, never inside the command text.
const SEARCH_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "$words = ($env:TH_SEARCH -split ' ') | Where-Object { $_ }",
  "if (-not $words) { exit 0 }",
  "$like = ($words | ForEach-Object { \"System.FileName LIKE '%\" + $_.Replace(\"'\", \"''\") + \"%'\" }) -join ' AND '",
  "$sql = \"SELECT TOP 60 System.ItemPathDisplay, System.ItemType FROM SYSTEMINDEX WHERE SCOPE='file:' AND \" + $like + \" ORDER BY System.DateModified DESC\"",
  "$c = New-Object System.Data.OleDb.OleDbConnection \"Provider=Search.CollatorDSO;Extended Properties='Application=Windows';\"",
  "$c.Open()",
  "$cmd = $c.CreateCommand(); $cmd.CommandText = $sql",
  "$r = $cmd.ExecuteReader()",
  "while ($r.Read()) { [Console]::Out.WriteLine([string]$r[0] + \"`t\" + [string]$r[1]) }",
  "$r.Close(); $c.Close()",
].join('; ');

function defaultRun(query) {
  return new Promise((resolve, reject) => {
    // -EncodedCommand (the script as base64 UTF-16) avoids any trouble with quote marks on the command line
    const encoded = Buffer.from(SEARCH_SCRIPT, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, TH_SEARCH: query }, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
  });
}

function parseRows(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const [p, type] = line.split('\t');
    if (!p || !/^[A-Za-z]:\\/.test(p) || NOISE.test(p) || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    const i = p.lastIndexOf('\\');
    out.push({ path: p, name: p.slice(i + 1) || p, folder: i > 2 ? p.slice(0, i) : p.slice(0, 3), isFolder: /^(directory|file folder)$/i.test(String(type || '').trim()) });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

// What to tell the person when Everything cannot answer
function everythingMessage(err) {
  const code = err && err.code;
  if (code === 'NOWINDOW') return 'Everything is not running. It was started in the background: try again in a few seconds.';
  if (code === 'ACCESSDENIED') return 'Windows is blocking the search because Everything runs as administrator. Switch on Everything\'s web server and add fileSearch.everythingHttp to the settings, or run Everything without administrator rights.';
  if (code === 'HTTPAUTH') return 'Everything refused the user name or password in your settings (fileSearch.everythingHttp).';
  if (code === 'HTTPDOWN') return 'Everything\'s web server is not answering. In Everything, switch on Tools > Options > HTTP Server, and check the port number.';
  if (code === 'TIMEOUT' || code === 'NOREPLY') return 'Everything did not answer. Check that it is running and try again.';
  return 'Could not search with Everything just now. See everything-diagnostics.log in the app data folder.';
}

// Everything's rows are "path<TAB>F or D"; the Windows search rows are "path<TAB>type". Both end up as the same list.
function fromEverything(text) {
  return String(text || '').split('\n').map((l) => { const [p, k] = l.split('\t'); return p ? p + '\t' + (k === 'D' ? 'Directory' : 'File') : ''; }).join('\n');
}

// run(query) -> Promise<string> (replaceable in tests); everything = { query(q) -> Promise<string> } when Everything is in use
function createFileSearch({ run = defaultRun, platform = process.platform, everything = null } = {}) {
  let latest = [];
  // scope (optional): an absolute folder; only items inside it, and its subfolders, are returned
  async function search(raw, scope) {
    const q = cleanQuery(raw);
    const base = typeof scope === 'string' && /^[A-Za-z]:\\/.test(scope) && !/["<>|*?]/.test(scope) ? scope.replace(/[\\/]+$/, '') : '';
    if (q.length < 2) return { ok: true, results: [] };
    if (!everything && platform !== 'win32' && run === defaultRun) return { ok: true, results: [] }; // only Windows has the search index
    try {
      // Everything: a quoted folder path with a trailing backslash limits the search to that folder and below
      latest = parseRows(everything ? fromEverything(await everything.query(base ? '"' + base + '\\" ' + q : q)) : await run(q));
      if (base) { const pre = base.toLowerCase() + '\\'; latest = latest.filter((r) => r.path.toLowerCase().startsWith(pre)); }
      return { ok: true, scope: base || undefined, results: latest.map((r, id) => ({ id, name: r.name, folder: r.folder, isFolder: r.isFolder })) };
    } catch (err) {
      latest = [];
      return { ok: false, error: everything ? everythingMessage(err) : 'Windows search is not available right now. Check that the Windows Search service is running.' };
    }
  }
  // Only a path from the latest results can be opened
  const pick = (id) => (Number.isInteger(id) && id >= 0 && id < latest.length ? latest[id] : null);
  return { search, pick };
}

module.exports = { createFileSearch, cleanQuery, parseRows, fromEverything, SEARCH_SCRIPT, MAX_RESULTS };
