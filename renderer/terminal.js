// Page script for the PowerShell tab.
(() => {
  const msg = document.getElementById('msg'), msgt = document.getElementById('msgt'), again = document.getElementById('again');
  const say = (text, canRestart) => { msgt.textContent = text; again.hidden = !canRestart; msg.style.display = text ? 'block' : 'none'; };
  const term = new window.Terminal({
    fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
    fontSize: 14, cursorBlink: true, scrollback: 10000, allowProposedApi: false,
    theme: { background: '#14171c', foreground: '#e6e9ef', cursor: '#7aa2f7', selectionBackground: '#3b4a6b' },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('t'));
  const refit = () => { try { fit.fit(); window.term.resize(term.cols, term.rows); } catch { /* not visible yet */ } };

  // Copy and paste. Ctrl+C copies when text is selected (otherwise it interrupts, as normal). Ctrl+V, Ctrl+Shift+V and Shift+Insert paste;
  // Ctrl+Shift+C and Ctrl+Insert copy. Right-click copies a selection, or pastes when nothing is selected. Each goes through one path only,
  // so nothing is pasted twice, and a failure shows a short message instead of doing nothing.
  let flashTimer = null;
  const flash = (text) => { say(text, false); clearTimeout(flashTimer); flashTimer = setTimeout(() => say(''), 2500); };
  const copySel = () => {
    if (!term.hasSelection()) return false;
    try { window.term.clipWrite(term.getSelection()); term.clearSelection(); } catch (err) { flash('Copy failed: ' + (err && err.message || err)); }
    return true;
  };
  const pasteClip = async () => {
    try {
      const t = await window.term.clipRead();
      if (t) term.paste(t); else flash('The clipboard has no text to paste.');
    } catch (err) { flash('Paste failed: ' + (err && err.message || err)); }
  };
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey && k === 'c' && (ev.shiftKey || term.hasSelection())) || (ev.ctrlKey && !ev.shiftKey && k === 'insert')) { ev.preventDefault(); copySel(); return false; }
    if ((ev.ctrlKey && k === 'v') || (ev.shiftKey && !ev.ctrlKey && k === 'insert')) { ev.preventDefault(); pasteClip(); return false; }
    return true;
  });
  document.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (!copySel()) pasteClip();
  });

  term.onData((d) => window.term.input(d));
  window.term.onData((d) => term.write(d));
  let running = false;
  window.term.onRestart(() => { term.reset(); start(); });
  window.term.onExit((code) => { running = false; say('PowerShell closed (code ' + code + ').', true); });

  async function start() {
    say('');
    try { fit.fit(); } catch { /* sized later */ }
    const r = await window.term.start(term.cols, term.rows);
    if (!r || !r.ok) { say((r && r.error) || 'Could not start PowerShell.', true); return; }
    running = true;
    term.focus();
  }
  again.addEventListener('click', () => { term.reset(); start(); });
  new ResizeObserver(() => { if (running || term.cols) refit(); }).observe(document.getElementById('wrap'));
  window.addEventListener('focus', () => term.focus());
  start();
})();
