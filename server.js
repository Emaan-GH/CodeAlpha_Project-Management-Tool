const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+ (no install needed)

const SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const PORT = process.env.PORT || 3000;

/* ---------- Database ---------- */
const db = new DatabaseSync(path.join(__dirname, 'flowdesk.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  project_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

const STATUSES = ['todo', 'doing', 'done'];
const STATUS_LABEL = { todo: 'To do', doing: 'In progress', done: 'Done' };
const PRIORITIES = ['low', 'medium', 'high'];

const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const isMember = (pid, uid) => !!one('SELECT 1 AS x FROM members WHERE project_id = ? AND user_id = ?', pid, uid);
const memberIds = (pid) => all('SELECT user_id FROM members WHERE project_id = ?', pid).map((r) => r.user_id);

/* ---------- Real-time (WebSockets) ---------- */
const clients = new Map(); // userId -> Set<ws>
function push(uid, msg) {
  (clients.get(uid) || []).forEach((ws) => ws.readyState === 1 && ws.send(JSON.stringify(msg)));
}
function touch(pid, actor, extra = {}) { // tell every other member to refresh this project
  memberIds(pid).forEach((u) => u !== actor && push(u, { type: 'project', projectId: pid, ...extra }));
}
function notify(uid, actor, text, pid) {
  if (!uid || uid === actor) return;
  const r = run('INSERT INTO notifications (user_id, text, project_id) VALUES (?, ?, ?)', uid, text, pid);
  push(uid, { type: 'notification', n: one('SELECT * FROM notifications WHERE id = ?', r.lastInsertRowid) });
}

/* ---------- App ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const fail = (res, code, msg) => res.status(code).json({ error: msg });
const sign = (u) => jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d' });
const pub = (u) => ({ id: u.id, username: u.username, name: u.name });

function auth(req, res, next) {
  try {
    req.uid = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET).id;
    req.me = one('SELECT * FROM users WHERE id = ?', req.uid);
    if (!req.me) throw 0;
    next();
  } catch { fail(res, 401, 'Please log in again.'); }
}
function member(req, res, next) {
  const pid = Number(req.params.id);
  if (!one('SELECT 1 AS x FROM projects WHERE id = ?', pid)) return fail(res, 404, 'Project not found.');
  if (!isMember(pid, req.uid)) return fail(res, 403, 'You are not a member of this project.');
  req.pid = pid; next();
}

/* ----- Auth ----- */
app.post('/api/register', (req, res) => {
  const { name = '', username = '', password = '' } = req.body;
  if (name.trim().length < 2) return fail(res, 400, 'Enter your full name.');
  if (!/^[a-z0-9_]{3,20}$/i.test(username)) return fail(res, 400, 'Username must be 3-20 letters, numbers or underscores.');
  if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  if (one('SELECT 1 AS x FROM users WHERE username = ?', username.toLowerCase())) return fail(res, 409, 'That username is taken.');
  const r = run('INSERT INTO users (username, name, password) VALUES (?, ?, ?)', username.toLowerCase(), name.trim(), bcrypt.hashSync(password, 10));
  const u = one('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
  res.json({ token: sign(u), user: pub(u) });
});
app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body;
  const u = one('SELECT * FROM users WHERE username = ?', username.toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.password)) return fail(res, 401, 'Wrong username or password.');
  res.json({ token: sign(u), user: pub(u) });
});
app.get('/api/me', auth, (req, res) => res.json(pub(req.me)));

