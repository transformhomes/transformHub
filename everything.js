// Searching file names on this PC with "Everything" (voidtools), instead of the Windows search index.
//
// Everything keeps its own instant index of every file name. It does not need the Windows Search service.
// This module talks to the copy of Everything that is already running, through the same message Everything's own
// programs use (its "IPC", switched on by default: allow_ipc=1 in Everything.ini). It only asks for file and folder
// names. It never changes, opens or deletes anything, and nothing is sent over the network.
//
// A small PowerShell helper is started once and kept running, so each search is fast (the helper builds its tiny
// message window only the first time). If Everything is not running, it is started in the background first.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_FROM_EVERYTHING = 120;
const QUERY_TIMEOUT_MS = 12000;
const CANDIDATE_EXES = [
  'D:\\Program Files\\Everything\\Everything.exe',
  'C:\\Program Files\\Everything\\Everything.exe',
  'C:\\Program Files (x86)\\Everything\\Everything.exe',
  'C:\\Program Files\\Everything 1.5a\\Everything64.exe',
  'D:\\Program Files\\Everything 1.5a\\Everything64.exe',
];

function findEverythingExe(custom, exists = fs.existsSync) {
  const list = [];
  if (typeof custom === 'string' && custom.trim()) list.push(custom.trim());
  list.push(...CANDIDATE_EXES);
  return list.find((p) => { try { return exists(p); } catch { return false; } }) || null;
}

