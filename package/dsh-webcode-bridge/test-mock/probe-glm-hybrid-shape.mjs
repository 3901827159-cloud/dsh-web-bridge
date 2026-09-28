// probe-glm-hybrid-shape.mjs — 钉死 GLM「混合形状」调用为何被丢（2026-09-27）。
//
// 真实样本**逐字**取自 C:\Users\rsyhn\.dsh\logs\webcode-bridge-replies.glm.log
// （桥自己落的网页回复原文）。形状是：
//
//     <tool_call>pwsh
//     {"mcp_action": "call", "name": "pwsh", "purpose": "…", "arguments": {…}}
//     ```
//
// 即 **标签开头 + 裸工具名 + 调用 JSON + 反引号围栏结尾**——把项目教的两套形状
// 混在了一起。它既不是纯 tag 形状（没有 </tool_call>），也不是纯 codeblock 形状
// （没有开围栏 ```json）。
//
// 本探针只做一件事：把这段喂给**生产解析器** parseAgentReply，数它解出几个调用。
import { parseAgentReply } from '../lib/agent-preset.js';

const TOOLS = ['read', 'pwsh', 'glob', 'grep', 'write', 'edit']
  .map((n) => ({ name: n, parameters: { type: 'object' } }));

// ---- 真实样本（逐字，来源：webcode-bridge-replies.glm.log 记录[11]）----
const REAL_11 = '<tool_call>pwsh\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "查看 package/dsh-webcode-bridge 源码结构", '
  + '"arguments": {"command": "Get-ChildItem -Recurse -Depth 2 -Path package\\\\dsh-webcode-bridge | '
  + 'Where-Object { $_.FullName -notmatch \'node_modules\' } | Select-Object FullName | Format-Table -AutoSize -Wrap", '
  + '"description": "List package source tree excluding node_modules"}}\n'
  + '```';

// ---- 真实样本（逐字，记录[3]：一条正文里**两个**混合形状调用）----
const REAL_3 = '好的，我记下规则了。\n\n现在来处理智谱清言矢量图的问题。我先看看工作目录结构，找到相关文件。'
  + '<tool_call>pwsh\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "查看当前工作目录结构", "arguments": {"command": "Get-ChildItem -Force", "description": "List files in current directory"}}\n'
  + '```'
  + '<tool_call>glob\n'
  + '{"mcp_action": "call", "name": "glob", "purpose": "查找所有 SVG 矢量图文件", "arguments": {"pattern": "**/*.svg"}}\n'
  + '```';

// ---- 对照组：项目**教**的形状（应当被解出）----
const TAUGHT_CODEBLOCK = '```json\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "列出目录", "arguments": {"command": "Get-ChildItem", "description": "list"}}\n'
  + '```';

// ---- 对照组：纯标签形状（其它站点教的，应当被解出）----
const TAUGHT_TAG = '<tool_call>{"mcp_action": "call", "name": "pwsh", "purpose": "列出目录", '
  + '"arguments": {"command": "Get-ChildItem", "description": "list"}}</tool_call>';

// ---- 对照组：GLM 原生模板形状（agent-preset 已支持，应当被解出）----
const NATIVE_TEMPLATE = '<tool_call>pwsh\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "列出目录", "arguments": {"command": "Get-ChildItem", "description": "list"}}'
  + '</tool_call>';

const cases = [
  ['真实[11] 混合形状（标签+裸名+JSON+```）', REAL_11, 1],
  ['真实[3]  两个混合形状调用', REAL_3, 2],
  ['对照 教过的 ```json 围栏', TAUGHT_CODEBLOCK, 1],
  ['对照 教过的 <tool_call>{JSON}</tool_call>', TAUGHT_TAG, 1],
  ['对照 原生模板 <tool_call>名+JSON</tool_call>', NATIVE_TEMPLATE, 1],
];

console.log('===== GLM 混合形状 → 生产解析器 parseAgentReply =====\n');
let bad = 0;
for (const [label, text, want] of cases) {
  const r = parseAgentReply(text, { tools: TOOLS });
  const ok = r.calls.length === want;
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'LOST'}  ${label}`);
  console.log(`      期望 ${want} 个调用，实得 ${r.calls.length} 个  ${JSON.stringify(r.calls.map((c) => c.name))}`);
  if (r.diagnostics.length) {
    console.log('      diagnostics: ' + JSON.stringify(r.diagnostics.slice(0, 2)));
  }
}
console.log(`\n判定: ${bad === 0 ? '全部解出' : bad + ' 个用例的调用被丢弃'}`);
process.exitCode = bad === 0 ? 0 : 1;
