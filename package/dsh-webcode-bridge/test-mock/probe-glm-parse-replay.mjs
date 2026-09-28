// probe-glm-parse-replay.mjs — 用**生产解析器**逐条复算真实 GLM 回复（2026-09-27）。
//
// 数据来源：C:\Users\rsyhn\.dsh\logs\webcode-bridge-replies.glm.log
//   —— 桥自己落的**真实网页回复原文**（note=raw reply / raw thinking, verbatim），
//      每条头部都记了桥当时的读数 `calls=N`。
//
// 方法：把每条的正文喂给 **lib/agent-preset.js 的 parseAgentReply**（与线上同一函数），
//   把复算出的 calls 数与头部记录的 calls 对比。
//   · 一致  → 该条无异议；
//   · 复算 > 记录 → **当时丢了调用**（解析器本可以解出来但没解出/或流式没走到）；
//   · 复算 < 记录 → 解析器退化（更严重）。
//
// 这是「工具调用老是失败」这一用户观感的**可复现、可回归**的量化入口。
import fs from 'node:fs';
import { parseAgentReply } from '../lib/agent-preset.js';

const LOG = process.env.GLM_LOG
  || 'C:/Users/rsyhn/.dsh/logs/webcode-bridge-replies.glm.log';

// 与线上同形的工具表（够判定名字合法性即可）。
const TOOLS = ['read', 'pwsh', 'glob', 'grep', 'write', 'edit', 'present', 'todo_write']
  .map((n) => ({ name: n, parameters: { type: 'object' } }));

const raw = fs.readFileSync(LOG, 'utf8').split(/\r?\n/);
const recs = [];
let cur = null;
for (const l of raw) {
  if (l.startsWith('=== webcode-bridge raw reply ===')) {
    if (l.includes('|')) {
      if (cur) recs.push(cur);
      cur = {
        ts: (l.match(/\| ([\d\-T:.Z]+) \|/) || [])[1] || '',
        chars: Number((l.match(/chars=(\d+)/) || [])[1] || 0),
        calls: Number((l.match(/calls=(\d+)/) || [])[1] || 0),
        note: (l.match(/note=(.+)$/) || [])[1] || '',
        body: [],
      };
    } else { if (cur) { recs.push(cur); cur = null; } }
  } else if (cur) cur.body.push(l);
}
if (cur) recs.push(cur);

let disagreeLost = 0, disagreeShrunk = 0, agree = 0, recovered = 0;
const offenders = [];

recs.forEach((r, idx) => {
  const text = r.body.join('\n');
  const got = parseAgentReply(text, { tools: TOOLS });
  const mine = got.calls.length;
  const tag = `[${idx + 1}] ts=${r.ts} note=${r.note.replace(/, verbatim$/, '')} chars=${r.chars}`;
  if (mine === r.calls) { agree += 1; return; }
  if (mine > r.calls) {
    disagreeLost += 1;
    recovered += mine - r.calls;
    offenders.push({ tag, kind: 'LOST', logged: r.calls, reparse: mine, names: got.calls.map((c) => c.name) });
  } else {
    disagreeShrunk += 1;
    offenders.push({ tag, kind: 'SHRUNK', logged: r.calls, reparse: mine, names: got.calls.map((c) => c.name) });
  }
});

console.log('===== GLM 真实回复 × 生产解析器 逐条复算 =====');
console.log(`总记录 ${recs.length}｜一致 ${agree}｜复算多出(当时丢调用) ${disagreeLost}｜复算变少 ${disagreeShrunk}`);
console.log(`若按复算，可多解出 ${recovered} 个调用\n`);

for (const o of offenders) {
  console.log(`${o.kind.padEnd(6)} 记录时 calls=${o.logged} → 复算 calls=${o.reparse}  名字=${JSON.stringify(o.names)}`);
  console.log(`       ${o.tag}`);
}

// 形状归类：这些正文里到底写成了什么形状
console.log('\n===== 形状归类（正文里出现过的调用写法）=====');
const shapes = new Map();
for (const r of recs) {
  const t = r.body.join('\n');
  const shape =
    (/<tool_call>\s*[\w.-]+\s*\n\s*\{/.test(t) ? 'A. <tool_call>裸名+JSON (混合形状)' :
      /<tool_call>\s*\{/.test(t) ? 'B. <tool_call>{JSON}' :
        /```json/.test(t) ? 'C. ```json 围栏' :
          /"mcp_action"/.test(t) ? 'D. 裸 JSON（无围栏无标签）' : null);
  if (!shape) continue;
  const rec = shapes.get(shape) || { n: 0, lost: 0 };
  rec.n += 1;
  const mine = parseAgentReply(t, { tools: TOOLS }).calls.length;
  if (mine < r.calls || (mine === 0 && /"mcp_action"\s*:\s*"call"/.test(t))) rec.lost += 1;
  shapes.set(shape, rec);
}
for (const [k, v] of [...shapes].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(38)} 出现 ${String(v.n).padStart(3)} 条`);
}

console.log('\nREPLAY RESULT: done');
