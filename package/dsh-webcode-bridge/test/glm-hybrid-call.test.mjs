// glm-hybrid-call.test.mjs — GLM「混合形状」调用的真机回归护栏（0.19.41）。
//
// ## 为什么需要这条护栏（真机取证，2026-09-27）
//
// 用户报「工具调用老是失败」。逐条复算桥自己落的**真实网页回复**
//（`~/.dsh/logs/webcode-bridge-replies.glm.log`，41 条）后定位到两条确定性缺陷，
// 都发生在 GLM 特有的**混合形状**上——它把项目教的两套形状混着写：
//
//     <tool_call>工具名            ← 标签开头（其它站点教的形状）
//     {"mcp_action":"call",…}      ← 调用 JSON
//     ```                          ← 反引号收尾（glm 站点教的形状）
//
// 这个形状在 41 条真实回复里出现 **5 条**，且：
//   · 记录[11]：整条调用**被静默丢弃**（桥记 `calls=0`，而 JSON 是配平的、
//     name/arguments 齐全）——用户侧就是「写了调用却没执行」；
//   · 记录[3]/[12]/[14]：一条正文里两个调用，**只解出后一个**（前一个丢）；
//   · 原生模板形状（`</tool_call>` 收尾）：同一调用被两支各收一次 →
//     `calls=2`，**同一轮派发两遍**，且第一份的 arguments 多嵌了一层
//     （`{"mcp_action":…,"name":…,"arguments":{…}}`，工具拿到的是错参数）。
//
// ## 判据（本文件钉住的四件事）
//
// ① 混合形状（``` 收尾）必须解出**恰好 1 个**调用，且 name/arguments 正确；
// ② 原生模板形状（`</tool_call>` 收尾）必须解出**恰好 1 个**（不得重复），
//    且 arguments **不得**被多嵌一层；
// ③ 一条正文里两个混合形状调用必须解出 2 个，**顺序与原文一致**；
// ④ 反例护栏：**没有** `<tool_call>` 开标签的裸 JSON + 围栏，以及散文里的
//    举例，不得因为本次放宽而被误认成调用（放宽的只是**终止符**，
//    「什么算调用」的判据一字未动）。
//
// 样本**逐字**取自真机日志（去掉落盘的换行折叠），因此它可以离线复跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentReply } from '../lib/agent-preset.js';

const TOOLS = ['read', 'pwsh', 'glob', 'grep', 'write', 'edit']
  .map((n) => ({ name: n, parameters: { type: 'object' } }));

/** 真机记录[11]（逐字）：单调用，``` 收尾。修复前 calls=0。 */
const REAL_HYBRID_ONE = '<tool_call>pwsh\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "查看 package/dsh-webcode-bridge 源码结构", '
  + '"arguments": {"command": "Get-ChildItem -Recurse -Depth 2 -Path package\\\\dsh-webcode-bridge", '
  + '"description": "List package source tree excluding node_modules"}}\n'
  + '```';

/** 真机记录[3]（逐字）：一条正文里两个混合形状调用。修复前只解出 glob。 */
const REAL_HYBRID_TWO = '好的，我记下规则了。\n\n现在来处理智谱清言矢量图的问题。我先看看工作目录结构，找到相关文件。'
  + '<tool_call>pwsh\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "查看当前工作目录结构", '
  + '"arguments": {"command": "Get-ChildItem -Force", "description": "List files in current directory"}}\n'
  + '```'
  + '<tool_call>glob\n'
  + '{"mcp_action": "call", "name": "glob", "purpose": "查找所有 SVG 矢量图文件", '
  + '"arguments": {"pattern": "**/*.svg"}}\n'
  + '```';

/** 原生模板形状：`</tool_call>` 收尾。修复前 calls=2（重复派发）。 */
const NATIVE_TEMPLATE = '<tool_call>pwsh\n'
  + '{"mcp_action": "call", "name": "pwsh", "purpose": "列出目录", '
  + '"arguments": {"command": "Get-ChildItem", "description": "list"}}'
  + '</tool_call>';

