// probe-glm-native-capture.mjs — chatglm.cn 原生工具调用**真实捕抓**（2026-09-27）。
//
// 只回答三个问题，全部以**真实 SSE 帧**为证据，不猜：
//
//   Q1 我们教的 ```json 代码块调用，网页把它变成了什么？
//      → 是 `content[].type === 'code'` 的结构化 part？还是 'text' 正文？
//        还是被站点原生工具层**截胡**成了它自己的 `tool_calls`？
//   Q2 站点原生工具层（它内置的 search/open/click/find）在哪些帧里出现？
//      形状是什么（tool_calls / tool_result 的字段全貌）？
//   Q3 我们能不能拦截它并转成本地结果？
//      → 取决于它是否**在页面侧执行**：若 tool_calls 帧之后直接跟着站点自己的
//        tool_result，说明执行发生在服务端，桥只能旁观；若页面在等客户端回包，
//        才有拦截空间。本探针把两种形态的**帧序列**如实打出来。
//
// 用法：
//   node test-mock/probe-glm-native-capture.mjs
//   $env:PROBE_PROMPT='...'; node test-mock/probe-glm-native-capture.mjs
//
// 铁律：这是**真实发送**（消耗一次 GLM web 额度，对话列表会多一条）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CAPTURE_DIR = process.env.PROBE_DIR
  || path.join(os.tmpdir(), 'glm-native-capture-' + Date.now());
fs.mkdirSync(CAPTURE_DIR, { recursive: true });
// ⚠ 必须在 import browser-driver **之前**设：它在模块加载时读这个变量。
process.env.WEBCODE_SSE_DEBUG = CAPTURE_DIR;

const SITE_ID = 'glm';
const PROFILE = process.env.PROBE_PROFILE
  || 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm';
const say = (...a) => console.log(...a);

// 工具表：与真实会话同形的单工具，减少形状歧义。
const TOOLS = [{
  name: 'pwsh',
  description: 'Run a PowerShell command on Windows and return its stdout.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The PowerShell command to run.' },
      description: { type: 'string', description: 'Short description of what the command does.' },
    },
    required: ['command', 'description'],
  },
}];

const SECRET = 'NQ' + Math.floor(Math.random() * 900 + 100);
const USER_ASK = process.env.PROBE_PROMPT
  || ('调用 pwsh 工具运行这条命令：Write-Output ' + SECRET + '。然后把命令的输出原样告诉我。');

// 动态 import：保证上面的 WEBCODE_SSE_DEBUG 已经就位。
const { createBrowserDriver } = await import('../lib/browser-driver.js');
const { serializeFirstTurn, parseAgentReply } = await import('../lib/agent-preset.js');

