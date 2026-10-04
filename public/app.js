'use strict';

const USERS = ['Alice', 'Bob', 'Charlie'];          // 可选身份
const AI_USER = '大肥鱼';                            // AI 群成员（不可选为身份）
const ALL_MEMBERS = [...USERS, AI_USER];            // 成员面板展示
const MENTION_USERS = [...USERS, AI_USER];          // 可被 @ 的对象
const HISTORY_LIMIT = 50;

// 用户名 -> CSS 类名（大肥鱼 用 ascii 类名，避免中文类名）
const USER_CLASS = { Alice: 'alice', Bob: 'bob', Charlie: 'charlie', [AI_USER]: 'ai' };
const userClass = (name) => USER_CLASS[name] || 'other';
const EMOJIS = ['😀', '😄', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '🙄', '😴', '😭', '😅', '👍', '👎', '👏', '🙏', '💪', '❤️', '💔', '🎉', '🔥', '✨', '💯', '🚀', '🎁', '🌹', '🍺', '☕', '🤝', '👀', '🐶', '🐱'];

let currentUser = 'Alice';
let searchMode = false;
let allMessages = [];     // 当前已加载的消息（升序）
let earliestId = null;    // 已加载最早一条的 id（分页游标）
let hasMore = false;
let loadingMore = false;
let newMsgCount = 0;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('message-input');
const sendBtnEl = $('send-btn');
const currentUserEl = $('current-user');
const statusDotEl = $('status-dot');
const statusTextEl = $('status-text');
const onlineCountEl = $('online-count');
const membersListEl = $('members-list');
const searchBarEl = $('search-bar');
const searchInputEl = $('search-input');
const emojiPickerEl = $('emoji-picker');
const mentionListEl = $('mention-list');
const themeToggleEl = $('theme-toggle');

let ws = null;
let reconnectTimer = null;
let scrollBtn = null;

// ---------- 主题 ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  themeToggleEl.textContent = t === 'dark' ? '☀️' : '🌙';
}
function initTheme() {
  applyTheme(localStorage.getItem('chatroom-theme') === 'dark' ? 'dark' : 'light');
}
themeToggleEl.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('chatroom-theme', next);
});

// ---------- 身份 ----------
function setUser(user) {
  currentUser = user;
  currentUserEl.textContent = user;
  currentUserEl.className = 'current-user' + (user === 'Bob' ? ' bob' : user === 'Charlie' ? ' charlie' : '');
  document.querySelectorAll('.identity-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.user === user)
  );
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'presence', user }));
  }
  // 重新渲染，修正 mine 左右对齐
  if (!searchMode) renderAll();
}
document.querySelectorAll('.identity-btn').forEach((b) =>
  b.addEventListener('click', () => setUser(b.dataset.user))
);

// ---------- 连接状态 ----------
function setStatus(online) {
  statusDotEl.className = online ? 'dot dot-on' : 'dot dot-off';
  statusTextEl.textContent = online ? '已连接' : '连接中…';
  sendBtnEl.disabled = !online;
}

