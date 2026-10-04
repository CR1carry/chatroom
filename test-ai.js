'use strict';
// 验证 AI 群成员「大肥鱼」：常驻在线 / 未@不插话 / @后回答 / 不可被冒充
const path = require('path');
const WebSocket = require('ws');
const { DatabaseSync } = require('node:sqlite');

const WS = 'ws://localhost:3000';
const AI = '大肥鱼';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient() {
  const ws = new WebSocket(WS);
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  const open = new Promise((r) => ws.on('open', r));
  const waitFor = (type, pred = () => true, timeoutMs = 60000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        const f = inbox.find((m) => m.type === type && pred(m));
        if (f) return resolve(f);
        if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout: ' + type));
        setTimeout(poll, 50);
      })();
    });
  return { ws, inbox, open, waitFor };
}

async function main() {
  const db = new DatabaseSync(path.join(__dirname, 'chat.db'));
  const beforeCount = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  const beforeMaxId = db.prepare('SELECT COALESCE(MAX(id),0) m FROM messages').get().m;

  const alice = makeClient();
  await alice.open;
  await alice.waitFor('history', () => true, 5000);
  alice.ws.send(JSON.stringify({ type: 'presence', user: 'Alice' }));

  // 1) 大肥鱼 常驻在线
  const online = await alice.waitFor('online', (m) => m.users.includes(AI), 5000);
  console.log('[1] 在线成员 =', JSON.stringify(online.users), online.users.includes(AI) ? '✅ 大肥鱼常驻在线' : '❌');

  // 2) 未 @ 时不得插话
  alice.ws.send(JSON.stringify({ type: 'message', sender: 'Alice', content: 'Bob，今天这道算法题你做了吗？' }));
  await sleep(6000);
  const silent = alice.inbox.filter((m) => m.type === 'message' && m.message.sender === AI);
  console.log('[2] 未@时收到的大肥鱼消息数 =', silent.length, silent.length === 0 ? '✅ 未插话' : '❌ 竟然插话了');

  // 3) @ 大肥鱼 应触发回复
  const question = '@大肥鱼 JavaScript 里 typeof null 返回什么？为什么？';
  console.log('[3] Alice 提问:', question);
  alice.ws.send(JSON.stringify({ type: 'message', sender: 'Alice', content: question }));

  const typingOn = await alice.waitFor('typing', (m) => m.user === AI && m.on === true, 10000);
  console.log('[3] 收到「正在输入」提示 ✅', JSON.stringify(typingOn));

  const reply = await alice.waitFor('message', (m) => m.message.sender === AI, 90000);
  console.log('\n===== 大肥鱼 的回答 =====');
  console.log(reply.message.content);
  console.log('=========================\n');

  const typingOff = await alice.waitFor('typing', (m) => m.user === AI && m.on === false, 10000);
  console.log('[4] 回复后「正在输入」已关闭 ✅');

  // 5) 不能被冒充：客户端声称 sender=大肥鱼 应被拒绝
  const c1 = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  alice.ws.send(JSON.stringify({ type: 'message', sender: AI, content: '我是伪造的大肥鱼' }));
  await sleep(600);
  const c2 = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  console.log('[5] 冒充大肥鱼发消息，入库数 =', c2 - c1, c2 - c1 === 0 ? '✅ 被拒绝' : '❌ 被接受');

  // 6) AI 回复已持久化
  const row = db.prepare('SELECT sender, content FROM messages WHERE sender = ? ORDER BY id DESC LIMIT 1').get(AI);
  console.log('[6] 回复已存入数据库 ✅ sender =', row ? row.sender : '(无)');

  // 清理测试数据
  db.prepare('DELETE FROM messages WHERE id > ?').run(beforeMaxId);
  console.log('\n清理完成，剩余消息 =', db.prepare('SELECT COUNT(*) c FROM messages').get().c, '(初始', beforeCount + ')');

  const ok =
    online.users.includes(AI) &&
    silent.length === 0 &&
    reply.message.content.length > 0 &&
    c2 - c1 === 0 &&
    Boolean(row);

  console.log(ok ? '\n✅ AI 群成员功能全部通过' : '\n❌ 存在失败项');
  alice.ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('❌ 测试异常:', e.message); process.exit(1); });