/* ----- Projects ----- */
app.get('/api/projects', auth, (req, res) => {
  res.json(all(`SELECT p.id, p.name, p.description, p.owner_id,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) AS total,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status = 'done') AS done,
      (SELECT COUNT(*) FROM members WHERE project_id = p.id) AS members
    FROM projects p JOIN members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.id DESC`, req.uid));
});
app.post('/api/projects', auth, (req, res) => {
  const name = (req.body.name || '').trim();
  if (name.length < 2) return fail(res, 400, 'Give the project a name.');
  const r = run('INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)', name.slice(0, 60), (req.body.description || '').trim().slice(0, 200), req.uid);
  run('INSERT INTO members (project_id, user_id) VALUES (?, ?)', r.lastInsertRowid, req.uid);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.get('/api/projects/:id', auth, member, (req, res) => {
  const project = one('SELECT * FROM projects WHERE id = ?', req.pid);
  res.json({
    project: { id: project.id, name: project.name, description: project.description, owner_id: project.owner_id },
    isOwner: project.owner_id === req.uid,
    members: all('SELECT u.id, u.name, u.username FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name', req.pid),
    tasks: all(`SELECT t.id, t.title, t.description, t.status, t.priority, t.assignee_id, t.due_date, a.name AS assignee_name,
        (SELECT COUNT(*) FROM comments WHERE task_id = t.id) AS comments
      FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id WHERE t.project_id = ? ORDER BY t.id`, req.pid)
  });
});
app.delete('/api/projects/:id', auth, member, (req, res) => {
  const p = one('SELECT * FROM projects WHERE id = ?', req.pid);
  if (p.owner_id !== req.uid) return fail(res, 403, 'Only the project owner can delete it.');
  const ids = memberIds(req.pid);
  run('DELETE FROM projects WHERE id = ?', req.pid);
  ids.forEach((u) => { notify(u, req.uid, `${req.me.name} deleted the project "${p.name}"`, null); push(u, { type: 'project', projectId: req.pid, gone: true }); });
  res.json({ ok: true });
});

/* ----- Members ----- */
app.post('/api/projects/:id/members', auth, member, (req, res) => {
  const p = one('SELECT * FROM projects WHERE id = ?', req.pid);
  if (p.owner_id !== req.uid) return fail(res, 403, 'Only the project owner can add members.');
  const u = one('SELECT * FROM users WHERE username = ?', String(req.body.username || '').trim().toLowerCase());
  if (!u) return fail(res, 404, 'No user with that username.');
  if (isMember(req.pid, u.id)) return fail(res, 409, `${u.name} is already in this project.`);
  run('INSERT INTO members (project_id, user_id) VALUES (?, ?)', req.pid, u.id);
  notify(u.id, req.uid, `${req.me.name} added you to "${p.name}"`, req.pid);
  touch(req.pid, req.uid);
  res.json({ ok: true });
});
app.delete('/api/projects/:id/members/:uid', auth, member, (req, res) => {
  const target = Number(req.params.uid);
  const p = one('SELECT * FROM projects WHERE id = ?', req.pid);
  if (target === p.owner_id) return fail(res, 400, 'The owner cannot be removed.');
  if (req.uid !== p.owner_id && req.uid !== target) return fail(res, 403, 'Only the owner can remove members.');
  run('DELETE FROM members WHERE project_id = ? AND user_id = ?', req.pid, target);
  run('UPDATE tasks SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?', req.pid, target);
  if (target !== req.uid) { notify(target, req.uid, `${req.me.name} removed you from "${p.name}"`, null); push(target, { type: 'project', projectId: req.pid, gone: true }); }
  touch(req.pid, req.uid);
  res.json({ ok: true });
});

/* ----- Tasks ----- */
function cleanTask(b, current) {
  const t = { ...current };
  if (b.title !== undefined) t.title = String(b.title).trim().slice(0, 120);
  if (b.description !== undefined) t.description = String(b.description).trim().slice(0, 1000);
  if (b.status !== undefined && STATUSES.includes(b.status)) t.status = b.status;
  if (b.priority !== undefined && PRIORITIES.includes(b.priority)) t.priority = b.priority;
  if (b.due_date !== undefined) t.due_date = /^\d{4}-\d{2}-\d{2}$/.test(b.due_date) ? b.due_date : null;
  if (b.assignee_id !== undefined) t.assignee_id = b.assignee_id ? Number(b.assignee_id) : null;
  return t;
}
app.post('/api/projects/:id/tasks', auth, member, (req, res) => {
  const t = cleanTask(req.body, { title: '', description: '', status: 'todo', priority: 'medium', due_date: null, assignee_id: null });
  if (!t.title) return fail(res, 400, 'Give the task a title.');
  if (t.assignee_id && !isMember(req.pid, t.assignee_id)) return fail(res, 400, 'Assignee must be a project member.');
  const r = run('INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, created_by, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    req.pid, t.title, t.description, t.status, t.priority, t.assignee_id, req.uid, t.due_date);
  if (t.assignee_id) notify(t.assignee_id, req.uid, `${req.me.name} assigned you "${t.title}"`, req.pid);
  touch(req.pid, req.uid);
  res.json({ id: Number(r.lastInsertRowid) });
});
function taskAccess(req, res, next) {
  const t = one('SELECT * FROM tasks WHERE id = ?', Number(req.params.id));
  if (!t || !isMember(t.project_id, req.uid)) return fail(res, 404, 'Task not found.');
  req.task = t; next();
}
app.put('/api/tasks/:id', auth, taskAccess, (req, res) => {
  const old = req.task, t = cleanTask(req.body, old);
  if (!t.title) return fail(res, 400, 'Task title cannot be empty.');
  if (t.assignee_id && !isMember(old.project_id, t.assignee_id)) return fail(res, 400, 'Assignee must be a project member.');
  run('UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee_id = ?, due_date = ? WHERE id = ?',
    t.title, t.description, t.status, t.priority, t.assignee_id, t.due_date, old.id);
  if (t.assignee_id !== old.assignee_id) notify(t.assignee_id, req.uid, `${req.me.name} assigned you "${t.title}"`, old.project_id);
  else if (t.status !== old.status) notify(t.assignee_id, req.uid, `${req.me.name} moved "${t.title}" to ${STATUS_LABEL[t.status]}`, old.project_id);
  touch(old.project_id, req.uid);
  res.json({ ok: true });
});
app.delete('/api/tasks/:id', auth, taskAccess, (req, res) => {
  run('DELETE FROM tasks WHERE id = ?', req.task.id);
  touch(req.task.project_id, req.uid);
  res.json({ ok: true });
});

/* ----- Comments ----- */
app.get('/api/tasks/:id/comments', auth, taskAccess, (req, res) => {
  res.json(all(`SELECT c.id, c.content, c.created_at, u.id AS user_id, u.name FROM comments c
    JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id`, req.task.id));
});
app.post('/api/tasks/:id/comments', auth, taskAccess, (req, res) => {
  const content = String(req.body.content || '').trim().slice(0, 500);
  if (!content) return fail(res, 400, 'Write a comment first.');
  const t = req.task;
  run('INSERT INTO comments (task_id, user_id, content) VALUES (?, ?, ?)', t.id, req.uid, content);
  new Set([t.assignee_id, t.created_by]).forEach((u) => notify(u, req.uid, `${req.me.name} commented on "${t.title}"`, t.project_id));
  touch(t.project_id, req.uid);
  res.json({ ok: true });
});

/* ----- Notifications ----- */
app.get('/api/notifications', auth, (req, res) => {
  res.json({
    items: all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30', req.uid),
    unread: one('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', req.uid).c
  });
});
app.post('/api/notifications/read', auth, (req, res) => {
  run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', req.uid);
  res.json({ ok: true });
});

/* ---------- Server + WebSocket ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  let uid;
  try { uid = jwt.verify(new URL(req.url, 'http://x').searchParams.get('token'), SECRET).id; }
  catch { return ws.close(); }
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(ws);
  ws.on('close', () => clients.get(uid)?.delete(ws));
});
server.listen(PORT, () => console.log(`FlowDesk is running at http://localhost:${PORT}`));