// ---------- 时间 / 日期 ----------
const pad = (n) => String(n).padStart(2, '0');
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function formatTime(ts) {
  const d = new Date(ts);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();
  if (sameDay(d, now)) return t;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}`;
}
function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return '今天';
  if (sameDay(d, yest)) return '昨天';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- 滚动 ----------
function isAtBottom() {
  return messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 24;
}
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function ensureScrollBtn() {
  if (scrollBtn) return scrollBtn;
  scrollBtn = document.createElement('button');
  scrollBtn.className = 'scroll-bottom';
  scrollBtn.textContent = '↓ 最新消息';
  scrollBtn.addEventListener('click', () => {
    scrollToBottom();
    newMsgCount = 0;
    scrollBtn.classList.remove('show');
  });
  document.querySelector('.chat-column').appendChild(scrollBtn);
  return scrollBtn;
}

// ---------- Toast ----------
function toast(text) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- 内容渲染（链接识别 + @提醒，全部走 textContent 防 XSS） ----------
function contentNodes(content) {
  const nodes = [];
  const re = /(https?:\/\/[^\s<>]+)|(@(Alice|Bob|Charlie|大肥鱼))/g;
  let last = 0;
  let m;
  while ((m = re.exec(content))) {
    if (m.index > last) nodes.push(document.createTextNode(content.slice(last, m.index)));
    if (m[1]) {
      const a = document.createElement('a');
      a.className = 'msg-link';
      a.href = m[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[1];
      nodes.push(a);
    } else if (m[2]) {
      const span = document.createElement('span');
      span.className = 'msg-mention' + (m[3] === currentUser ? ' mention-me' : '');
      span.textContent = m[2];
      nodes.push(span);
    }
    last = m.index + m[0].length;
  }
  if (last < content.length) nodes.push(document.createTextNode(content.slice(last)));
  return nodes;
}

function actionBtn(label, onClick) {
  const b = document.createElement('button');
  b.className = 'msg-action';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function copyText(text) {
  const done = () => toast('已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => toast('复制失败'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('复制失败'); }
    document.body.removeChild(ta);
  }
}

function recallMessage(id) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'recall', id }));
  }
}

function messageEl(msg) {
  const isMine = msg.sender === currentUser;
  const row = document.createElement('div');
  row.className = 'msg-row' + (isMine ? ' mine' : '');
  row.dataset.id = msg.id;

  const avatar = document.createElement('div');
  avatar.className = 'avatar ' + userClass(msg.sender);
  avatar.textContent = msg.sender === AI_USER ? '🐟' : msg.sender.charAt(0);

  const body = document.createElement('div');
  body.className = 'msg-body';

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const s = document.createElement('span');
  s.className = 'sender ' + userClass(msg.sender);
  s.textContent = msg.sender;
  const t = document.createElement('span');
  t.className = 'time';
  t.textContent = formatTime(msg.created_at);
  meta.append(s, t);
  if (msg.sender === AI_USER) {
    const tag = document.createElement('span');
    tag.className = 'ai-tag';
    tag.textContent = 'AI';
    meta.appendChild(tag);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble' + (msg.kind === 'image' ? ' bubble-image' : '');

  if (msg.recalled) {
    bubble.classList.add('bubble-recalled');
    bubble.textContent = '撤回了一条消息';
  } else if (msg.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.src = msg.content;
    img.loading = 'lazy';
    img.alt = '图片';
    img.addEventListener('click', () => window.open(msg.content, '_blank'));
    bubble.appendChild(img);
  } else {
    contentNodes(msg.content).forEach((n) => bubble.appendChild(n));
  }

  body.append(meta, bubble);

  if (!msg.recalled) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    if (msg.kind === 'text') actions.appendChild(actionBtn('复制', () => copyText(msg.content)));
    if (msg.sender === currentUser) actions.appendChild(actionBtn('撤回', () => recallMessage(msg.id)));
    if (actions.childElementCount) body.appendChild(actions);
  }

  row.append(avatar, body);
  return row;
}

function dayDivider(label) {
  const d = document.createElement('div');
  d.className = 'day-divider';
  d.textContent = label;
  return d;
}

function buildMessages() {
  messagesEl.innerHTML = '';

  if (allMessages.length > 0) {
    const top = document.createElement('div');
    if (hasMore) {
      top.className = 'load-more';
      top.id = 'load-more';
      top.textContent = loadingMore ? '加载中…' : '加载更早的消息';
      top.addEventListener('click', loadOlder);
    } else {
      top.className = 'load-more muted';
      top.textContent = '—— 没有更早的消息了 ——';
    }
    messagesEl.appendChild(top);
  }

  if (allMessages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = '暂无消息，来发第一条吧～';
    messagesEl.appendChild(empty);
  }

  let lastDay = null;
  for (const msg of allMessages) {
    const day = dayLabel(msg.created_at);
    if (day !== lastDay) {
      messagesEl.appendChild(dayDivider(day));
      lastDay = day;
    }
    messagesEl.appendChild(messageEl(msg));
  }
}

function renderAll() {
  const prevH = messagesEl.scrollHeight;
  const prevTop = messagesEl.scrollTop;
  buildMessages();
  messagesEl.scrollTop = prevTop + (messagesEl.scrollHeight - prevH);
}

function renderSearchResults(messages) {
  messagesEl.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'search-result-head';
  head.textContent = messages.length ? `找到 ${messages.length} 条相关消息` : '没有找到相关消息';
  messagesEl.appendChild(head);
  let lastDay = null;
  for (const msg of messages) {
    const day = dayLabel(msg.created_at);
    if (day !== lastDay) {
      messagesEl.appendChild(dayDivider(day));
      lastDay = day;
    }
    messagesEl.appendChild(messageEl(msg));
  }
}

// ---------- 在线成员 ----------
function renderMembers(onlineUsers) {
  membersListEl.innerHTML = '';
  for (const u of ALL_MEMBERS) {
    const isAi = u === AI_USER;
    // AI 成员常驻在线
    const online = isAi || onlineUsers.includes(u);
    const li = document.createElement('li');
    li.className = 'member' + (online ? ' online' : '') + (isAi ? ' is-ai' : '');
    const av = document.createElement('span');
    av.className = 'member-avatar ' + userClass(u);
    av.textContent = isAi ? '🐟' : u.charAt(0);
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = u;
    if (isAi) {
      const tag = document.createElement('span');
      tag.className = 'ai-tag';
      tag.textContent = 'AI';
      name.appendChild(tag);
    }
    const st = document.createElement('span');
    st.className = 'member-status';
    st.textContent = online ? '在线' : '离线';
    li.append(av, name, st);
    membersListEl.appendChild(li);
  }
  onlineCountEl.textContent = onlineUsers.length;
  $('online-count-head').textContent = onlineUsers.length;
}

// ---------- WebSocket ----------
function connect() {
  clearTimeout(reconnectTimer);
  setStatus(false);

  const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(protocol + location.host);

  ws.addEventListener('open', () => {
    setStatus(true);
    ws.send(JSON.stringify({ type: 'presence', user: currentUser }));
  });

  ws.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.type === 'history') {
      allMessages = data.messages || [];
      earliestId = allMessages.length ? allMessages[0].id : null;
      hasMore = allMessages.length >= HISTORY_LIMIT;
      buildMessages();
      scrollToBottom();
    } else if (data.type === 'message') {
      if (searchMode) return;
      if (allMessages.some((m) => m.id === data.message.id)) return;
      const wasAtBottom = isAtBottom();
      allMessages.push(data.message);
      renderAll();
      if (wasAtBottom) {
        scrollToBottom();
        newMsgCount = 0;
        if (scrollBtn) scrollBtn.classList.remove('show');
      } else {
        newMsgCount++;
        ensureScrollBtn().textContent = `↓ ${newMsgCount} 条新消息`;
        ensureScrollBtn().classList.add('show');
      }
    } else if (data.type === 'recall') {
      const m = allMessages.find((x) => x.id === data.id);
      if (m) {
        m.recalled = true;
        if (!searchMode) renderAll();
      }
    } else if (data.type === 'online') {
      renderMembers(data.users);
    } else if (data.type === 'typing') {
      if (data.user === AI_USER) {
        const el = $('typing-indicator');
        el.hidden = !data.on;
        if (data.on) $('typing-text').textContent = AI_USER + ' 正在输入…';
        if (data.on && isAtBottom()) scrollToBottom();
      }
    } else if (data.type === 'error') {
      toast(data.text || '发生错误');
    }
  });

  ws.addEventListener('close', () => {
    setStatus(false);
    reconnectTimer = setTimeout(connect, 1500);
  });

  ws.addEventListener('error', () => ws.close());
}

// ---------- 分页加载 ----------
async function loadOlder() {
  if (loadingMore || searchMode || !hasMore) return;
  loadingMore = true;
  const lm = document.getElementById('load-more');
  if (lm) lm.textContent = '加载中…';
  try {
    const res = await fetch(`/api/messages?limit=${HISTORY_LIMIT}&before=${earliestId}`);
    const data = await res.json();
    if (data.messages.length) {
      allMessages = data.messages.concat(allMessages);
      earliestId = data.messages[0].id;
      hasMore = data.messages.length >= HISTORY_LIMIT;
    } else {
      hasMore = false;
    }
    renderAll();
  } catch {
    toast('加载失败，请重试');
  } finally {
    loadingMore = false;
  }
}

messagesEl.addEventListener('scroll', () => {
  if (messagesEl.scrollTop < 40 && !searchMode) loadOlder();
  if (isAtBottom() && scrollBtn) {
    newMsgCount = 0;
    scrollBtn.classList.remove('show');
  }
});

// ---------- 发送 ----------
function sendText() {
  const content = inputEl.value.trim();
  if (!content) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus(false);
    return;
  }
  ws.send(JSON.stringify({ type: 'message', sender: currentUser, content, kind: 'text' }));
  inputEl.value = '';
  inputEl.focus();
  hideMention();
}

sendBtnEl.addEventListener('click', sendText);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});

// ---------- 图片 ----------
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

async function uploadImage(file) {
  const dataUrl = await readFileAsDataURL(file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '上传失败');
  return data.url;
}

async function sendImage(file) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast('未连接服务器');
    return;
  }
  try {
    toast('图片上传中…');
    const url = await uploadImage(file);
    ws.send(JSON.stringify({ type: 'message', sender: currentUser, content: url, kind: 'image' }));
  } catch (e) {
    toast(e.message || '图片发送失败');
  }
}

$('image-btn').addEventListener('click', () => $('image-file').click());
$('image-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) sendImage(f);
  e.target.value = '';
});

document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) {
        e.preventDefault();
        sendImage(f);
      }
      break;
    }
  }
});

// ---------- 表情 ----------
function buildEmojiPicker() {
  emojiPickerEl.innerHTML = '';
  EMOJIS.forEach((em) => {
    const b = document.createElement('button');
    b.className = 'emoji-item';
    b.textContent = em;
    b.addEventListener('click', () => insertAtCursor(em));
    emojiPickerEl.appendChild(b);
  });
}

function insertAtCursor(text) {
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? inputEl.value.length;
  inputEl.value = inputEl.value.slice(0, start) + text + inputEl.value.slice(end);
  inputEl.selectionStart = inputEl.selectionEnd = start + text.length;
  inputEl.focus();
}

$('emoji-btn').addEventListener('click', () => {
  emojiPickerEl.hidden = !emojiPickerEl.hidden;
});

document.addEventListener('click', (e) => {
  if (!emojiPickerEl.contains(e.target) && e.target.id !== 'emoji-btn') {
    emojiPickerEl.hidden = true;
  }
});

// ---------- @ 提醒 ----------
function mentionPrefix() {
  const value = inputEl.value;
  const caret = inputEl.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  // 不要求 @ 前面有空格：中文输入时“帮我看看@大”这类写法也要能弹出候选
  const m = before.match(/@([\u4e00-\u9fa5A-Za-z]*)$/);
  return m ? m[1] : null;
}

function showMention(prefix) {
  const matches = MENTION_USERS.filter((u) => u.toLowerCase().startsWith(prefix.toLowerCase()));
  if (!matches.length) {
    mentionListEl.hidden = true;
    return;
  }
  mentionListEl.innerHTML = '';
  matches.forEach((u) => {
    const item = document.createElement('div');
    item.className = 'mention-item';
    item.textContent = u;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyMention(u);
    });
    mentionListEl.appendChild(item);
  });
  emojiPickerEl.hidden = true; // 避免与表情面板重叠
  mentionListEl.hidden = false;
}

function applyMention(user) {
  const value = inputEl.value;
  const caret = inputEl.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const idx = before.lastIndexOf('@');
  inputEl.value = before.slice(0, idx) + '@' + user + ' ' + value.slice(caret);
  inputEl.selectionStart = inputEl.selectionEnd = idx + user.length + 2;
  inputEl.focus();
  hideMention();
}

function hideMention() {
  mentionListEl.hidden = true;
}

inputEl.addEventListener('input', () => {
  const p = mentionPrefix();
  if (p !== null) showMention(p);
  else hideMention();
});

// ---------- 搜索 ----------
function exitSearch() {
  searchMode = false;
  searchBarEl.hidden = true;
  searchInputEl.value = '';
  // 重新拉取最新
  fetch(`/api/messages?limit=${HISTORY_LIMIT}`)
    .then((r) => r.json())
    .then((data) => {
      allMessages = data.messages || [];
      earliestId = allMessages.length ? allMessages[0].id : null;
      hasMore = allMessages.length >= HISTORY_LIMIT;
      buildMessages();
      scrollToBottom();
    });
}

function doSearch() {
  const q = searchInputEl.value.trim();
  if (!q) return;
  searchMode = true;
  fetch(`/api/messages?q=${encodeURIComponent(q)}&limit=200`)
    .then((r) => r.json())
    .then((data) => renderSearchResults(data.messages || []))
    .catch(() => toast('搜索失败'));
}

$('search-toggle').addEventListener('click', () => {
  const willShow = searchBarEl.hidden;
  searchBarEl.hidden = !willShow;
  if (willShow) searchInputEl.focus();
  else exitSearch();
});
$('search-close').addEventListener('click', exitSearch);
searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});
searchInputEl.addEventListener('input', () => {
  if (!searchInputEl.value.trim() && searchMode) exitSearch();
});

// ---------- 导出 ----------
$('export-btn').addEventListener('click', () => {
  window.open('/api/export', '_blank');
});

// ---------- 初始化 ----------
buildEmojiPicker();
initTheme();
setUser('Alice');
connect();