// The helper runs in Windows PowerShell 5.1, so the C# below sticks to plain older syntax.
const CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class EvIpc : NativeWindow
{
    [StructLayout(LayoutKind.Sequential)]
    private struct COPYDATASTRUCT { public IntPtr dwData; public int cbData; public IntPtr lpData; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "FindWindowW")]
    private static extern IntPtr FindWindow(string cls, string title);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, ref COPYDATASTRUCT lParam, uint flags, uint timeout, out IntPtr result);

    private const int WM_COPYDATA = 0x004A;
    private const int QUERY2 = 18;
    private const int REPLY = 77;
    private List<string> rows = new List<string>();
    private bool gotReply;

    public EvIpc()
    {
        CreateParams cp = new CreateParams();
        cp.Caption = "TransformWorkstationEverything";
        cp.Parent = new IntPtr(-3);
        CreateHandle(cp);
    }

    private static void WriteInt(byte[] b, int at, uint v)
    {
        b[at] = (byte)(v & 255);
        b[at + 1] = (byte)((v >> 8) & 255);
        b[at + 2] = (byte)((v >> 16) & 255);
        b[at + 3] = (byte)((v >> 24) & 255);
    }

    public string[] Search(string text, string[] classes, int max)
    {
        IntPtr target = IntPtr.Zero;
        foreach (string c in classes)
        {
            target = FindWindow(c, null);
            if (target != IntPtr.Zero) break;
        }
        if (target == IntPtr.Zero) throw new Exception("NOWINDOW");
        rows.Clear();
        gotReply = false;
        byte[] str = System.Text.Encoding.Unicode.GetBytes(text + "\\0");
        byte[] buf = new byte[28 + str.Length];
        WriteInt(buf, 0, (uint)Handle.ToInt64());
        WriteInt(buf, 4, (uint)REPLY);
        WriteInt(buf, 8, 0);
        WriteInt(buf, 12, 0);
        WriteInt(buf, 16, (uint)max);
        WriteInt(buf, 20, 4);
        WriteInt(buf, 24, 14);
        Buffer.BlockCopy(str, 0, buf, 28, str.Length);
        IntPtr mem = Marshal.AllocHGlobal(buf.Length);
        try
        {
            Marshal.Copy(buf, 0, mem, buf.Length);
            COPYDATASTRUCT cds = new COPYDATASTRUCT();
            cds.dwData = new IntPtr(QUERY2);
            cds.cbData = buf.Length;
            cds.lpData = mem;
            IntPtr res;
            IntPtr ok = SendMessageTimeout(target, WM_COPYDATA, Handle, ref cds, 2, 6000, out res);
            if (ok == IntPtr.Zero) throw new Exception("TIMEOUT");
        }
        finally
        {
            Marshal.FreeHGlobal(mem);
        }
        if (!gotReply) throw new Exception("NOREPLY");
        return rows.ToArray();
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_COPYDATA && m.LParam != IntPtr.Zero)
        {
            COPYDATASTRUCT cds = (COPYDATASTRUCT)Marshal.PtrToStructure(m.LParam, typeof(COPYDATASTRUCT));
            if (cds.dwData.ToInt64() == REPLY)
            {
                ParseList(cds.lpData, cds.cbData);
                m.Result = new IntPtr(1);
                return;
            }
        }
        base.WndProc(ref m);
    }

    private void ParseList(IntPtr p, int size)
    {
        gotReply = true;
        if (size < 20) return;
        int numItems = Marshal.ReadInt32(p, 4);
        for (int i = 0; i < numItems; i++)
        {
            int at = 20 + i * 8;
            if (at + 8 > size) break;
            int itemFlags = Marshal.ReadInt32(p, at);
            int dataOff = Marshal.ReadInt32(p, at + 4);
            if (dataOff <= 0 || dataOff + 4 > size) continue;
            int len = Marshal.ReadInt32(p, dataOff);
            if (len <= 0 || len > 32000 || dataOff + 4 + len * 2 > size) continue;
            string full = Marshal.PtrToStringUni(new IntPtr(p.ToInt64() + dataOff + 4), len);
            rows.Add(full + "\\t" + (((itemFlags & 1) != 0) ? "D" : "F"));
        }
    }
}
`;

// Reads "id<TAB>search words" lines from stdin. Answers with "id<TAB>R<TAB>path<TAB>F or D" per result, then "id<TAB>END".
// A problem is answered with "id<TAB>ERR<TAB>code". A start-up problem is "FATAL<TAB>message".
const HELPER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false",
  "try {",
  "  Add-Type -ReferencedAssemblies 'System.Windows.Forms' -TypeDefinition @'",
  CSHARP,
  "'@",
  "  $ev = New-Object EvIpc",
  "} catch {",
  "  [Console]::Out.WriteLine(\"FATAL`t\" + ($_.Exception.Message -replace '[\\r\\n\\t]+', ' '))",
  "  exit 1",
  "}",
  "$classes = [string[]]($env:TH_EV_CLASSES -split ',' | Where-Object { $_ })",
  "[Console]::Out.WriteLine('READY')",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($line -eq $null) { break }",
  "  $parts = $line.Split(\"`t\", 2)",
  "  $id = $parts[0]",
  "  try {",
  "    $rows = $ev.Search($parts[1], $classes, " + MAX_FROM_EVERYTHING + ")",
  "    foreach ($r in $rows) { [Console]::Out.WriteLine($id + \"`tR`t\" + $r) }",
  "    [Console]::Out.WriteLine($id + \"`tEND\")",
  "  } catch {",
  "    $msg = ($_.Exception.Message -replace '[\\r\\n\\t]+', ' ')",
  "    if ($msg -notmatch '^(NOWINDOW|TIMEOUT|NOREPLY)$') { $msg = 'ERROR ' + $msg }",
  "    [Console]::Out.WriteLine($id + \"`tERR`t\" + $msg)",
  "  }",
  "}",
].join('\n');

