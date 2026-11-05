// Shared helpers for the built-in pages. All user text is inserted with textContent
// (never innerHTML), so task and event titles cannot inject markup.

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'value') e.value = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => ymd(new Date());
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const fmtDate = (s, opts) => parseYmd(s).toLocaleDateString('en-AU', opts || { weekday: 'short', day: 'numeric', month: 'short' });
const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

function fmtTime(t) {
  if (!t) return '';
  const [hh, mm] = t.split(':').map(Number);
  const suffix = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return h12 + (mm ? ':' + pad2(mm) : '') + suffix;
}

function eventTimeLabel(ev) {
  if (ev.allDay) return 'All day';
  return fmtTime(ev.start) + (ev.end ? ' – ' + fmtTime(ev.end) : '');
}

// Your own events plus read-only ones from calendar feeds (for example Outlook).
const allEvents = () => [...App.data.events, ...App.feeds.events];

function sortEvents(list) {
  return list.slice().sort((a, b) =>
    a.date.localeCompare(b.date) || (b.allDay - a.allDay) || (a.start || '').localeCompare(b.start || '') || a.title.localeCompare(b.title));
}

// ---- shared app state ----------------------------------------------------
const App = {
  data: { tasks: [], events: [], focusProject: null },
  projects: [],
  feeds: { events: [], status: [], configured: 0 },
  todo: { enabled: false, status: 'idle', tasks: [], updated: null, diag: [] },
  async init(render) {
    this.projects = await window.cc.getProjects();
    this.data = (await window.cc.getData()) || this.data;
    this.feeds = (await window.cc.getFeeds()) || this.feeds;
    this.todo = (window.cc.getTodo && (await window.cc.getTodo())) || this.todo;
    render();
    window.cc.onChanged((d) => { this.data = d; render(); });
    window.cc.onFeedsChanged((f) => { this.feeds = f; render(); });
    if (window.cc.onTodo) window.cc.onTodo((t) => { this.todo = { enabled: true, ...t }; render(); });
  },
  async save(patch) {
    const next = await window.cc.setData(patch);
    if (next) this.data = next;
    return next;
  },
};

// ---- toast ----------------------------------------------------------------
let toastTimer = null;
function toast(message, actionLabel, action) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  clearTimeout(toastTimer);
  const t = h('div', { class: 'toast', role: 'status' }, h('span', { text: message }));
  if (actionLabel) t.append(h('button', { text: actionLabel, onclick: () => { t.remove(); action(); } }));
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), 7000);
}

// ---- tasks ------------------------------------------------------------------
function addTask(title, project, due) {
  const clean = String(title || '').trim();
  if (!clean) return Promise.resolve(null);
  const task = { id: uid(), title: clean, done: false, project: project || null, due: due || '', created: Date.now(), doneAt: null };
  return App.save({ tasks: [...App.data.tasks, task] });
}

function toggleTask(id) {
  return App.save({
    tasks: App.data.tasks.map((t) => (t.id === id ? { ...t, done: !t.done, doneAt: t.done ? null : Date.now() } : t)),
  });
}

function deleteTask(id) {
  const removed = App.data.tasks.find((t) => t.id === id);
  if (!removed) return Promise.resolve(null);
  return App.save({ tasks: App.data.tasks.filter((t) => t.id !== id) }).then(() => {
    toast('Task deleted', 'Undo', () => App.save({ tasks: [...App.data.tasks, removed] }));
  });
}

function taskRow(t) {
  const proj = App.projects.find((p) => p.id === t.project);
  const overdue = !t.done && t.due && t.due < todayStr();
  return h('div', { class: 'task' + (t.done ? ' done' : '') },
    h('input', { type: 'checkbox', checked: t.done, 'aria-label': 'Mark "' + t.title + '" done', onchange: () => toggleTask(t.id) }),
    h('span', { class: 'title', text: t.title }),
    proj && h('span', { class: 'tag', text: proj.name }),
    t.due && h('span', { class: 'due' + (overdue ? ' overdue' : ''), text: (overdue ? 'Overdue · ' : '') + fmtDate(t.due) }),
    h('button', { class: 'icon', title: 'Delete', 'aria-label': 'Delete "' + t.title + '"', onclick: () => deleteTask(t.id) }, '×'));
}

function sortTasks(list) {
  return list.slice().sort((a, b) =>
    (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99') || a.created - b.created);
}

function projectSelect(selected, withAll) {
  const sel = h('select', { 'aria-label': 'Project' },
    h('option', { value: '', text: withAll ? 'All projects' : 'No project' }),
    App.projects.map((p) => h('option', { value: p.id, text: p.name })));
  sel.value = selected || '';
  return sel;
}
