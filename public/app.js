/* FlowDesk - frontend (vanilla JS) */
const $ = (s, r = document) => r.querySelector(s);
const S = { token: localStorage.getItem('fd_token'), me: null, ws: null, live: false, board: null, taskId: null, mine: false, unread: 0, notifs: [] };
const STATUS = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
const PRIO = { high: 'High', medium: 'Medium', low: 'Low' };
const ICON = {
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12z"/></svg>'
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GRAD = [['#0B7A75', '#35B8AD'], ['#E8A317', '#F5C95C'], ['#4F6BED', '#8AA0FF'], ['#D64545', '#F08A7A'], ['#5B6B68', '#8A9A96']];
const avatar = (u, size = '') => {
  const g = GRAD[u.id % GRAD.length];
  return `<span class="av ${size}" style="background:linear-gradient(135deg,${g[0]},${g[1]})" aria-hidden="true">${esc(u.name.trim()[0].toUpperCase())}</span>`;
};
const ago = (s) => {
  const t = (Date.now() - new Date(s.replace(' ', 'T') + 'Z')) / 1000;
  if (t < 60) return 'just now';
  if (t < 3600) return Math.floor(t / 60) + ' min ago';
  if (t < 86400) return Math.floor(t / 3600) + ' h ago';
  return Math.floor(t / 86400) + ' d ago';
};
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const fmtDate = (d) => new Date(d + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
async function api(url, method = 'GET', body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.token && { Authorization: 'Bearer ' + S.token }) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) { logout(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function logout() {
  localStorage.removeItem('fd_token'); S.token = null; S.me = null; S.board = null;
  if (S.ws) { const w = S.ws; S.ws = null; w.close(); }
  location.hash = '#/'; route();
}

/* ---------- Modal ---------- */
function modal(html) {
  const m = $('#modal'); m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false;
  m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModal(); };
  const first = m.querySelector('input,textarea'); first && first.focus();
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; S.taskId = null; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

/* ---------- Auth ---------- */
function renderAuth(mode = 'login') {
  const reg = mode === 'register';
  $('#app').innerHTML = `
  <div class="auth">
    <section class="auth-hero">
      <div class="brand"><i></i>FlowDesk</div>
      <div><h1>Poori team, ek board par.</h1>
        <p>Create projects, assign tasks, discuss in comments and watch updates arrive live.</p></div>
      <div class="mini" aria-hidden="true">
        <div><b>To do</b><span class="l">Design homepage</span><span class="l">Write API docs</span></div>
        <div><b>In progress</b><span>Build login flow</span></div>
        <div><b>Done</b><span class="t">Set up database</span><span class="t">Team kickoff</span></div>
      </div>
    </section>
    <section class="auth-form"><div class="auth-card">
      <h2>${reg ? 'Create your account' : 'Welcome back'}</h2>
      <p class="sub">${reg ? 'Start managing projects with your team.' : 'Log in to open your projects.'}</p>
      <form id="authForm" novalidate>
        ${reg ? '<label class="field"><span>Full name</span><input name="name" autocomplete="name"></label>' : ''}
        <label class="field"><span>Username</span><input name="username" autocomplete="username"></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
        <div class="error" id="authErr" aria-live="polite"></div>
        <button class="btn btn-primary">${reg ? 'Create account' : 'Log in'}</button>
      </form>
      <p class="switch">${reg ? 'Already have an account?' : 'New here?'} <button id="swap">${reg ? 'Log in' : 'Create an account'}</button></p>
    </div></section>
  </div>`;
  $('#swap').onclick = () => renderAuth(reg ? 'login' : 'register');
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn'); btn.disabled = true;
    try {
      const d = await api(reg ? '/register' : '/login', 'POST', Object.fromEntries(new FormData(e.target)));
      S.token = d.token; S.me = d.user; localStorage.setItem('fd_token', d.token);
      location.hash = '#/'; route();
    } catch (err) { $('#authErr').textContent = err.message; btn.disabled = false; }
  };
}

/* ---------- Shell + notifications ---------- */
async function ensureShell() {
  if ($('#view')) return;
  $('#app').innerHTML = `
  <header class="top"><div class="top-in">
    <a href="#/" class="brand"><i></i>FlowDesk</a>
    <div class="top-right">
      <div class="bell-wrap"><button id="bell" aria-label="Notifications">${ICON.bell}<span id="badge" hidden>0</span></button><div id="npanel" class="npanel" hidden></div></div>
      <div class="who-me">${avatar(S.me, 'sm')}<span>${esc(S.me.name)}</span></div>
      <button class="btn btn-ghost btn-sm" id="logout">Log out</button>
    </div>
  </div></header>
  <main id="view"></main>`;
  $('#logout').onclick = logout;
  $('#bell').onclick = async (e) => {
    e.stopPropagation();
    const p = $('#npanel'); p.hidden = !p.hidden;
    if (!p.hidden) { renderNotifs(); if (S.unread) { S.unread = 0; updateBell(); api('/notifications/read', 'POST').catch(() => {}); } }
  };
  document.addEventListener('click', (e) => { const p = $('#npanel'); if (p && !p.hidden && !e.target.closest('#npanel')) p.hidden = true; });
  try { const d = await api('/notifications'); S.notifs = d.items; S.unread = d.unread; updateBell(); } catch {}
}
function updateBell() { const b = $('#badge'); if (b) { b.hidden = !S.unread; b.textContent = S.unread > 9 ? '9+' : S.unread; } }
function renderNotifs() {
  $('#npanel').innerHTML = '<h4>Notifications</h4>' + (S.notifs.length ? S.notifs.map((n) => `
    <button class="nitem ${n.is_read ? '' : 'new'}" data-project="${n.project_id || ''}">${esc(n.text)}<small>${ago(n.created_at)}</small></button>`).join('')
    : '<p class="nempty">Nothing yet. Updates on your tasks will show up here.</p>');
  document.querySelectorAll('.nitem').forEach((b) => b.onclick = () => {
    $('#npanel').hidden = true; if (b.dataset.project) location.hash = '#/p/' + b.dataset.project;
  });
}

/* ---------- Real-time ---------- */
function connect() {
  if (!S.token || S.ws) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${S.token}`);
  S.ws = ws;
  ws.onopen = () => setLive(true);
  ws.onclose = () => { setLive(false); if (S.ws === ws) { S.ws = null; if (S.token) setTimeout(connect, 2000); } };
  ws.onmessage = (e) => onWs(JSON.parse(e.data));
}
function setLive(v) { S.live = v; const el = $('#live'); if (el) el.classList.toggle('on', v); }
function onWs(m) {
  if (m.type === 'notification') {
    S.notifs.unshift(m.n); S.unread++; updateBell(); toast(m.n.text);
    if ($('#npanel') && !$('#npanel').hidden) renderNotifs();
  } else if (m.type === 'project') {
    if (S.board && S.board.project.id === m.projectId) {
      if (m.gone) { toast('You no longer have access to this project.'); location.hash = '#/'; }
      else refreshBoard();
    } else if (!S.board && $('#grid')) loadProjects();
  }
}

/* ---------- Dashboard ---------- */
function renderDashboard() {
  S.board = null;
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Your projects</h1><p>Pick a project to open its board.</p></div>
      <button class="btn btn-primary" id="newProject">New project</button></div>
    <div id="grid" class="grid"></div>`;
  $('#newProject').onclick = projectModal;
  loadProjects();
}
async function loadProjects() {
  const list = await api('/projects');
  const grid = $('#grid'); if (!grid) return;
  grid.innerHTML = list.map((p) => `
    <a class="proj" href="#/p/${p.id}"><h3>${esc(p.name)}</h3><p>${esc(p.description || 'No description yet.')}</p>
      <div class="bar"><i style="width:${p.total ? Math.round(p.done / p.total * 100) : 0}%"></i></div>
      <div class="proj-foot"><span>${p.done} of ${p.total} tasks done</span><span>${p.members} member${p.members === 1 ? '' : 's'}</span></div></a>`).join('')
    + `<button class="proj proj-new" id="newCard">${list.length ? 'New project' : 'Create your first project'}</button>`;
  $('#newCard').onclick = projectModal;
}
function projectModal() {
  modal(`<form id="pf"><div class="mhead"><h2>New project</h2><button type="button" class="x" data-close aria-label="Close">&times;</button></div>
    <label class="field"><span>Project name</span><input name="name" maxlength="60"></label>
    <label class="field"><span>Description (optional)</span><textarea name="description" rows="3" maxlength="200"></textarea></label>
    <div class="error" id="mErr"></div><button class="btn btn-primary">Create project</button></form>`);
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    try { const d = await api('/projects', 'POST', Object.fromEntries(new FormData(e.target))); closeModal(); location.hash = '#/p/' + d.id; }
    catch (err) { $('#mErr').textContent = err.message; }
  };
}

/* ---------- Board ---------- */
async function openBoard(id) {
  try { S.board = await api('/projects/' + id); }
  catch (err) { toast(err.message); location.hash = '#/'; return; }
  renderBoard();
}
async function refreshBoard() {
  if (!S.board) return;
  try { S.board = await api('/projects/' + S.board.project.id); } catch { return; }
  renderBoard();
  if (S.taskId) {
    if (!S.board.tasks.some((t) => t.id === S.taskId)) { closeModal(); toast('That task was deleted.'); }
    else loadComments(S.taskId);
  }
}
const card = (t) => {
  const late = t.due_date && t.status !== 'done' && t.due_date < today();
  return `<article class="task" draggable="true" data-task="${t.id}" tabindex="0">
    <div class="task-top"><span class="prio ${t.priority}">${PRIO[t.priority]}</span>${t.due_date ? `<span class="due ${late ? 'late' : ''}">${late ? 'Overdue ' : 'Due '}${fmtDate(t.due_date)}</span>` : ''}</div>
    <h3>${esc(t.title)}</h3>
    <div class="task-foot"><span class="cm-count">${ICON.chat}${t.comments}</span>
      ${t.assignee_id ? `<span title="${esc(t.assignee_name)}">${avatar({ id: t.assignee_id, name: t.assignee_name }, 'xs')}</span>` : '<span class="unassigned">Unassigned</span>'}</div>
  </article>`;
};
function renderBoard() {
  const { project, members, tasks, isOwner } = S.board;
  const list = S.mine ? tasks.filter((t) => t.assignee_id === S.me.id) : tasks;
  $('#view').innerHTML = `
    <div class="board-head">
      <div><a href="#/" class="back">Back to projects</a><h1>${esc(project.name)}</h1>${project.description ? `<p>${esc(project.description)}</p>` : ''}</div>
      <div class="head-right">
        <div class="stack">${members.map((m) => `<span title="${esc(m.name)}">${avatar(m, 'sm')}</span>`).join('')}</div>
        ${isOwner ? '<button class="btn btn-ghost" id="members">Team</button>' : '<button class="btn btn-ghost" id="leave">Leave project</button>'}
        <button class="btn btn-primary" id="newTask">New task</button>
      </div>
    </div>
    <div class="toolbar"><label><input type="checkbox" id="mine" ${S.mine ? 'checked' : ''}> Only my tasks</label>
      ${isOwner ? '<button class="link-danger" id="delProject">Delete project</button>' : ''}
      <span id="live" class="live ${S.live ? 'on' : ''}">Live updates</span></div>
    <div class="cols">${STATUS.map(([k, l]) => {
      const c = list.filter((t) => t.status === k);
      return `<section class="col ${k}"><header><h2>${l}</h2><span>${c.length}</span></header>
        <div class="col-body" data-status="${k}">${c.map(card).join('') || '<p class="col-empty">Drop tasks here</p>'}</div></section>`;
    }).join('')}</div>`;

  $('#newTask').onclick = () => taskModal();
  $('#mine').onchange = (e) => { S.mine = e.target.checked; renderBoard(); };
  if (isOwner) { $('#members').onclick = teamModal; $('#delProject').onclick = async () => {
    if (!confirm('Delete this project and all its tasks?')) return;
    try { await api('/projects/' + project.id, 'DELETE'); toast('Project deleted'); location.hash = '#/'; } catch (err) { toast(err.message); }
  }; } else $('#leave').onclick = async () => {
    if (!confirm('Leave this project?')) return;
    try { await api(`/projects/${project.id}/members/${S.me.id}`, 'DELETE'); location.hash = '#/'; } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('.task').forEach((el) => {
    el.onclick = () => openTask(+el.dataset.task);
    el.onkeydown = (e) => { if (e.key === 'Enter') openTask(+el.dataset.task); };
    el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', el.dataset.task); el.classList.add('drag'); };
    el.ondragend = () => el.classList.remove('drag');
  });
  document.querySelectorAll('.col-body').forEach((b) => {
    b.ondragover = (e) => { e.preventDefault(); b.classList.add('over'); };
    b.ondragleave = () => b.classList.remove('over');
    b.ondrop = async (e) => {
      e.preventDefault(); b.classList.remove('over');
      const t = S.board.tasks.find((x) => x.id === +e.dataTransfer.getData('text/plain'));
      if (!t || t.status === b.dataset.status) return;
      t.status = b.dataset.status; renderBoard();
      try { await api('/tasks/' + t.id, 'PUT', { status: t.status }); } catch (err) { toast(err.message); }
      refreshBoard();
    };
  });
}

/* ---------- Task modal ---------- */
const opts = (pairs, sel) => pairs.map(([v, l]) => `<option value="${v}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
function taskModal(t) {
  const isNew = !t, { members, project } = S.board;
  t = t || { title: '', description: '', status: 'todo', priority: 'medium', assignee_id: '', due_date: '' };
  S.taskId = isNew ? null : t.id;
  modal(`<form id="tf"><div class="mhead"><h2>${isNew ? 'New task' : 'Task details'}</h2><button type="button" class="x" data-close aria-label="Close">&times;</button></div>
    <label class="field"><span>Title</span><input name="title" value="${esc(t.title)}" maxlength="120"></label>
    <label class="field"><span>Description</span><textarea name="description" rows="3" maxlength="1000">${esc(t.description)}</textarea></label>
    <div class="row2">
      <label class="field"><span>Status</span><select name="status">${opts(STATUS, t.status)}</select></label>
      <label class="field"><span>Priority</span><select name="priority">${opts([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], t.priority)}</select></label>
      <label class="field"><span>Assigned to</span><select name="assignee_id">${opts([['', 'Unassigned'], ...members.map((m) => [m.id, m.name])], t.assignee_id)}</select></label>
      <label class="field"><span>Due date</span><input type="date" name="due_date" value="${t.due_date || ''}"></label>
    </div>
    <div class="error" id="mErr"></div>
    <div class="mfoot">${isNew ? '<span></span>' : '<button type="button" class="link-danger" id="delTask">Delete task</button>'}<button class="btn btn-primary">${isNew ? 'Create task' : 'Save changes'}</button></div>
  </form>
  ${isNew ? '' : `<section class="comments"><h3>Comments</h3><div id="cmList"></div>
    <form id="cf" class="cm-form"><input name="content" placeholder="Write a comment" maxlength="500" aria-label="Comment"><button class="btn btn-primary btn-sm">Send</button></form></section>`}`);
  $('#tf').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      isNew ? await api(`/projects/${project.id}/tasks`, 'POST', body) : await api('/tasks/' + t.id, 'PUT', body);
      closeModal(); await refreshBoard(); toast(isNew ? 'Task created' : 'Task saved');
    } catch (err) { $('#mErr').textContent = err.message; }
  };
  if (!isNew) {
    $('#delTask').onclick = async () => {
      if (!confirm('Delete this task?')) return;
      try { await api('/tasks/' + t.id, 'DELETE'); closeModal(); await refreshBoard(); toast('Task deleted'); } catch (err) { toast(err.message); }
    };
    $('#cf').onsubmit = async (e) => {
      e.preventDefault();
      const input = e.target.content; if (!input.value.trim()) return;
      try { await api(`/tasks/${t.id}/comments`, 'POST', { content: input.value }); input.value = ''; await refreshBoard(); } catch (err) { toast(err.message); }
    };
    loadComments(t.id);
  }
}
function openTask(id) { const t = S.board.tasks.find((x) => x.id === id); if (t) taskModal(t); }
async function loadComments(id) {
  const box = $('#cmList'); if (!box) return;
  const list = await api(`/tasks/${id}/comments`).catch(() => []);
  box.innerHTML = list.length ? list.map((c) => `<div class="cm-item">${avatar({ id: c.user_id, name: c.name }, 'sm')}
    <div><p><b>${esc(c.name)}</b>${esc(c.content)}</p><small>${ago(c.created_at)}</small></div></div>`).join('')
    : '<p class="nempty" style="padding:0 0 10px">No comments yet. Start the discussion.</p>';
}

/* ---------- Team modal (owner) ---------- */
function teamModal() {
  const { members, project } = S.board;
  modal(`<div class="mhead"><h2>Team</h2><button type="button" class="x" data-close aria-label="Close">&times;</button></div>
    ${members.map((m) => `<div class="cm-item" style="align-items:center">${avatar(m, 'sm')}<div style="flex:1"><b>${esc(m.name)}</b><small style="margin:0">@${esc(m.username)}${m.id === project.owner_id ? ' (owner)' : ''}</small></div>
      ${m.id === project.owner_id ? '' : `<button class="link-danger" data-rm="${m.id}">Remove</button>`}</div>`).join('')}
    <form id="mf" class="cm-form" style="margin-top:16px"><input name="username" placeholder="Add by username" aria-label="Username"><button class="btn btn-primary btn-sm">Add</button></form>
    <div class="error" id="mErr" style="margin-top:8px"></div>`);
  $('#mf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/projects/${project.id}/members`, 'POST', { username: e.target.username.value }); await refreshBoard(); teamModal(); toast('Member added'); }
    catch (err) { $('#mErr').textContent = err.message; }
  };
  document.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => {
    try { await api(`/projects/${project.id}/members/${b.dataset.rm}`, 'DELETE'); await refreshBoard(); teamModal(); } catch (err) { toast(err.message); }
  });
}

/* ---------- Router ---------- */
async function route() {
  if (!S.token) { S.me = null; return renderAuth(); }
  if (!S.me) { try { S.me = await api('/me'); } catch { return renderAuth(); } }
  await ensureShell(); connect(); closeModal();
  const m = location.hash.match(/^#\/p\/(\d+)/);
  m ? openBoard(m[1]) : renderDashboard();
}
window.addEventListener('hashchange', route);
route();
