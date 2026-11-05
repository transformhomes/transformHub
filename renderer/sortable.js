// Drag-and-drop re-ordering for a list or grid of buttons, plus Alt+Shift+Arrow keys for people who do not use a mouse.
// makeSortable(container, { item: '.tile', idOf: (el) => id, axis: 'x' | 'y', onReorder: (ids) => {} })
function makeSortable(container, opts) {
  if (container._sortable) { container._sortable.o = opts; container._sortable.refresh(); return container._sortable; }
  const state = { o: opts };
  const items = () => [...container.querySelectorAll(state.o.item)].filter((e) => state.o.idOf(e));
  let dragging = null;
  let over = null; // { el, after }

  function clearMarks() { container.querySelectorAll('.drop-before, .drop-after').forEach((e) => e.classList.remove('drop-before', 'drop-after')); }

  function prepare() {
    items().forEach((el) => {
      el.draggable = true;
      el.setAttribute('aria-roledescription', 'sortable item');
    });
  }
  prepare();

  container.addEventListener('dragstart', (e) => {
    const el = e.target.closest && e.target.closest(state.o.item);
    if (!el || !state.o.idOf(el) || !container.contains(el)) return;
    dragging = el;
    el.classList.add('dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', state.o.idOf(el)); } catch { /* ignore */ } }
  });
  container.addEventListener('dragover', (e) => {
    if (!dragging) return;
    const el = e.target.closest && e.target.closest(state.o.item);
    if (!el || el === dragging || !state.o.idOf(el)) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const after = state.o.axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    clearMarks();
    el.classList.add(after ? 'drop-after' : 'drop-before');
    over = { el, after };
  });
  container.addEventListener('dragleave', (e) => { if (e.relatedTarget && container.contains(e.relatedTarget)) return; clearMarks(); over = null; });
  container.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    if (over && over.el !== dragging) {
      const ids = items().filter((x) => x !== dragging).map(state.o.idOf);
      const at = ids.indexOf(state.o.idOf(over.el));
      ids.splice(at + (over.after ? 1 : 0), 0, state.o.idOf(dragging));
      finish();
      state.o.onReorder(ids);
      return;
    }
    finish();
  });
  container.addEventListener('dragend', finish);
  function finish() { if (dragging) dragging.classList.remove('dragging'); dragging = null; over = null; clearMarks(); }

  // keyboard: Alt+Shift+Up/Down (vertical lists) or Left/Right (grids) moves the focused item one place
  container.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    const el = e.target.closest && e.target.closest(state.o.item);
    if (!el || !state.o.idOf(el)) return;
    const back = state.o.axis === 'x' ? e.key === 'ArrowLeft' : e.key === 'ArrowUp';
    const fwd = state.o.axis === 'x' ? e.key === 'ArrowRight' : e.key === 'ArrowDown';
    if (!back && !fwd) return;
    e.preventDefault();
    const ids = items().map(state.o.idOf);
    const i = ids.indexOf(state.o.idOf(el));
    const j = i + (fwd ? 1 : -1);
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    state.o.onReorder(ids, state.o.idOf(el));
  });

  state.refresh = prepare;
  container._sortable = state;
  return state;
}
