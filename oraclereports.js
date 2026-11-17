// ORACLE report finder for the Home page (read-only).
// Lists the PDF reports ORACLE's own runs save under 04_Agent_Drafts_for_Review. Nothing here writes,
// moves or deletes anything in the ORACLE folder.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const KINDS = [
  { key: 'daily', label: 'Daily report', folder: '2 Overall Report' },
  { key: 'variations', label: 'Variations', folder: '3 Variations Report' },
  { key: 'diaries', label: 'Site diaries', folder: '1 Daily Log Report' },
];
const MAX_FILES = 20;

// "ORACLE Daily Report 2026-11-12_152328.pdf" -> { date: '2026-11-12', time: '15:23' }
function stamp(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:_(\d{2})(\d{2})(\d{2}))?/.exec(name);
  if (!m) return null;
  return { date: m[1] + '-' + m[2] + '-' + m[3], time: m[4] ? m[4] + ':' + m[5] : '', key: m[1] + m[2] + m[3] + (m[4] ? m[4] + m[5] + m[6] : '000000') };
}

function listKind(root, kind, withPath) {
  const dir = path.join(root, '04_Agent_Drafts_for_Review', kind.folder);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && /\.pdf$/i.test(d.name)).map((d) => d.name); } catch { return []; }
  const files = names.map((name) => {
    const st = stamp(name);
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, name)).mtimeMs; } catch { /* leave 0 */ }
    const full = path.join(dir, name);
    return { name, date: st ? st.date : '', time: st ? st.time : '', sort: st ? st.key : '0', mtime, url: pathToFileURL(full).href, ...(withPath ? { path: full } : {}) };
  });
  files.sort((a, b) => (b.sort.localeCompare(a.sort)) || (b.mtime - a.mtime));
  return files.slice(0, MAX_FILES);
}

function list(root) {
  const kinds = KINDS.map((k) => ({ key: k.key, label: k.label, files: listKind(root, k, false).map(({ sort, ...f }) => f) }));
  return { ok: kinds.some((k) => k.files.length > 0), kinds };
}

// Only a file that is in the current listing can be opened.
function find(root, kindKey, name) {
  const kind = KINDS.find((k) => k.key === kindKey);
  if (!kind || typeof name !== 'string') return null;
  return listKind(root, kind, true).find((f) => f.name === name) || null;
}

module.exports = { list, find, KINDS };