test('★ 0.19.41 GLM 混合形状①：标签+裸名+JSON+``` 必须解出 1 个调用（真机记录[11]）', () => {
  const r = parseAgentReply(REAL_HYBRID_ONE, { tools: TOOLS });
  assert.equal(r.calls.length, 1, '修复前这里恒为 0——调用被静默丢弃');
  assert.equal(r.calls[0].name, 'pwsh');
  assert.equal(r.calls[0].arguments.command, 'Get-ChildItem -Recurse -Depth 2 -Path package\\dsh-webcode-bridge');
  assert.equal(r.calls[0].arguments.description, 'List package source tree excluding node_modules');
  // purpose 必须被带出来（派发侧用它补缺失的 description 类必填参数）。
  assert.equal(r.calls[0].purpose, '查看 package/dsh-webcode-bridge 源码结构');
  // arguments 不得被多嵌一层——那正是旧实现把「整个信封」当参数对象造成的。
  assert.equal(r.calls[0].arguments.mcp_action, undefined);
  assert.equal(r.calls[0].arguments.name, undefined);
});

test('★ 0.19.41 GLM 混合形状②：一条正文两个调用必须解出 2 个且顺序一致（真机记录[3]）', () => {
  const r = parseAgentReply(REAL_HYBRID_TWO, { tools: TOOLS });
  assert.equal(r.calls.length, 2, '修复前这里恒为 1——第一个调用被丢');
  assert.deepEqual(r.calls.map((c) => c.name), ['pwsh', 'glob']);
  assert.equal(r.calls[0].arguments.command, 'Get-ChildItem -Force');
  assert.equal(r.calls[1].arguments.pattern, '**/*.svg');
});

test('★ 0.19.41 GLM 原生模板形状：必须恰好 1 个调用，不得重复、不得多嵌一层', () => {
  const r = parseAgentReply(NATIVE_TEMPLATE, { tools: TOOLS });
  assert.equal(r.calls.length, 1, '修复前这里恒为 2——同一调用被两支各收一次，一轮派发两遍');
  assert.equal(r.calls[0].name, 'pwsh');
  assert.deepEqual(r.calls[0].arguments, { command: 'Get-ChildItem', description: 'list' });
  assert.equal(r.calls[0].purpose, '列出目录');
});

test('★ 0.19.41 反例：没有 <tool_call> 开标签的裸 JSON+围栏不得被误认成调用', () => {
  // 这是**教过的正确形状**：不带标签，纯 ```json 围栏 —— 必须照旧解出（对照组）。
  const taught = '```json\n'
    + '{"mcp_action": "call", "name": "pwsh", "purpose": "列出目录", '
    + '"arguments": {"command": "Get-ChildItem", "description": "list"}}\n'
    + '```';
  assert.equal(parseAgentReply(taught, { tools: TOOLS }).calls.length, 1);

  // 纯散文里讨论协议形状（无标签、无配平信体）→ 0 调用，且不得因为本次放宽而误报。
  const prose = '这个协议长这样：先写 <tool_call>，然后接一个 JSON 对象，最后用反引号收尾。';
  assert.equal(parseAgentReply(prose, { tools: TOOLS }).calls.length, 0);

  // 标签 + 裸名，但**后面既没有闭标签也没有围栏**（散文举例）→ 不放行。
  const dangling = '<tool_call>pwsh 是工具名，参数要写 JSON。';
  assert.equal(parseAgentReply(dangling, { tools: TOOLS }).calls.length, 0);

  // 标签 + 裸名 + JSON，但收尾是**普通句子**（既非闭标签也非围栏）→ 不放行
  // （终止符判据是刻意收窄的：只认这两种收尾，不认「后面随便什么」）。
  const wrongTail = '<tool_call>pwsh\n{"command":"Get-ChildItem"} 然后就这样了';
  assert.equal(parseAgentReply(wrongTail, { tools: TOOLS }).calls.length, 0);
});

test('★ 0.19.41 回归：教过的两种形状（```json 围栏 / <tool_call>{JSON}</tool_call>）不变', () => {
  const codeblock = '```json\n'
    + '{"mcp_action": "call", "name": "read", "purpose": "读文件", "arguments": {"path": "a.md"}}\n'
    + '```';
  const r1 = parseAgentReply(codeblock, { tools: TOOLS });
  assert.equal(r1.calls.length, 1);
  assert.deepEqual(r1.calls[0].arguments, { path: 'a.md' });

  const tag = '<tool_call>{"mcp_action": "call", "name": "read", "purpose": "读文件", '
    + '"arguments": {"path": "a.md"}}</tool_call>';
  const r2 = parseAgentReply(tag, { tools: TOOLS });
  assert.equal(r2.calls.length, 1);
  assert.deepEqual(r2.calls[0].arguments, { path: 'a.md' });
});
