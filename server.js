'use strict';

/**
 * Dify 简历优化工具 —— Node 中转服务
 *
 * 作用：浏览器永远只跟这台服务器说话，Dify 的 API Key 只存在服务器环境变量里，
 *      前端 JS 抓包也看不到密钥。
 *
 * 环境变量：
 *   PORT            监听端口（部署平台会自动注入，本地默认 3000）
 *   DIFY_BASE       Dify API 地址，云端是 https://api.dify.ai/v1，自建填 你的域名/v1
 *   DIFY_API_KEY    工作流应用的 API 密钥（应用内「访问 API」里创建，不是管理员密钥）
 *   DEMO            设为 1 时走演示模式，不调用 Dify，返回假结果（用于先看界面）
 */

const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DIFY_BASE = String(process.env.DIFY_BASE || 'https://api.dify.ai/v1').replace(/\/+$/, '');
const DIFY_KEY = String(process.env.DIFY_API_KEY || '').trim();
const DEMO = String(process.env.DEMO || '') === '1';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const FILE_LIMIT_MB = 25;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/* ------------------------------ 小工具 ------------------------------ */

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function oneLine(v) {
  if (v === undefined || v === null) return '';
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s.trim() : String(s);
}

/** 把 outputs 拆成「文本」和「文件」两部分，Dify 不同版本的文件输出格式不一样，这里都兜住 */
function splitOutputs(outputs) {
  const texts = [];
  const files = [];
  const seen = new Set();

  const pushFile = (url, name, type) => {
    if (!url || typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    files.push({ name: name || '文件', url, type: type || '' });
  };

  const walk = (key, val) => {
    if (val === null || val === undefined) return;

    if (typeof val === 'string') {
      const t = val.trim();
      // 纯链接 → 当文件处理
      if (/^https?:\/\/[^\s]+$/i.test(t) && /\.(docx?|pdf|png|jpe?g|xlsx?|pptx?|md|txt|zip)(\?|$)/i.test(t)) {
        const raw = t.split('?')[0].split('/').pop() || key;
        pushFile(t, decodeURIComponent(raw), '');
      } else if (t) {
        texts.push({ key, text: t });
      }
      return;
    }

    if (Array.isArray(val)) {
      val.forEach((item, i) => walk(val.length > 1 ? `${key}[${i + 1}]` : key, item));
      return;
    }

    if (typeof val === 'object') {
      // Dify 常见的几种文件对象形状
      const url = val.url || val.remote_url || val.download_url || val.src;
      if (url) {
        pushFile(url, val.filename || val.name || val.filename_ext || key, val.type || val.extension || '');
        return;
      }
      if (Array.isArray(val.files)) {
        walk(key, val.files);
        return;
      }
      const s = JSON.stringify(val, null, 2);
      if (s && s !== '{}') texts.push({ key, text: s });
    }
  };

  Object.entries(outputs || {}).forEach(([k, v]) => walk(k, v));
  return { texts, files };
}

/* ------------------------------ CORS ------------------------------
 * 如果前端（静态托管）和后端（云托管）是两个域名，浏览器会跨域。
 * 默认放开 *，只在你需要用 Cookie 时才需要收紧。
 */
const ALLOW_ORIGIN = String(process.env.ALLOW_ORIGIN || '*');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ------------------------------ 首页 ------------------------------
 * 页面就一个 index.html，CDN 资源走外链，不需要一整个静态目录。
 * 只把这一个文件发出去，server.js / package.json / 环境变量都不会被外部读到。
 * 兼容两种放法：仓库根目录，或者 public/ 子目录。
 */
const HTML_PATH = require('fs').existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public', 'index.html')
  : path.join(__dirname, 'index.html');

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(HTML_PATH);
});



/* ------------------------------ 健康检查 ------------------------------ */

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    demo: DEMO,
    configured: Boolean(DIFY_KEY),
    difyBase: DIFY_BASE,
    time: new Date().toISOString(),
  });
});

/* --------------------- 读 Dify 工作流的真实入参 ---------------------
 * 用来核对变量名/类型，避免再出现「变量名对不上」这种来回猜。
 * 没配密钥或网络不通时返回 ok:false，前端提示但不阻塞。
 */
