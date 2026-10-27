// Searching file names on this PC through the Windows search index (the same index File Explorer's search box uses).
// Only file and folder names are searched, only in places Windows already indexes, and nothing is changed.
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

// run(query) -> Promise<string> (replaceable in tests)
function createFileSearch({ run = defaultRun, platform = process.platform } = {}) {
  let latest = [];
  async function search(raw) {
    const q = cleanQuery(raw);
    if (q.length < 2) return { ok: true, results: [] };
    if (platform !== 'win32' && run === defaultRun) return { ok: true, results: [] }; // only Windows has the search index
    try {
      latest = parseRows(await run(q));
      return { ok: true, results: latest.map((r, id) => ({ id, name: r.name, folder: r.folder, isFolder: r.isFolder })) };
    } catch {
      latest = [];
      return { ok: false, error: 'Windows search is not available right now. Check that the Windows Search service is running.' };
    }
  }
  // Only a path from the latest results can be opened
  const pick = (id) => (Number.isInteger(id) && id >= 0 && id < latest.length ? latest[id] : null);
  return { search, pick };
}

module.exports = { createFileSearch, cleanQuery, parseRows, SEARCH_SCRIPT, MAX_RESULTS };
