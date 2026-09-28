// probe-glm-stream-withhold.mjs — 混合形状在**流式扣留**路径上的行为（2026-09-27）。
//
// 解析器修好后还要确认第二件事：这段协议原文在**流式外发**时会不会先当正文泄进 UI。
// 线上路径是 index.js 的：
//     findProtocolStart(acc) → proseSafeEnd(acc, sent) → withheld = len - proseSafeEnd
// 只有 withheld > 0 才谈得上「扣住协议 + 触发补发提醒」；扣不住就是「用户看到一坨原始
// JSON，而模型以为已经调用过了」——那正是 doc/research 里记过的泄漏事故形态。
import { findProtocolStart, proseSafeEnd, parseAgentReply } from '../lib/agent-preset.js';

const HYBRID = '<tool_call>pwsh\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "列出目录", '
  + '"arguments": {"command": "Get-ChildItem", "description": "list"}}\n'
  + '```';

const HYBRID_TWO = '我先看看结构。'
  + '<tool_call>pwsh\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "列出目录", '
  + '"arguments": {"command": "Get-ChildItem", "description": "list"}}\n'
  + '```'
  + '<tool_call>glob\n'
  + '{"mcp_action": "call", "name": "glob", "purpose": "找 SVG", '
  + '"arguments": {"pattern": "**/*.svg"}}\n'
  + '```';

const CASES = [
  ['混合形状（单调用）', HYBRID],
  ['混合形状（前置散文 + 两个调用）', HYBRID_TWO],
];

for (const [label, text] of CASES) {
  console.log('===== ' + label + ' =====');
  const start = findProtocolStart(text, 0);
  const safe = proseSafeEnd(text, 0);
  const withheld = text.length - safe;
  console.log(`  长度=${text.length}`);
  console.log(`  findProtocolStart.index=${start.index} transport=${start.transport}`);
  console.log(`  proseSafeEnd=${safe}  扣留=${withheld}`);
  const r = parseAgentReply(text, { tools: [{ name: 'pwsh' }, { name: 'glob' }] });
  console.log(`  parseAgentReply calls=${r.calls.length} names=${JSON.stringify(r.calls.map((c) => c.name))}`);
  console.log(`  结论: ${withheld > 0 ? '协议被扣住（不会当正文泄漏）' : '⚠ 未扣住——协议原文会外发'}`);
  if (withheld > 0) console.log(`  外发的正文 = ${JSON.stringify(text.slice(0, safe))}`);
  console.log('');
}

// 流式逐字符推进：每个前缀都必须「要么还没到协议，要么已扣住」。
console.log('===== 流式逐字符推进（模拟增量）=====');
for (const [label, text] of CASES) {
  let leaked = 0;
  let firstWithholdAt = -1;
  for (let i = 1; i <= text.length; i++) {
    const acc = text.slice(0, i);
    const safe = proseSafeEnd(acc, 0);
    if (safe < acc.length) { if (firstWithholdAt < 0) firstWithholdAt = i; continue; }
    leaked = i;
  }
  console.log(`  ${label}: 最后一个「全部外发」的前缀长度=${leaked}`
    + `，首次扣留发生在第 ${firstWithholdAt} 字符`);
  const leakedText = text.slice(0, leaked);
  const bad = leakedText.includes('mcp_action') || leakedText.includes('```');
  console.log(`    泄漏的前缀 = ${JSON.stringify(leakedText)}`);
  console.log(`    ${bad ? '✖ 协议原文泄漏' : '✔ 未泄漏协议原文'}`);
}
console.log('\nRESULT: done');
