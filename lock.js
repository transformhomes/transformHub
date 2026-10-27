// Screen lock: covers the hub with a PIN screen after a quiet spell, when Windows locks, or on request.
// The PIN is never stored as typed: only a salted scrypt hash, in its own file (lock.json) beside the settings.
// This stops someone walking up to an unlocked PC. It is not disk encryption (BitLocker does that).
const crypto = require('crypto');
const fs = require('fs');

const MIN_PIN = 4;
const MAX_PIN = 32;
const MINUTES = [1, 2, 5, 10, 15, 30, 60];
const FREE_TRIES = 4; // wrong guesses allowed before waiting begins

function pinError(pin) {
  if (typeof pin !== 'string') return 'Enter a PIN.';
  if (pin.length < MIN_PIN) return 'The PIN must be at least ' + MIN_PIN + ' characters.';
  if (pin.length > MAX_PIN) return 'The PIN can be at most ' + MAX_PIN + ' characters.';
  return null;
}

function hashPin(pin, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function matches(pin, rec) {
  if (!rec || typeof rec.salt !== 'string' || typeof rec.hash !== 'string') return false;
  try {
    const got = crypto.scryptSync(String(pin), Buffer.from(rec.salt, 'hex'), 32);
    const want = Buffer.from(rec.hash, 'hex');
    return want.length === got.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}

function cleanMinutes(m) {
  const n = Number(m);
  return MINUTES.includes(n) ? n : 10;
}

// file: path of lock.json; now: clock (replaceable in tests)
function createLock({ file, now = Date.now }) {
  let fails = 0;
  let blockedUntil = 0;

  function read() {
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!r || typeof r.salt !== 'string' || typeof r.hash !== 'string') return null;
      return { enabled: r.enabled !== false, minutes: cleanMinutes(r.minutes), salt: r.salt, hash: r.hash };
    } catch { return null; }
  }
  function write(rec) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const status = () => { const r = read(); return { hasPin: !!r, enabled: !!(r && r.enabled), minutes: r ? r.minutes : 10 }; };
  const active = () => { const r = read(); return !!(r && r.enabled); };
  const minutes = () => { const r = read(); return r ? r.minutes : 10; };
  const waitSeconds = () => Math.max(0, Math.ceil((blockedUntil - now()) / 1000));

  // Check a PIN. Repeated wrong guesses make the screen wait: 15 s, 30 s, 60 s ... up to 5 minutes.
  function verify(pin) {
    const wait = waitSeconds();
    if (wait > 0) return { ok: false, wait };
    const r = read();
    if (!r) return { ok: true, wait: 0 }; // no PIN on file: nothing to guard
    if (typeof pin === 'string' && matches(pin, r)) { fails = 0; blockedUntil = 0; return { ok: true, wait: 0 }; }
    fails += 1;
    if (fails > FREE_TRIES) blockedUntil = now() + Math.min(300, 15 * 2 ** (fails - FREE_TRIES - 1)) * 1000;
    return { ok: false, wait: waitSeconds(), triesLeft: Math.max(0, FREE_TRIES - fails + 1) };
  }

  // Settings changes. Changing or switching off an existing PIN needs the current PIN.
  function save({ enabled, minutes: mins, newPin, currentPin }) {
    const r = read();
    if (r && !matches(String(currentPin == null ? '' : currentPin), r)) {
      if (!(typeof currentPin === 'string' && currentPin)) return { ok: false, error: 'Enter your current PIN to change these settings.' };
      return { ok: false, error: 'That is not your current PIN.' };
    }
    let rec;
    if (newPin) {
      const err = pinError(newPin);
      if (err) return { ok: false, error: err };
      rec = { ...hashPin(newPin) };
    } else if (r) {
      rec = { salt: r.salt, hash: r.hash };
    } else {
      return { ok: false, error: 'Choose a PIN first.' };
    }
    rec.enabled = enabled !== false;
    rec.minutes = cleanMinutes(mins == null && r ? r.minutes : mins);
    try { write(rec); } catch { return { ok: false, error: 'Could not save the lock settings.' }; }
    return { ok: true, ...status() };
  }

  function remove(currentPin) {
    const r = read();
    if (!r) return { ok: true };
    if (!matches(String(currentPin || ''), r)) return { ok: false, error: 'That is not your current PIN.' };
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return { ok: true };
  }

  return { status, active, minutes, verify, save, remove, waitSeconds };
}

module.exports = { createLock, pinError, MIN_PIN, MAX_PIN, MINUTES };
