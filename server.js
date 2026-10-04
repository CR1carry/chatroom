'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { DatabaseSync } = require('node:sqlite');
const { AI_USER, askAi, hasApiKey, AI_MODEL } = require('./ai');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// 系统中预先固定的三个用户（AI 成员“大肥鱼”不是可选身份，只能被 @ 触发）
const USERS = ['Alice', 'Bob', 'Charlie'];
const AI_MENTION = '@' + AI_USER;
const AI_CONTEXT_LIMIT = 20;     // 送给模型的最近消息条数
const AI_MIN_INTERVAL_MS = 2000; // 两次 AI 回复之间的最小间隔

// ---------- 配置 ----------
const MAX_CONTENT_LENGTH = 2000;      // 单条文本最大字符数
const HISTORY_LIMIT = 50;            // 每次推送 / 分页加载的历史条数
const MAX_MESSAGES = 10000;          // 数据库保留消息上限（超出自动清理最旧的）
const WS_MAX_PAYLOAD = 16 * 1024;    // WebSocket 单帧上限 16KB，防超大帧内存 DoS
const RATE_LIMIT = { max: 15, windowMs: 5000 }; // 每连接 5 秒内最多 15 条

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const ALLOWED_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 图片最大 8MB

// ---------- SQLite 数据库 + 迁移 ----------
const db = new DatabaseSync(path.join(__dirname, 'chat.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender     TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    kind       TEXT    NOT NULL DEFAULT 'text',
    created_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);
`);

// 兼容旧库：若缺少 kind / deleted 列则补上（不丢已有数据）
function ensureColumn(col, ddl) {
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(ddl);
}
ensureColumn('kind', "ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
ensureColumn('deleted', 'ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');

const insertStmt = db.prepare(
  'INSERT INTO messages (sender, content, kind, created_at) VALUES (?, ?, ?, ?)'
);
const latestStmt = db.prepare(
  'SELECT id, sender, content, kind, created_at FROM messages WHERE deleted = 0 ORDER BY id DESC LIMIT ?'
);
const beforeStmt = db.prepare(
  'SELECT id, sender, content, kind, created_at FROM messages WHERE deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?'
);
const searchStmt = db.prepare(
  "SELECT id, sender, content, kind, created_at FROM messages WHERE deleted = 0 AND kind = 'text' AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?"
);
const countStmt = db.prepare('SELECT COUNT(*) c FROM messages');
const pruneStmt = db.prepare(
  'DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY id DESC LIMIT -1 OFFSET ?)'
);
const getStmt = db.prepare('SELECT id, sender, kind FROM messages WHERE id = ? AND deleted = 0');
const recallStmt = db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?');
const exportStmt = db.prepare(
  'SELECT sender, content, kind, created_at FROM messages WHERE deleted = 0 ORDER BY id ASC'
);

// ---------- Express ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '12mb' })); // 图片以 base64 上传，需较大 body 上限

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(n, max));
}

// 历史消息：支持分页(before 游标)与搜索(q)，均返回升序
app.get('/api/messages', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, HISTORY_LIMIT);
  const before = req.query.before ? Number(req.query.before) : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  let rows;
  if (q) {
    const escaped = q.replace(/[\\%_]/g, (c) => '\\' + c);
    rows = searchStmt.all('%' + escaped + '%', limit).reverse();
  } else if (before && Number.isInteger(before) && before > 0) {
    rows = beforeStmt.all(before, limit).reverse();
  } else {
    rows = latestStmt.all(limit).reverse();
  }
  res.json({ messages: rows });
});

// 导出聊天记录（纯文本）
app.get('/api/export', (_req, res) => {
  const rows = exportStmt.all();
  const pad = (n) => String(n).padStart(2, '0');
  const lines = rows.map((r) => {
    const d = new Date(r.created_at);
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const body = r.kind === 'image' ? `[图片] ${r.content}` : r.content;
    return `[${date} ${t}] ${r.sender}: ${body}`;
  });
  const header = [
    '计算机学习交流群 - 聊天记录',
    '导出时间: ' + new Date().toLocaleString('zh-CN'),
    '',
  ].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="chat-history.txt"');
  res.send(header + lines.join('\n'));
});

// 图片上传：base64 dataURL -> 保存到 public/uploads -> 返回可访问 URL
app.post('/api/upload', (req, res) => {
  const dataUrl = req.body && req.body.dataUrl;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: '无效的图片数据' });
  }
  const m = dataUrl.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: '仅支持 png/jpg/gif/webp' });
  const ext = m[1] === 'jpeg' ? '.jpg' : '.' + m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return res.status(400).json({ error: '图片数据为空' });
  if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: '图片超过 8MB' });

  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    res.json({ url: '/uploads/' + name });
  } catch (err) {
    console.error('图片保存失败:', err);
    res.status(500).json({ error: '图片保存失败' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, users: USERS });
});

// ---------- HTTP + WebSocket ----------
const server = http.createServer(app);

// 跨站 WebSocket 劫持(CSWSH)防护：仅允许同源或无 Origin(脚本客户端)的连接
function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    if (o.host === req.headers.host) return true;
    return ['localhost', '127.0.0.1', '::1'].includes(o.hostname);
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

server.on('upgrade', (req, socket, head) => {
  if (!isOriginAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

function sendTo(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function onlineUsers() {
  // AI 群成员常驻在线
  const set = new Set([AI_USER]);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN && c._user) set.add(c._user);
  }
  return [...set];
}

function broadcastOnline() {
  const users = onlineUsers();
  broadcast({ type: 'online', users, count: users.length });
}

// 每连接滑动窗口限流
function rateLimitAllow(ws) {
  const now = Date.now();
  const arr = ws._times || (ws._times = []);
  while (arr.length && now - arr[0] > RATE_LIMIT.windowMs) arr.shift();
  if (arr.length >= RATE_LIMIT.max) return false;
  arr.push(now);
  return true;
}

function pruneIfNeeded() {
  const c = countStmt.get().c;
  if (c > MAX_MESSAGES) pruneStmt.run(MAX_MESSAGES);
}

// ---------- AI 群成员：大肥鱼 ----------
// 只有被 @ 时才发言；其余时间完全静默，不参与群成员之间的对话
function buildAiContext() {
  const rows = latestStmt.all(AI_CONTEXT_LIMIT).reverse();
  const msgs = [];
  for (const r of rows) {
    if (r.kind !== 'text' || !r.content) continue;
    if (r.sender === AI_USER) {
      msgs.push({ role: 'assistant', content: r.content });
    } else {
      msgs.push({ role: 'user', content: `${r.sender}: ${r.content}` });
    }
  }
  return msgs;
}

// 异常提示：只广播不入库，避免污染聊天记录
function broadcastAiNotice(text) {
  broadcast({
    type: 'message',
    message: {
      id: 'ai-notice-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      sender: AI_USER,
      content: text,
      kind: 'text',
      created_at: Date.now(),
      transient: true,
    },
  });
}

let aiChain = Promise.resolve();
let lastAiCallAt = 0;

async function replyAsAi() {
  const gap = lastAiCallAt + AI_MIN_INTERVAL_MS - Date.now();
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  lastAiCallAt = Date.now();

  broadcast({ type: 'typing', user: AI_USER, on: true });
  try {
    const text = await askAi(buildAiContext());
    const content = text.slice(0, MAX_CONTENT_LENGTH);
    const created_at = Date.now();
    const info = insertStmt.run(AI_USER, content, 'text', created_at);
    broadcast({
      type: 'message',
      message: {
        id: Number(info.lastInsertRowid),
        sender: AI_USER,
        content,
        kind: 'text',
        created_at,
      },
    });
    pruneIfNeeded();
  } catch (err) {
    if (err.code === 'NO_KEY') {
      broadcastAiNotice('（我还未配置大模型 API Key，暂时无法回答。请在 ai-key.txt 填入 Key 后重启服务）');
    } else {
      broadcastAiNotice('（我暂时无法回答这个问题：模型服务异常，请稍后再试）');
    }
    console.error('[大肥鱼] 回复失败:', err.message);
  } finally {
    broadcast({ type: 'typing', user: AI_USER, on: false });
  }
}

// 串行执行，避免并发打爆模型接口
function queueAiReply() {
  aiChain = aiChain.then(replyAsAi).catch((e) => console.error('[大肥鱼] 队列异常:', e.message));
}

wss.on('connection', (ws) => {
  ws._user = null;

  // 推送历史
  const history = latestStmt.all(HISTORY_LIMIT).reverse();
  sendTo(ws, { type: 'history', messages: history });
  broadcastOnline();

  ws.on('close', () => {
    // 同样不插入“X 离开了群聊”提示，只刷新在线成员
    ws._user = null;
    broadcastOnline();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // ---- 上线/切换身份 ----
    // 仅更新在线成员状态，不在聊天框里插入“X 加入了群聊”提示
    if (msg.type === 'presence') {
      if (typeof msg.user !== 'string') return;
      const user = msg.user.trim();
      if (!USERS.includes(user)) return;
      ws._user = user;
      broadcastOnline();
      return;
    }

    // ---- 撤回消息 ----
    if (msg.type === 'recall') {
      const id = Number(msg.id);
      if (!Number.isInteger(id) || id <= 0) return;
      const row = getStmt.get(id);
      if (!row) return;
      if (row.sender !== ws._user) return; // 只能撤回自己发的（体验层校验）
      recallStmt.run(id);
      broadcast({ type: 'recall', id, sender: row.sender });
      return;
    }

    // ---- 发送消息 ----
    if (msg.type !== 'message') return;

    // 严格类型校验，杜绝对象/数字等被隐式强转
    if (typeof msg.sender !== 'string' || typeof msg.content !== 'string') return;
    const sender = msg.sender.trim();
    if (!USERS.includes(sender)) return;

    const kind = msg.kind === 'image' ? 'image' : 'text';
    const content = msg.content.trim();

    if (kind === 'text') {
      if (!content || content.length > MAX_CONTENT_LENGTH) return;
    } else {
      // 图片消息：content 必须是本站上传返回的 /uploads/ 相对路径
      if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(content)) return;
    }

    if (!rateLimitAllow(ws)) {
      sendTo(ws, { type: 'error', text: '发送太快了，请稍后再试' });
      return;
    }

    const created_at = Date.now();
    try {
      const info = insertStmt.run(sender, content, kind, created_at);
      const message = { id: Number(info.lastInsertRowid), sender, content, kind, created_at };
      broadcast({ type: 'message', message });
      pruneIfNeeded();

      // 仅当消息里 @ 了大肥鱼 才触发 AI 回复
      if (kind === 'text' && content.includes(AI_MENTION)) queueAiReply();
    } catch (err) {
      console.error('写入消息失败:', err);
      sendTo(ws, { type: 'error', text: '消息发送失败，请重试' });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  计算机学习交流群 在线聊天室 v2 已启动');
  console.log(`  本机访问:  http://localhost:${PORT}`);
  console.log('  请打开 3 个浏览器窗口，分别选择 Alice / Bob / Charlie');
  console.log(`  AI 群成员: ${AI_USER}（${AI_MODEL}）${
    hasApiKey() ? '已就绪，可 @ 提问' : '未配置 API Key，请在 ai-key.txt 填入后重启'
  }`);
  console.log('==============================================');
});
