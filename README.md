# 计算机学习交流群 — 在线聊天室

基于 **Node.js + Express + WebSocket(ws) + SQLite(node:sqlite)** 的在线聊天室，零原生依赖（Node ≥ 22.5 内置 SQLite）。

## 功能

### 基础
- 预置三个固定用户 **Alice / Bob / Charlie**，进入页面后按钮切换当前身份
- 群名：**计算机学习交流群**
- 文字消息实时收发（WebSocket，无需刷新），显示发送人、内容、时间
- 聊天记录持久化到 SQLite（`chat.db`），重启不丢失
- 多窗口同步，支持开 3 个窗口分别模拟三人

### 安全加固（v2）
- ✅ SQL 全参数化（防注入）、前端全 `textContent` 渲染（防 XSS）
- ✅ WebSocket **Origin 校验**（防跨站 WebSocket 劫持 CSWSH）
- ✅ 每连接**速率限制**（5 秒 15 条，防刷屏/DoS）
- ✅ 严格类型校验（拒绝对象/数字等非字符串消息）
- ✅ `maxPayload` 16KB（防超大帧内存 DoS）
- ✅ 写库异常 try/catch（写库失败不崩溃）
- ✅ 数据库自动清理（保留最近 10000 条）

### 消息体验
- 😊 表情快捷面板
- @ 提醒（输入 `@` 弹出候选，@自己会高亮）
- 🖼️ 图片发送（点击按钮或直接 Ctrl+V 粘贴，点击图片放大）
- 撤回消息（悬停自己消息 → 撤回）
- 复制消息、链接自动识别为可点击链接

### 在线成员
- 右侧成员面板，实时显示 Alice/Bob/Charlie 的在线状态
- 进群 / 退群不再向聊天框插入系统提示

### 🤖 AI 群成员：大肥鱼
- 群里的第 4 位成员，**常驻在线**；**不是可选身份**（身份只能选 Alice / Bob / Charlie）
- 只有被 `@大肥鱼` 时才发言；没有被 @ 时**完全不参与**群成员之间的对话
- 基于大模型回答，追求客观准确（默认 `deepseek-reasoner`）
- 回答会持久化到数据库，刷新 / 重连后依然可见
- 回答期间聊天框上方显示「大肥鱼 正在输入…」

## 配置 AI（大肥鱼）

大肥鱼需要一个大模型 API Key（默认走 DeepSeek 官方接口）。

**方式一：写入文件（推荐）**

```bash
# 在项目根目录新建 ai-key.txt，把 Key 作为唯一一行内容
C:\Users\CR1\chatroom\ai-key.txt
```

**方式二：环境变量**

```powershell
$env:DEEPSEEK_API_KEY = "sk-xxxx"
npm start
```

可选环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AI_MODEL` | `deepseek-reasoner` | 换成 `deepseek-chat` 可更快、更省 |
| `AI_BASE_URL` | `https://api.deepseek.com` | 兼容 OpenAI 协议的其他服务 |
| `AI_TIMEOUT_MS` | `120000` | 单次请求超时 |

> 未配置 Key 时，大肥鱼仍会显示在线，被 @ 时提示「未配置大模型 API Key」。
> `ai-key.txt` 已加入 `.gitignore`，不会被提交。

### 历史记录
- 向上滚动**分页加载**更早消息
- 消息按「今天 / 昨天 / 日期」分组
- 🔍 聊天记录搜索、📥 导出为 txt

### 界面
- 🌙 深色模式（记忆偏好）
- 移动端自适应
- 消息入场动画、@自己高亮动效

## 运行

```bash
cd C:\Users\CR1\chatroom
npm install
npm start        # 默认 http://localhost:3000，可用 PORT=8080 覆盖
```

模拟三人：开 3 个浏览器窗口访问 <http://localhost:3000>，分别选 Alice / Bob / Charlie。

## 目录结构

```
chatroom/
├── server.js           # 后端：Express + WebSocket + SQLite（含迁移/安全加固）
├── ai.js               # AI 群成员「大肥鱼」：API Key 解析 + 提示词 + 模型调用
├── ai-key.txt          # 大模型 API Key（自己创建，已 gitignore）
├── package.json
├── chat.db             # SQLite 数据库（自动生成）
├── test-e2e.js         # 端到端测试（非破坏性）
├── test-ai.js          # AI 群成员功能测试（会消耗模型额度）
├── public/
│   ├── index.html      # 页面结构
│   ├── style.css       # 样式（深色模式/响应式/动画）
│   ├── app.js          # 前端逻辑
│   └── uploads/        # 上传的图片（自动创建）
└── README.md
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/messages?limit=&before=&q=` | 历史消息（分页/搜索） |
| GET | `/api/export` | 导出聊天记录为 txt |
| POST | `/api/upload` | 图片上传（base64 dataURL） |
| GET | `/api/health` | 健康检查 |
| WS | `/` | 实时通信（presence / message / recall / typing / online） |

> 向服务端发送 `message` 时，若文本包含 `@大肥鱼`，服务端会自动生成大肥鱼的回复并广播。
> 客户端**不能**伪造 `sender: "大肥鱼"`（服务端只接受 Alice/Bob/Charlie）。

## 消息表结构

`messages(id, sender, content, kind, created_at, deleted)` — `kind` 为 `text`/`image`，`deleted` 标记撤回。
