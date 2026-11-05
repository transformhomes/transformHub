// ORACLE tab: a thin read/write layer over ORACLE's own files. This module never
// re-implements anything ORACLE's Python already does, and it never opens
// CEO_Decisions.xlsx itself (Dale, 05/11/2026) -- only ORACLE's own code is allowed to
// write that file, so a second writer can never corrupt it or race with a scheduled run.
//
// What this module reads/writes under the ORACLE folder:
//   06_Agent_Runtime/state/status.json        -- read only. Written by a live ORACLE run
//                                                 (th_agents/report.py: status_json).
//   06_Agent_Runtime/state/live/app_answers.json -- appended to by decide(). Read, applied
//                                                 to CEO_Decisions.xlsx and deleted by
//                                                 ORACLE's own next live run
//                                                 (th_agents/run.py: apply_app_answers).
//   06_Agent_Runtime/run_agents.ps1            -- spawned by runNow(), the same command
//                                                 Dale would type himself (-Mode live -Live).
//   06_Agent_Runtime/runs/<run folder>.lock     -- ORACLE's own single-run lock (see
//                                                 th_agents/run.py); runNow() only checks
//                                                 it to grey out the button, it is never
//                                                 created or removed from here.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function statusPath(oracleRoot) {
  return path.join(oracleRoot, '06_Agent_Runtime', 'state', 'status.json');
}
function appAnswersPath(oracleRoot) {
  return path.join(oracleRoot, '06_Agent_Runtime', 'state', 'live', 'app_answers.json');
}
function runsDir(oracleRoot) {
  return path.join(oracleRoot, '06_Agent_Runtime', 'runs');
}

// Reads status.json. Never throws: a missing or unreadable file just means "no run yet
// / can't tell", which the renderer shows as an empty state rather than an error.
function readStatus(oracleRoot) {
  try {
    const text = fs.readFileSync(statusPath(oracleRoot), 'utf8');
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') return { ok: false, reason: 'unreadable' };
    return { ok: true, data };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'none' };
    return { ok: false, reason: 'unreadable' };
  }
}

// Appends one answer to the queue ORACLE's next live run will apply, merging with
// whatever is already queued (so two clicks before the next run both survive). Written
// via a temp file + rename, same approach as ORACLE's own status.json and Transform
// Workstation's data.json, so a half-written file is never left behind.
function queueAnswer(oracleRoot, { key, decision, from, comment }) {
  if (typeof key !== 'string' || !key || !/^[A-Za-z0-9]{1,20}$/.test(key)) return { ok: false, error: 'Bad key.' };
  const dec = String(decision || '').toLowerCase();
  if (!['approve', 'reject', 'hold'].includes(dec)) return { ok: false, error: 'Decision must be approve, reject or hold.' };
  const file = appAnswersPath(oracleRoot);
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* none yet, or unreadable: start fresh */ }
  if (typeof existing !== 'object' || Array.isArray(existing)) existing = {};
  existing[key] = {
    decision: dec,
    from: String(from || 'Dale Psaila (Transform Workstation)').slice(0, 80),
    received: new Date().toISOString().slice(0, 16).replace('T', ' '),
    ...(comment ? { comment: String(comment).slice(0, 500) } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, error: 'Could not save: ' + (err && err.message) };
  }
  return { ok: true };
}

// True while ORACLE's own run.py single-run lock exists (see th_agents/run.py
// _single_run) -- used only to greyed-out the Run now button; ORACLE itself still
// refuses a second run even if this check is ever wrong or stale.
function isRunning(oracleRoot) {
  try {
    const dir = runsDir(oracleRoot);
    return fs.readdirSync(dir).some((n) => n.endsWith('.lock'));
  } catch { return false; }
}

// A run has no finer unit of real progress than "which of these stages is running now"
// (Dale, 05/11/2026) -- ORACLE's own th_agents/log.py prints a line like
// "ORACLE_PROGRESS 2/5 A3" each time a new stage starts. This list must be kept in step
// by hand with th_agents/log.py's PROGRESS_STAGES; a line that doesn't match the
// pattern, or names a stage not in this list, is ignored rather than breaking anything.
const PROGRESS_STAGES = ['A1', 'A2', 'A3', 'A4', 'Reports'];
const PROGRESS_RE = /ORACLE_PROGRESS (\d+)\/(\d+) (\S+)/;
function parseProgress(line) {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]) || PROGRESS_STAGES.length;
  const stage = m[3];
  if (!PROGRESS_STAGES.includes(stage)) return null;
  return { stage, index, total, percent: Math.round((index / total) * 100) };
}

// Spawns run_agents.ps1 -Mode live -Live, exactly the command Dale would type himself
// (see README "Steps before go-live"). Returns immediately; onLog(line) is called for
// each line of output as it arrives, onProgress({stage, index, total, percent}) whenever
// a stage-progress line is seen, onDone(code) when the process exits. Never resolves by
// waiting for the run to finish -- a live run can take several minutes.
function runNow(oracleRoot, { onLog, onProgress, onDone }) {
  const runtimeDir = path.join(oracleRoot, '06_Agent_Runtime');
  const script = path.join(runtimeDir, 'run_agents.ps1');
  if (!fs.existsSync(script)) { if (onDone) onDone(-1, 'run_agents.ps1 not found at ' + script); return { ok: false }; }
  let child;
  try {
    child = spawn('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', 'live', '-Live'],
      { cwd: runtimeDir, windowsHide: true });
  } catch (err) {
    if (onDone) onDone(-1, 'Could not start pwsh: ' + (err && err.message));
    return { ok: false };
  }
  const pipe = (buf) => {
    const text = buf.toString('utf8');
    text.split(/\r?\n/).filter(Boolean).forEach((line) => {
      if (onLog) onLog(line);
      const p = parseProgress(line);
      if (p && onProgress) onProgress(p);
    });
  };
  child.stdout.on('data', pipe);
  child.stderr.on('data', pipe);
  child.on('error', (err) => { if (onDone) onDone(-1, err && err.message); });
  child.on('close', (code) => { if (onDone) onDone(code, null); });
  return { ok: true, pid: child.pid };
}

module.exports = { readStatus, queueAnswer, isRunning, runNow, statusPath, appAnswersPath };