app.get('/api/parameters', async (req, res) => {
  if (!DIFY_KEY) return res.json({ ok: false, reason: '服务器没有配置 DIFY_API_KEY' });
  try {
    const r = await fetch(`${DIFY_BASE}/parameters`, {
      headers: { Authorization: `Bearer ${DIFY_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.json({ ok: false, reason: `Dify 返回 ${r.status}：${j.message || ''}` });

    const vars = (j.user_input_form || []).map((item) => {
      const type = Object.keys(item)[0];
      const v = item[type];
      return {
        name: v.variable,
        label: v.label,
        type,
        required: Boolean(v.required),
        maxLength: v.max_length,
      };
    });
    res.json({ ok: true, vars });
  } catch (e) {
    res.json({ ok: false, reason: `连不上 Dify：${e.message}` });
  }
});

/* ---------------------- 上传单个文件到 Dify ---------------------- */

async function uploadToDify(file, user) {
  const form = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });
  form.append('file', blob, file.originalname || 'upload');
  form.append('user', user);

  const r = await fetch(`${DIFY_BASE}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DIFY_KEY}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`上传「${file.originalname}」到 Dify 失败（${r.status}）：${j.message || JSON.stringify(j)}`);
  }
  if (!j.id) throw new Error(`上传「${file.originalname}」没有拿到文件 ID：${JSON.stringify(j)}`);
  return j.id;
}

/* ------------------------ 真正跑工作流（SSE 透传） ------------------------
 * Dify 的响应模式只有 blocking / streaming 两种。
 * 简历优化这条路要跑 LLM + 转文件，耗时可能好几分钟，blocking 容易被网关掐断，
 * 所以这里统一用 streaming：服务器读 Dify 的事件流，一边转发进度给浏览器，
 * 一边攒结果，最后把 outputs 拆成文本 + 文件返回。
 */
app.post('/api/run-workflow', upload.any(), async (req, res) => {
  const userId = `web-${Date.now()}`;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;   // 浏览器断开
  let ended = false;    // 响应已结束，保证 res.end() 只调一次
  const send = (obj) => {
    if (closed || ended) return;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // 心跳：防止中间网关把长连接当空闲掐掉
  const heartbeat = setInterval(() => {
    if (closed || ended) return;
    res.write(': ping\n\n');
  }, 15000);

  const finish = () => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      /* 连接已经没了，忽略 */
    }
  };

  // 注意：监听 res 的 close，而不是 req 的 —— req 的 close 在请求体读完后就会触发，
  // 用它当"浏览器断开"会把正常请求误判成断开，导致响应永远不结束。
  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  try {
    const files = req.files || [];

    if (!DIFY_KEY && !DEMO) {
      send({ type: 'error', message: '服务器没有配置 DIFY_API_KEY，请在部署平台上添加这个环境变量后重新部署。' });
      return finish();
    }

    if (!DEMO) {
      send({ type: 'log', message: '开始处理…' });
    }

    /* ---------- 演示模式：不调 Dify，直接回一份假结果 ---------- */
    if (DEMO) {
      send({ type: 'log', message: '[演示] 未连接 Dify，仅演示界面流程' });
      await new Promise((r) => setTimeout(r, 600));
      send({ type: 'node', title: '演示节点 1/3', status: 'running' });
      await new Promise((r) => setTimeout(r, 900));
      send({ type: 'node', title: '演示节点 1/3', status: 'succeeded' });
      send({ type: 'node', title: '演示节点 2/3', status: 'running' });
      await new Promise((r) => setTimeout(r, 900));
      send({ type: 'node', title: '演示节点 2/3', status: 'succeeded' });
      send({
        type: 'done',
        text: [
          { key: 'text', text: '（演示模式）这里会显示 Dify 工作流返回的优化结果文本。\n\n配置好 DIFY_BASE 和 DIFY_API_KEY 之后，这段就是真实的简历改写内容。' },
        ],
        files: [],
        raw: {},
      });
      return finish();
    }

    /* ---------- 1. 文件逐个上传，换 upload_file_id ---------- */
    const inputs = {};

    const textMap = {
      JD_lianjie: oneLine(req.body.JD_lianjie),
      JD_name: oneLine(req.body.JD_name),
      JL_output_type: oneLine(req.body.JL_output_type) || 'docx',
      JL_example: oneLine(req.body.JL_example),
    };

    for (const [k, v] of Object.entries(textMap)) {
      if (v) inputs[k] = v;
    }

    for (const f of files) {
      if (!f || !f.buffer || !f.buffer.length) continue;
      send({ type: 'log', message: `上传文件：${f.originalname}（${(f.size / 1024 / 1024).toFixed(1)} MB）` });
      const id = await uploadToDify(f, userId);
      inputs[f.fieldname] = {
        type: 'document',
        transfer_method: 'local_file',
        upload_file_id: id,
      };
      send({ type: 'log', message: `文件已就位：${f.fieldname} → ${id}` });
    }

    send({ type: 'log', message: `提交工作流，入参：${Object.keys(inputs).join('、') || '（无）'}` });

    /* ---------- 2. 调工作流，streaming 模式 ---------- */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

    let resp;
    try {
      resp = await fetch(`${DIFY_BASE}/workflows/run`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${DIFY_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs, response_mode: 'streaming', user: userId }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      send({
        type: 'error',
        message:
          e.name === 'AbortError'
            ? '连接 Dify 超时（10 分钟）'
            : `连不上 Dify（${DIFY_BASE}）：${e.message}。检查 DIFY_BASE 是否带 /v1、服务器能否访问外网。`,
      });
      return finish();
    }

    if (!resp.ok) {
      clearTimeout(timer);
      const body = await resp.text().catch(() => '');
      send({
        type: 'error',
        message: `Dify 拒绝请求（${resp.status}）：${body.slice(0, 500)}`,
        hint:
          resp.status === 401
            ? 'API Key 不对，或者用了管理员密钥。要用应用内「访问 API」里的那个密钥。'
            : resp.status === 400
            ? '多半是变量名/类型对不上：文件变量必须传 upload_file_id，文本变量必须传字符串。'
            : '',
      });
      return finish();
    }

    /* ---------- 3. 读事件流 ---------- */
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let outputs = null;
    let runStatus = '';
    let errored = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop() || '';

      for (const chunk of chunks) {
        const dataLines = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;

        const payload = dataLines.join('\n');
        if (!payload || payload === '[DONE]') continue;

        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }

        const d = evt.data || {};

        if (evt.event === 'node_started') {
          send({ type: 'node', title: d.title || d.node_type || '节点', status: 'running' });
        } else if (evt.event === 'node_finished') {
          send({
            type: 'node',
            title: d.title || d.node_type || '节点',
            status: d.status === 'failed' ? 'failed' : 'succeeded',
            elapsed: d.elapsed_time,
          });
        } else if (evt.event === 'workflow_finished') {
          outputs = d.outputs || {};
          runStatus = d.status || '';
          if (d.error) errored = d.error;
        } else if (evt.event === 'error') {
          errored = d.message || evt.message || '工作流执行出错';
        }
      }
    }

    clearTimeout(timer);

    if (errored) {
      send({ type: 'error', message: `工作流报错：${errored}` });
      return finish();
    }

    if (!outputs) {
      send({ type: 'error', message: `工作流没有返回输出（status=${runStatus || '未知'}）` });
      return finish();
    }

    const { texts, files: outFiles } = splitOutputs(outputs);
    if (!texts.length && !outFiles.length) {
      send({
        type: 'error',
        message: '工作流跑完了，但 outputs 是空的。去 Dify 确认终点节点的输出变量有没有勾选。',
      });
      return finish();
    }

    send({ type: 'done', text: texts, files: outFiles, raw: outputs });
    finish();
  } catch (e) {
    send({ type: 'error', message: `服务器内部错误：${e.message}` });
    finish();
  }
});

/* ---------------------- multer 错误兜底 ---------------------- */

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    if (res.headersSent) return res.end();
    return res.status(413).json({ error: `文件超过 ${FILE_LIMIT_MB} MB，请压缩后再传。` });
  }
  console.error('[error]', err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: String(err && err.message ? err.message : err) });
});

/* 未匹配的 /api 路径返回 JSON，别让静态兜底把 HTML 塞回去 */
app.use('/api', (req, res) => {
  res.status(404).json({ error: `接口不存在：${req.method} ${req.originalUrl}` });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`服务已启动：http://0.0.0.0:${PORT}`);
  console.log(`Dify 地址：${DIFY_BASE}`);
  console.log(`API Key：${DIFY_KEY ? '已配置' : '未配置'}${DEMO ? '（演示模式）' : ''}`);
});
