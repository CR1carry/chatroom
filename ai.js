'use strict';

const fs = require('fs');
const path = require('path');

// AI 群成员
const AI_USER = '大肥鱼';

const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
// 默认用推理模型：事实/语言行为类问题准确率明显高于 deepseek-chat
// 想换回普通模型：启动时设置环境变量 AI_MODEL=deepseek-chat
const AI_MODEL = process.env.AI_MODEL || 'deepseek-reasoner';
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 120000;

// 系统提示词：客观准确、不闲聊、不主动插话
const SYSTEM_PROMPT = [
  '你是「大肥鱼」，是「计算机学习交流群」里的一名 AI 群成员。群里还有三位人类成员：Alice、Bob、Charlie。',
  '',
  '回答准则：',
  '1. 准确性是第一原则。只陈述你确定的事实；不确定就明确说“不确定”，绝不编造事实、数据、文献、链接或 API 名称。',
  '2. 涉及编程语言 / API / 库的具体行为时，作答前先核对一遍再下结论，避免把相似概念混淆。',
  '3. 计算机/编程类问题要给出正确、可直接使用的答案；代码要完整可运行，并说明关键点。',
  '4. 如果问题有歧义，先按最合理的理解作答，并简要说明你的理解。',
  '5. 回答简洁，一般不超过 300 字；问题确实复杂时可适当展开，但不要啰嗦。',
  '6. 始终用中文回答。',
  '7. 只回答被问到的问题。不要闲聊、不要评价其他群成员、不要复述无关的聊天内容。',
  '8. 客户端是纯文本显示，不要使用 Markdown 语法（如 **加粗**、```代码块```、表格）。需要分点时用“1. 2. 3.”或短横线，代码直接换行书写。',
].join('\n');

// API Key 解析：环境变量 -> 项目内 ai-key.txt
function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) {
    return process.env.DEEPSEEK_API_KEY.trim();
  }
  try {
    const p = path.join(__dirname, 'ai-key.txt');
    if (fs.existsSync(p)) {
      const k = fs.readFileSync(p, 'utf8').trim();
      if (k) return k;
    }
  } catch {
    /* 忽略读取异常 */
  }
  return null;
}

function hasApiKey() {
  return Boolean(resolveApiKey());
}

// 调用大模型（OpenAI 兼容接口）
async function askAi(history) {
  const key = resolveApiKey();
  if (!key) {
    const err = new Error('未配置 DEEPSEEK_API_KEY 或 ai-key.txt');
    err.code = 'NO_KEY';
    throw err;
  }

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        // 低温度，保证客观稳定
        temperature: 0.2,
        max_tokens: 1500,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim()
      : '';
    if (!text) throw new Error('模型返回为空');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`请求超时（${AI_TIMEOUT_MS}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { AI_USER, askAi, hasApiKey, resolveApiKey, AI_MODEL };
