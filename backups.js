// Settings backups: every Settings-page save keeps a copy of the file it replaced (last ten, in config-backups).
// This lists them and puts one back. Putting one back first keeps a copy of the current file, so a restore can be undone too.
const fs = require('fs');
const path = require('path');

const NAME = /^config-(\d{8})-(\d{6})\.json$/;

function listBackups(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => NAME.test(n)).sort().reverse().slice(0, 10).map((n) => {
    const m = NAME.exec(n);
    const iso = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}Z`;
    let size = 0;
    try { size = fs.statSync(path.join(dir, n)).size; } catch { /* listed anyway */ }
    return { name: n, when: iso, size };
  });
}

// deps: { dir, file (live settings file), check(text) -> error string or null, backupNow() }
function restoreBackup(name, deps) {
  if (typeof name !== 'string' || !NAME.test(name)) return { ok: false, error: 'That backup could not be found.' };
  const src = path.join(deps.dir, name);
  let text;
  try { text = fs.readFileSync(src, 'utf8'); } catch { return { ok: false, error: 'That backup could not be found.' }; }
  const err = deps.check(text);
  if (err) return { ok: false, error: 'That backup cannot be used: ' + err };
  deps.backupNow();
  try {
    const tmp = deps.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(JSON.parse(text), null, 2));
    fs.renameSync(tmp, deps.file);
  } catch { return { ok: false, error: 'Could not put the backup back.' }; }
  return { ok: true, restartNeeded: true };
}

module.exports = { listBackups, restoreBackup };
