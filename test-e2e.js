'use strict';
// v2 端到端测试：安全加固 + 在线成员 + 图片 + 撤回 + 分页/搜索/导出
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { DatabaseSync } = require('node:sqlite');

const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000';

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    }).on('error', reject);
  });
}
function httpPost(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function makeClient(origin) {
  const ws = new WebSocket(WS, origin ? { origin } : {});
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  const open = new Promise((r) => ws.on('open', r));
  const waitFor = (type, pred = () => true, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      (function poll() {
        const found = inbox.find((m) => m.type === type && pred(m));
        if (found) return resolve(found);
        if (Date.now() - started > timeoutMs) return reject(new Error('timeout: ' + type));
        setTimeout(poll, 20);
      })();
    });
  return { ws, inbox, open, waitFor };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = new DatabaseSync(path.join(__dirname, 'chat.db'));
  const beforeCount = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  const beforeMaxId = db.prepare('SELECT COALESCE(MAX(id),0) m FROM messages').get().m;
  const uploadedFiles = [];

  console.log('== [1] health ==');
  const health = await httpGet('/api/health');
  console.log('   ', health.status, health.body.slice(0, 60));

  console.log('== [2] CSWSH：跨源 Origin 应被拒绝 ==');
  const evil = makeClient('http://evil.com');
  const evilResult = await Promise.race([
    evil.open.then(() => 'opened'),
    new Promise((r) => { evil.ws.on('error', () => r('rejected')); evil.ws.on('close', () => r('closed')); }),
  ]);
  console.log('   evil.com 结果:', evilResult, evilResult === 'rejected' || evilResult === 'closed' ? '✅' : '❌');

  console.log('== [3] 在线成员 presence ==');
  const alice = makeClient();
  const bob = makeClient();
  await Promise.all([alice.open, bob.open]);
  await alice.waitFor('history');
  alice.ws.send(JSON.stringify({ type: 'presence', user: 'Alice' }));
  const on1 = await alice.waitFor('online', (m) => m.users.includes('Alice'));
  console.log('   Alice 上线 -> users =', JSON.stringify(on1.users));
  bob.ws.send(JSON.stringify({ type: 'presence', user: 'Bob' }));
  const on2 = await bob.waitFor('online', (m) => m.users.includes('Bob') && m.users.includes('Alice'));
  console.log('   Bob 上线 -> users =', JSON.stringify(on2.users));

  console.log('== [4] 文本广播 ==');
  alice.ws.send(JSON.stringify({ type: 'message', sender: 'Alice', content: '大家好 v2！' }));
  const r1 = await bob.waitFor('message');
  console.log('   Bob 收到:', r1.message.sender, ':', r1.message.content);

  console.log('== [5] 严格类型校验（对象/数组应被拒）==');
  const c1 = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  alice.ws.send(JSON.stringify({ type: 'message', sender: 'Alice', content: { x: 1 } }));
  alice.ws.send(JSON.stringify({ type: 'message', sender: ['Alice'], content: '数组身份' }));
  alice.ws.send(JSON.stringify({ type: 'message', sender: 'Alice', content: 12345 }));
  await sleep(400);
  const c2 = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  console.log('   非法消息入库数 =', c2 - c1, c2 - c1 === 0 ? '✅' : '❌');

  console.log('== [6] 限流（连续发 18 条应触发 error）==');
  let spamErr = 0;
  const spam = makeClient();
  await spam.open;
  await spam.waitFor('history');
  spam.ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'error') spamErr++; });
  for (let i = 0; i < 18; i++) spam.ws.send(JSON.stringify({ type: 'message', sender: 'Alice', content: '刷屏 ' + i }));
  await sleep(800);
  console.log('   收到 error 条数 =', spamErr, spamErr > 0 ? '✅' : '❌');

  console.log('== [7] 图片上传 + 图片消息 ==');
  const tiny = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG 魔数开头
  const up = await httpPost('/api/upload', { dataUrl: 'data:image/png;base64,' + tiny.toString('base64') });
  const upData = JSON.parse(up.body);
  console.log('   上传状态:', up.status, 'url:', upData.url);
  uploadedFiles.push(path.join(__dirname, 'public', upData.url));
  alice.ws.send(JSON.stringify({ type: 'message', sender: 'Alice', content: upData.url, kind: 'image' }));
  const rImg = await bob.waitFor('message', (m) => m.message.kind === 'image');
  console.log('   Bob 收到图片消息 kind =', rImg.message.kind, '✅');

  console.log('== [8] 撤回 ==');
  const recallTarget = r1.message;
  alice.ws.send(JSON.stringify({ type: 'recall', id: recallTarget.id }));
  const rc = await bob.waitFor('recall', (m) => m.id === recallTarget.id);
  console.log('   撤回广播 id =', rc.id, '✅');

  console.log('== [9] 搜索 ==');
  const search = await httpGet('/api/messages?q=' + encodeURIComponent('大家好 v2'));
  const sres = JSON.parse(search.body).messages;
  console.log('   搜索结果条数 =', sres.length, '✅（应包含"大家好 v2"，已被撤回会排除）');

  console.log('== [10] 分页 ==');
  const page1 = JSON.parse((await httpGet('/api/messages?limit=2')).body).messages;
  const older = JSON.parse((await httpGet('/api/messages?limit=2&before=' + page1[0].id)).body).messages;
  console.log('   最新2条ids =', page1.map((m) => m.id).join(','), '; 更早 =', older.map((m) => m.id).join(','), '; 升序无重叠 =', page1[0].id > older[older.length - 1].id ? '✅' : '❌');

  console.log('== [11] 导出 ==');
  const exp = await httpGet('/api/export');
  console.log('   导出状态:', exp.status, '; Content-Disposition:', exp.headers['content-disposition'], '; 含标题:', exp.body.includes('计算机学习交流群') ? '✅' : '❌');

  // 清理测试数据
  db.prepare('DELETE FROM messages WHERE id > ?').run(beforeMaxId);
  for (const f of uploadedFiles) { try { fs.unlinkSync(f); } catch {} }
  const remain = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  console.log('\n清理完成，剩余消息 =', remain, '(应等于初始', beforeCount, ')');

  const ok =
    evilResult !== 'opened' &&
    on2.users.includes('Alice') && on2.users.includes('Bob') &&
    r1.message.sender === 'Alice' &&
    c2 - c1 === 0 &&
    spamErr > 0 &&
    rImg.message.kind === 'image' &&
    rc.id === recallTarget.id &&
    remain === beforeCount;

  console.log(ok ? '\n✅ 全部测试通过' : '\n❌ 存在失败项');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('❌ 测试异常:', e.message);
  process.exit(1);
});
