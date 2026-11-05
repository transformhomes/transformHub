// Copies a built Dr. MD into this app's drmd folder.
//   1. In the Dr. MD project folder:   bun run build:hub
//   2. In this folder:                 npm run drmd -- "D:\path\to\DrMD"
const fs = require('fs');
const path = require('path');

const src = process.argv[2] ? path.join(path.resolve(process.argv[2]), 'dist', 'client') : '';
const dest = path.join(__dirname, '..', 'drmd');

if (!src || !fs.existsSync(path.join(src, '_shell.html'))) {
  console.error('Could not find a built Dr. MD.\nIn the Dr. MD folder run "bun run build:hub" first, then run:\n  npm run drmd -- "D:\\path\\to\\DrMD"');
  process.exit(1);
}
const next = dest + '.new';
const old = dest + '.old';
fs.rmSync(next, { recursive: true, force: true });
fs.cpSync(src, next, { recursive: true });
fs.rmSync(old, { recursive: true, force: true });
if (fs.existsSync(dest)) fs.renameSync(dest, old);
fs.renameSync(next, dest);
fs.rmSync(old, { recursive: true, force: true });
console.log('Dr. MD installed in ' + dest + '. Restart Transform Workstation to use it.');
