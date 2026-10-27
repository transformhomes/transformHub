// File access and recent-files history for Dr. MD when it runs inside Transform Workstation.
//
// Dr. MD's page never sends a file path. It sends only an opaque id that this module handed out, so the page
// can only reach files the user chose in a native Open or Save dialog (or that are in the recent list).
// Only .md and .markdown files are read or written. Writes are atomic and refuse to overwrite a file that
// changed on disk since it was opened. Before the first overwrite of a file in a session, the old copy is
// kept in the app's own backup folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_RECENTS = 15;
const MAX_BACKUPS = 30;
const MD_RE = /\.(md|markdown)$/i;

const fail = (error, extra) => ({ ok: false, error, ...(extra || {}) });

function createDrmd({ stateFile, backupDir, showOpen, showSave }) {
  let recents = [];
  const known = new Map();      // id -> absolute path, for every file opened or saved this session
  const backedUp = new Set();   // ids already backed up this session

  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const r of Array.isArray(raw && raw.recents) ? raw.recents : []) {
      if (r && typeof r.id === 'string' && typeof r.path === 'string' && MD_RE.test(r.path) && path.isAbsolute(r.path) && recents.length < MAX_RECENTS) {
        recents.push({ id: r.id, path: r.path, opened: Number(r.opened) || 0 });
        known.set(r.id, r.path);
      }
    }
  } catch { /* first run or unreadable: start with an empty list */ }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ recents }));
      fs.renameSync(tmp, stateFile);
    } catch { /* losing the history is not worth interrupting writing */ }
  }

  function remember(file) {
    const existing = recents.find((r) => r.path.toLowerCase() === file.toLowerCase());
    const id = existing ? existing.id : crypto.randomUUID();
    recents = [{ id, path: file, opened: Date.now() }, ...recents.filter((r) => r.id !== id)].slice(0, MAX_RECENTS);
    known.set(id, file);
    persist();
    return id;
  }

  const publicRecent = (r) => ({ id: r.id, name: path.basename(r.path), dir: path.dirname(r.path), opened: r.opened });

  function readNote(file) {
    if (!MD_RE.test(file)) return fail('Only .md and .markdown files can be opened.');
    let st;
    try { st = fs.statSync(file); } catch { return fail('That file is no longer there. You can remove it from the list.'); }
    if (!st.isFile()) return fail('That is not a file.');
    if (st.size > MAX_BYTES) return fail('That file is over 5 MB.');
    try {
      const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
      return { ok: true, text, mtime: Math.floor(st.mtimeMs) };
    } catch { return fail('That file could not be read. Check it is not locked by another program.'); }
  }

  function opened(file) {
    const r = readNote(file);
    if (!r.ok) return r;
    const id = remember(file);
    return { ok: true, id, name: path.basename(file), dir: path.dirname(file), text: r.text, mtime: r.mtime };
  }

  function writeAtomic(file, text) {
    const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to tidy */ }
      throw err;
    }
  }

  function backupOnce(id, file) {
    if (backedUp.has(id) || !backupDir) return;
    backedUp.add(id);
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(file, path.join(backupDir, stamp + '--' + path.basename(file)));
      const all = fs.readdirSync(backupDir).sort();
      for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) { try { fs.unlinkSync(path.join(backupDir, old)); } catch { /* skip */ } }
    } catch { /* a missing backup should not block saving */ }
  }

  return {
    recents: () => recents.map(publicRecent),

    async open() {
      const file = await showOpen();
      if (!file) return { ok: false, cancelled: true };
      return opened(file);
    },

    openRecent(id) {
      const file = known.get(id);
      if (!file) return fail('That file is not in the list any more.');
      return opened(file);
    },

    reload(id) {
      const file = known.get(id);
      if (!file) return fail('That file is not in the list any more.');
      return opened(file);
    },

    forget(id) {
      recents = recents.filter((r) => r.id !== id);
      persist();
      return recents.map(publicRecent);
    },

    save(id, text, expectedMtime) {
      const file = known.get(id);
      if (!file) return fail('Save As first: that file is not known to Dr. MD.');
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) return fail('That note is over 5 MB, so it was not saved.');
      let st;
      try { st = fs.statSync(file); } catch { return fail('The file is no longer there. Use Save as to keep your work.'); }
      if (Math.floor(st.mtimeMs) !== Math.floor(Number(expectedMtime))) return { ok: false, conflict: true, error: 'This file was changed outside Dr. MD.' };
      try {
        backupOnce(id, file);
        writeAtomic(file, text);
        return { ok: true, mtime: Math.floor(fs.statSync(file).mtimeMs) };
      } catch { return fail('Could not save. Check the file is not open in another program.'); }
    },

    async saveAs(suggestedName, text) {
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) return fail('That note is over 5 MB, so it was not saved.');
      const safe = String(suggestedName || 'Untitled.md').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').slice(0, 120) || 'Untitled.md';
      let file = await showSave(MD_RE.test(safe) ? safe : safe + '.md');
      if (!file) return { ok: false, cancelled: true };
      if (!MD_RE.test(file)) file += '.md';
      try { writeAtomic(file, text); } catch { return fail('Could not save there. Try another folder.'); }
      const id = remember(file);
      return { ok: true, id, name: path.basename(file), dir: path.dirname(file), text, mtime: Math.floor(fs.statSync(file).mtimeMs) };
    },
  };
}

module.exports = { createDrmd, MAX_BYTES };