let driver = null;
try {
  driver = createBrowserDriver({
    siteId: SITE_ID, site: 'https://chatglm.cn/', profileDir: PROFILE, headless: true,
    requestTimeoutMs: 300_000, loginTimeoutMs: 300_000, logger: console,
  });
  const conn = await driver.connect();
  const st = driver.status();
  say(`[状态] ok=${conn?.ok} loggedIn=${conn?.loggedIn} basis=${st?.loginBasis}`);

  // 与真实会话**逐字同源**的首轮：含 glm 分支的代码块教学（transportNoteFor）。
  const prompt = serializeFirstTurn({
    system: 'You are a helpful assistant.',
    tools: TOOLS,
    siteId: SITE_ID,
    messages: [{ role: 'user', content: [{ type: 'text', text: USER_ASK }] }],
  });
  say(`\n[首轮] ${prompt.length} 字符（含 glm 代码块教学）`);
  say('[用户话] ' + USER_ASK);
  say('[期望 secret] ' + SECRET);

  const t0 = Date.now();
  const r = await driver.sendTurn('probe-glm-native-' + Date.now(), prompt,
    { fresh: true, model: 'glm:auto' });
  const ms = Date.now() - t0;
  const text = String(r?.text || '');
  say(`\n[完成] ${ms}ms  reason=${JSON.stringify(r?.reason ?? null)}`);
  say('[正文长度] ' + text.length);
  say('[正文] ' + JSON.stringify(text.slice(0, 1500)));
  say('[思考长度] ' + String(r?.thinking || '').length);

  // 桥自己的解析器对这段正文怎么判——与真实会话同一函数。
  const parsed = parseAgentReply(text, { tools: TOOLS });
  say('[桥解析] calls=' + parsed.calls.length + ' diagnostics=' + JSON.stringify(parsed.diagnostics ?? null));
  for (const c of parsed.calls) say('   call ' + c.name + ' args=' + String(c.arguments).slice(0, 200));

  await driver.close().catch(() => {});
  driver = null;

  // ---------------- 原始帧分析 ----------------
  say('\n===== 原始 SSE 帧分析 =====');
  say('[抓包目录] ' + CAPTURE_DIR);
  const files = fs.readdirSync(CAPTURE_DIR).filter((f) => f.startsWith('sse-'));
  if (!files.length) { say('⚠ 没抓到帧文件'); process.exit(0); }

  const typeStat = new Map();       // type -> {n, chars}
  const samples = new Map();        // type -> 第一条样本（完整字段）
  const seq = [];                   // 帧序列（只记 type 骨架）
  let frameNo = 0;

  for (const f of files) {
    const raw = fs.readFileSync(path.join(CAPTURE_DIR, f), 'utf8');
    say(`-- 文件 ${f}（${raw.length} 字符）`);
    // 抓包是原始 chunk 拼接，按 SSE 帧终结符切
    for (const frame of raw.split(/\r?\n\r?\n/)) {
      const dataLines = frame.split(/\r?\n/).filter((l) => l.startsWith('data:'));
      if (!dataLines.length) continue;
      const data = dataLines.map((l) => l.slice(5).trimStart()).join('\n');
      let j; try { j = JSON.parse(data); } catch { continue; }
      frameNo += 1;
      const parts = Array.isArray(j.parts) ? j.parts : [];
      const kinds = [];
      for (const p of parts) {
        if (!p || !Array.isArray(p.content)) continue;
        for (const c of p.content) {
          if (!c || typeof c !== 'object') continue;
          const type = String(c.type || '(empty)');
          const payload = typeof c.text === 'string' ? c.text
            : typeof c.code === 'string' ? c.code
              : typeof c.think === 'string' ? c.think : '';
          const rec = typeStat.get(type) || { n: 0, chars: 0 };
          rec.n += 1; rec.chars += payload.length;
          typeStat.set(type, rec);
          if (!samples.has(type)) samples.set(type, { frameNo, part: p, content: c });
          kinds.push(type + (payload ? '(' + payload.length + ')' : ''));
          // 原生工具帧：全文打印（这是 Q1/Q2/Q3 的核心证据）
          if (type === 'tool_calls' || type === 'tool_result' || type === 'code'
            || type === 'quote_result' || type === 'execution_output') {
            say(`\n  【帧#${frameNo} type=${type}】`);
            say('   content=' + JSON.stringify(c).slice(0, 2000));
          }
        }
      }
      if (kinds.length) seq.push('#' + frameNo + ':' + kinds.join('|'));
    }
  }

  say('\n----- content[].type 分布 -----');
  for (const [t, r] of [...typeStat].sort((a, b) => b[1].n - a[1].n)) {
    say('  ' + t.padEnd(18) + ' 帧=' + String(r.n).padStart(5) + ' 字符=' + String(r.chars).padStart(8));
  }

  say('\n----- 各 type 首条样本全字段 -----');
  for (const [t, s] of samples) {
    say('  [' + t + '] frame#' + s.frameNo);
    say('    part=' + JSON.stringify(s.part).slice(0, 900));
    say('    content=' + JSON.stringify(s.content).slice(0, 900));
  }

  say('\n----- 帧序列（前 120 帧）-----');
  for (const s of seq.slice(0, 120)) say('  ' + s);

  say('\n[secret 是否出现在正文] ' + text.includes(SECRET));
  say('PROBE RESULT: done');
} catch (err) {
  say('\nPROBE FAIL: ' + String(err?.message || err));
  say(String(err?.stack || '').split('\n').slice(0, 6).join('\n'));
  process.exitCode = 1;
} finally {
  try { await driver?.close?.(); } catch { /* 已关 */ }
}
