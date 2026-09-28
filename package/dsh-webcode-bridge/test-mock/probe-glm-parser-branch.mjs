// probe-glm-parser-branch.mjs — 定位 GLM 两种形状各自命中哪个解析分支（2026-09-27）。
//
// 目的：把「混合形状丢调用」与「原生模板重复出调用」这两条，钉到**具体分支**上，
// 这样修复可以只动那一支，不动 deepseek 官方模板路径。
import { parseAgentReply } from '../lib/agent-preset.js';
import { readCallAt } from '../lib/agent-preset.js';

const TOOLS = ['read', 'pwsh', 'glob', 'grep', 'write', 'edit']
  .map((n) => ({ name: n, parameters: { type: 'object' } }));

const HYBRID = '<tool_call>pwsh\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "列出目录", "arguments": {"command": "Get-ChildItem", "description": "list"}}\n'
  + '```';

const NATIVE = '<tool_call>pwsh\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "列出目录", "arguments": {"command": "Get-ChildItem", "description": "list"}}'
  + '</tool_call>';

function report(label, s) {
  console.log('===== ' + label + ' =====');
  console.log('原文: ' + JSON.stringify(s));
  const r = parseAgentReply(s, { tools: TOOLS });
  console.log('calls=' + r.calls.length);
  r.calls.forEach((c, i) => {
    console.log(`  [${i}] name=${c.name} purpose=${JSON.stringify(c.purpose ?? null)}`);
    console.log(`      arguments=${JSON.stringify(c.arguments)}`);
  });
  if (r.diagnostics.length) console.log('  diagnostics=' + JSON.stringify(r.diagnostics));

  // --- 逐分支手算 ---
  // ① bareNameRe 分支的守卫：JSON 之后必须是 </tool_call>
  const bareNameRe = /<\s*(?:tool_call|function)\s*>\s*([\w.$-]+)\s*/gi;
  let m;
  while ((m = bareNameRe.exec(s)) !== null) {
    const hit = readCallAt(s, m.index + m[0].length);
    const tail = hit ? s.slice(hit.end) : '';
    const guardOk = /^\s*<\s*\/\s*(?:tool_call|function)\s*>/i.test(tail);
    console.log(`  ① bareNameRe 裸名分支: 名字=${m[1]} JSON配平=${Boolean(hit)} 后接闭标签=${guardOk}`
      + (guardOk ? '' : '  ⇒ 守卫拒绝，调用被丢'));
    if (hit) {
      try {
        const whole = JSON.parse(hit.raw);
        console.log(`     该分支会把**整个对象**当 arguments 传入: keys=${JSON.stringify(Object.keys(whole))}`);
      } catch { /* ignore */ }
    }
  }
  // ② bareObjRe 分支
  const bareObjRe = /(\{\s*"mcp_action"\s*:\s*"call"[\s\S]*?\})\s*(?=<|$)/gi;
  let n2 = 0;
  while ((m = bareObjRe.exec(s)) !== null) { n2 += 1; console.log(`  ② bareObjRe 命中 #${n2}`); }
  if (!n2) console.log('  ② bareObjRe 未命中');
  console.log('');
}

report('混合形状（真实流量 记录[11]）', HYBRID);
report('原生模板形状（agent-preset 声称已支持）', NATIVE);
