// "Pick up where you left off": files and folders you opened lately, from the same Recent list that Windows keeps
// for File Explorer, Word, Excel and the rest. Only names, places and times are read. Nothing is changed or sent anywhere.
const { execFile } = require('child_process');

const MAX_ITEMS = 40;
const NOISE = /\\(AppData|node_modules|\$Recycle\.Bin|\.git|Temp|Windows)(\\|$)/i;
const RISKY_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.msp', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.mjs', '.wsf', '.wsh', '.hta', '.lnk', '.url', '.reg', '.jar', '.cpl', '.dll', '.sh', '.appx', '.msix', '.application', '.pif']);

// Reads the shortcuts in the Windows Recent folder (newest first) and prints: target, time opened (ms), D or F.
const RECENT_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "$dir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Recent'",
  "$sh = New-Object -ComObject WScript.Shell",
  "Get-ChildItem -LiteralPath $dir -Filter *.lnk | Sort-Object LastWriteTime -Descending | Select-Object -First 80 | ForEach-Object {",
  "  $t = $sh.CreateShortcut($_.FullName).TargetPath",
  "  if ($t -and $t -notlike '\\\\*' -and (Test-Path -LiteralPath $t)) {",
  "    $kind = if (Test-Path -LiteralPath $t -PathType Container) { 'D' } else { 'F' }",
  "    $ms = [DateTimeOffset]::new($_.LastWriteTimeUtc).ToUnixTimeMilliseconds()",
  "    [Console]::Out.WriteLine($t + \"`t\" + $ms + \"`t\" + $kind)",
  "  }",
  "}",
].join('\n');

function defaultRun() {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(RECENT_SCRIPT, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 12000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
  });
}

function parseRecent(text) {
  const rows = [];
  for (const line of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const [p, ms, kind] = line.split('\t');
    if (!p || !/^[A-Za-z]:\\/.test(p) || NOISE.test(p)) continue;
    const isFolder = kind === 'D';
    const dot = p.lastIndexOf('.');
    const ext = !isFolder && dot > p.lastIndexOf('\\') ? p.slice(dot).toLowerCase() : '';
    if (RISKY_EXT.has(ext)) continue;
    const when = Number(ms);
    if (!Number.isFinite(when) || when <= 0) continue;
    const i = p.lastIndexOf('\\');
    rows.push({ path: p, name: p.slice(i + 1) || p, folder: i > 2 ? p.slice(0, i) : p.slice(0, 3), when, ext, isFolder });
  }
  rows.sort((a, b) => b.when - a.when); // newest first, so a repeated item keeps its latest time
  const seen = new Set();
  return rows.filter((r) => { const k = r.path.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_ITEMS);
}

// run() -> Promise<string> (replaceable in tests). The list is kept for a short while so Home does not ask Windows every few seconds.
function createRecent({ run = defaultRun, platform = process.platform, now = Date.now, ttl = 20000 } = {}) {
  let items = [];
  let at = 0;
  let pending = null;

  async function list(force) {
    if (platform !== 'win32' && run === defaultRun) return { ok: true, unsupported: true, items: [] };
    if (!force && at && now() - at < ttl) return { ok: true, items: publicItems() };
    if (!pending) {
      pending = run().then((t) => { items = parseRecent(t); at = now(); return true; }).catch(() => false).finally(() => { pending = null; });
    }
    const ok = await pending;
    return ok ? { ok: true, items: publicItems() } : { ok: false, items: publicItems(), error: 'Could not read your recent files just now.' };
  }
  const publicItems = () => items.map((r, id) => ({ id, name: r.name, folder: r.folder, when: r.when, ext: r.ext, isFolder: r.isFolder }));
  // Only something in the latest list can be opened
  const pick = (id) => (Number.isInteger(id) && id >= 0 && id < items.length ? items[id] : null);
  return { list, pick, isRisky: (p) => RISKY_EXT.has(((/\.[^.\\]+$/.exec(p) || [''])[0]).toLowerCase()) };
}

module.exports = { createRecent, parseRecent, RECENT_SCRIPT, MAX_ITEMS };
