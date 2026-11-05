// The PowerShell tab: one real terminal (a pseudo-terminal, so colours, tab completion and programs such as git or claude work).
// Only the terminal page itself may talk to it. It needs the node-pty package (npm install adds it).
const fs = require('fs');
const os = require('os');
const path = require('path');

function findShell() {
  // PowerShell 7 (pwsh) first, then the Windows PowerShell that ships with Windows.
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [path.join(pf, 'PowerShell', '7', 'pwsh.exe'), path.join(pf, 'PowerShell', '7-preview', 'pwsh.exe')];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ } }
  return process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
}

function createTerminal({ ipcMain, clipboard, isTerminalSender, getStartDir, loadPty }) {
  const sessions = new Map(); // webContents id -> { pty, wc }
  const pty = () => (loadPty ? loadPty() : require('node-pty'));
  const kill = (id) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { s.pty.kill(); } catch { /* already closed */ }
  };
  const num = (n, lo, hi, d) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d);

  ipcMain.handle('term:start', (e, cols, rows) => {
    if (!isTerminalSender(e)) return { ok: false, error: 'Not allowed' };
    const wc = e.sender;
    kill(wc.id);
    let lib;
    try { lib = pty(); } catch (err) { return { ok: false, error: 'The terminal needs the node-pty package. Close Workstation, run "npm install" in the TransformHub folder, then start it again.' }; }
    let dir = getStartDir();
    try { if (!dir || !fs.statSync(dir).isDirectory()) dir = os.homedir(); } catch { dir = os.homedir(); }
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    delete env.ELECTRON_RUN_AS_NODE;
    const tryShells = [findShell(), process.platform === 'win32' ? 'powershell.exe' : 'bash'];
    let proc = null, used = '', lastErr = '';
    for (const sh of tryShells) {
      try {
        proc = lib.spawn(sh, ['-NoLogo'], { name: 'xterm-256color', cols: num(cols, 10, 500, 100), rows: num(rows, 2, 200, 30), cwd: dir, env });
        used = sh;
        break;
      } catch (err) { lastErr = err.message; }
    }
    if (!proc) return { ok: false, error: 'Could not start PowerShell: ' + lastErr };
    sessions.set(wc.id, { pty: proc, wc });
    proc.onData((d) => { if (!wc.isDestroyed()) wc.send('term:data', d); });
    proc.onExit(({ exitCode }) => {
      const s = sessions.get(wc.id);
      if (s && s.pty === proc) sessions.delete(wc.id);
      if (!wc.isDestroyed()) wc.send('term:exit', exitCode);
    });
    wc.once('destroyed', () => kill(wc.id));
    return { ok: true, shell: path.basename(used), dir };
  });
  ipcMain.on('term:input', (e, data) => {
    if (!isTerminalSender(e) || typeof data !== 'string' || data.length > 1e6) return;
    const s = sessions.get(e.sender.id);
    if (s) { try { s.pty.write(data); } catch { /* closed */ } }
  });
  ipcMain.on('term:resize', (e, cols, rows) => {
    if (!isTerminalSender(e)) return;
    const s = sessions.get(e.sender.id);
    if (s) { try { s.pty.resize(num(cols, 10, 500, 100), num(rows, 2, 200, 30)); } catch { /* closed */ } }
  });
  ipcMain.handle('term:clip-read', (e) => (isTerminalSender(e) ? clipboard.readText() : ''));
  ipcMain.on('term:clip-write', (e, text) => { if (isTerminalSender(e) && typeof text === 'string') clipboard.writeText(text.slice(0, 1e6)); });

  return { killAll: () => { for (const id of [...sessions.keys()]) kill(id); }, count: () => sessions.size };
}

module.exports = { createTerminal, findShell };