function defaultLaunch(exePath) {
  // -startup keeps Everything in the background (system tray) without opening its window
  const child = spawn(exePath, ['-startup'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => { /* not started: the next search says so */ });
  child.unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// spawnHelper(classes) -> child process with stdin/stdout/stderr (replaceable in tests)
function createEverything({ exePath, instance, log = () => {}, spawnHelper, launch = defaultLaunch, platform = process.platform, retryMs = 1000, waitForStartMs = 12000 } = {}) {
  const classes = ['EVERYTHING', 'EVERYTHING_(1.5a)'];
  if (typeof instance === 'string' && /^[A-Za-z0-9._ -]{1,40}$/.test(instance)) classes.unshift('EVERYTHING_(' + instance + ')');
  const makeHelper = spawnHelper || (() => {
    const encoded = Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64');
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, env: { ...process.env, TH_EV_CLASSES: classes.join(',') } });
  });

  let helper = null;
  let buf = '';
  let nextId = 1;
  const pending = new Map(); // id -> { rows, resolve, reject, timer }
  let launchedAt = 0;

  function fail(id, code, message) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    const err = new Error(message || code);
    err.code = code;
    p.reject(err);
  }
  function failAll(code, message) { for (const id of [...pending.keys()]) fail(id, code, message); }

  function onLine(line) {
    const parts = line.replace(/^\uFEFF/, '').replace(/\r$/, '').split('\t');
    if (parts[0] === 'READY') return;
    if (parts[0] === 'FATAL') { log('helper could not start: ' + parts.slice(1).join(' ')); failAll('HELPER', parts.slice(1).join(' ')); stop(); return; }
    const p = pending.get(Number(parts[0]));
    if (!p) return;
    if (parts[1] === 'R' && parts[2]) p.rows.push(parts[2] + '\t' + (parts[3] || 'F'));
    else if (parts[1] === 'END') { clearTimeout(p.timer); pending.delete(Number(parts[0])); p.resolve(p.rows.join('\n')); }
    else if (parts[1] === 'ERR') { log('answer: ' + (parts[2] || '')); fail(Number(parts[0]), String(parts[2] || 'ERROR').startsWith('ERROR') ? 'HELPER' : parts[2], parts.slice(2).join(' ')); }
  }

  function start() {
    if (helper) return helper;
    if (platform !== 'win32' && !spawnHelper) throw Object.assign(new Error('Windows only'), { code: 'PLATFORM' });
    const h = makeHelper();
    helper = h;
    buf = '';
    h.stdout.setEncoding && h.stdout.setEncoding('utf8');
    h.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) onLine(line); }
    });
    if (h.stderr) { h.stderr.setEncoding && h.stderr.setEncoding('utf8'); h.stderr.on('data', (d) => log('helper: ' + String(d).trim().slice(0, 400))); }
    const gone = () => { if (helper === h) { helper = null; failAll('HELPER', 'The search helper stopped.'); } };
    h.on('exit', gone);
    h.on('error', (e) => { log('helper error: ' + (e && e.message)); gone(); });
    return h;
  }

  function stop() {
    const h = helper;
    helper = null;
    if (h) { try { h.stdin.end(); } catch { /* closing */ } try { h.kill(); } catch { /* closing */ } }
  }

  function ask(q) {
    return new Promise((resolve, reject) => {
      let h;
      try { h = start(); } catch (e) { reject(e); return; }
      const id = nextId++;
      const timer = setTimeout(() => { fail(id, 'TIMEOUT', 'No answer in time.'); stop(); }, QUERY_TIMEOUT_MS);
      pending.set(id, { rows: [], resolve, reject, timer });
      try { h.stdin.write(id + '\t' + q + '\n'); } catch (e) { fail(id, 'HELPER', e && e.message); }
    });
  }

  // Starts Everything in the background if it is not running, then waits for it to answer.
  async function query(q) {
    try { return await ask(q); } catch (e) {
      if (e.code !== 'NOWINDOW') throw e;
    }
    const now = Date.now();
    if (exePath && now - launchedAt > 60000) { launchedAt = now; log('Everything is not running: starting ' + exePath); try { launch(exePath); } catch { /* reported below */ } }
    const until = Date.now() + waitForStartMs;
    while (Date.now() < until) {
      await sleep(retryMs);
      try { return await ask(q); } catch (e) { if (e.code !== 'NOWINDOW') throw e; }
    }
    const err = new Error('Everything is not running.');
    err.code = 'NOWINDOW';
    throw err;
  }

  return { query, stop, warm: () => { try { start(); } catch { /* reported by the first search */ } }, classes };
}

module.exports = { createEverything, findEverythingExe, HELPER_SCRIPT, CSHARP };
