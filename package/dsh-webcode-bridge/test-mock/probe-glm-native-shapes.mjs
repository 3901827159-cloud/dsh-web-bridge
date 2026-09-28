// probe-glm-native-shapes.mjs — 用**生产解析器**逐条复算 GLM 真机原生形态夹具（2026-09-27）。
//
// 目的：把「GLM 写了调用、桥却派发出错参数」这件事变成可复现、可回归的读数。
// 输入是 test/fixtures/glm-native/*.txt（**逐字**真机回复，来源见该目录 README）。
//
// 判据（三条，缺一不可）：
//   ① 变体 A 的三个调用必须**全部**解析出来，且参数键必须是 schema 里真实存在的键
//      （`file_path` / `limit` / `path` / `pattern`）——出现 `md` 这类垃圾键即为缺陷；
//   ② 变体 C 的同一逻辑调用（原生形状 + 尾部围栏信封）必须**去重**，不得执行两遍；
//   ③ 教学模板夹具（变体 D，思考通道原文）必须**一个调用都不产出**——
//      模型描述协议不等于调用协议。
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentReply } from '../lib/agent-preset.js';

const DIR = path.join(process.cwd(), 'test', 'fixtures', 'glm-native');
const read = (n) => fs.readFileSync(path.join(DIR, n), 'utf8');

// 与真机会话同形的工具表（schema 逐字取自 DSH 真实下发的 read/glob）。
const TOOLS = [
  { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] } },
  { name: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] } },
  { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, workdir: { type: 'string' } }, required: ['command', 'description'] } },
  { name: 'write', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
];

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails += 1; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

console.log('===== 变体 A：裸名 + key=value 行 + 收尾 </arg_value> =====');
{
  const text = read('glm-native-a-keyeq-lines.txt');
  const got = parseAgentReply(text, { tools: TOOLS });
  console.log('  calls=' + got.calls.length + ' names=' + JSON.stringify(got.calls.map((c) => c.name)));
  for (const c of got.calls) console.log('    ' + c.name + ' ' + JSON.stringify(c.arguments));
  if (got.diagnostics.length) console.log('  diagnostics=' + JSON.stringify(got.diagnostics));
  // 真机原文里有 **4** 个 `<tool_call>` 开标签（read / glob / read / read），
  // 逐字复核见夹具文件本身——这不是「应该有几个」的推测，是数出来的。
  ok(got.calls.length === 4, '解析出 4 个调用（真机原文里就有 4 个开标签）');
  ok(got.calls.every((c) => typeof c.arguments.file_path === 'string' || typeof c.arguments.pattern === 'string'),
    '4 个调用都带上了自己 schema 的必填参数');
  const declared = new Set(TOOLS.flatMap((t) => Object.keys(t.parameters.properties)));
  const badKeys = got.calls.flatMap((c) => Object.keys(c.arguments)).filter((k) => !declared.has(k));
  ok(badKeys.length === 0, '没有 schema 之外的垃圾参数键（实际垃圾键：' + JSON.stringify(badKeys) + '）');
  const reads = got.calls.filter((c) => c.name === 'read');
  ok(reads.length === 3 && reads.every((c) => typeof c.arguments.file_path === 'string'), '三个 read 都带上了 file_path');
  const g = got.calls.find((c) => c.name === 'glob');
  ok(g && typeof g.arguments.pattern === 'string', 'glob 带上了 pattern');
}

console.log('\n===== 变体 C：原生 arg_key 形状 + 尾部围栏信封（去重） =====');
{
  const text = read('glm-native-c-argkey.txt');
  const got = parseAgentReply(text, { tools: TOOLS });
  console.log('  calls=' + got.calls.length + ' names=' + JSON.stringify(got.calls.map((c) => c.name)));
  for (const c of got.calls) console.log('    ' + c.name + ' ' + JSON.stringify(c.arguments));
  const sigs = got.calls.map((c) => c.name + JSON.stringify(c.arguments));
  ok(new Set(sigs).size === sigs.length, '同一逻辑调用没有重复入账（原生形状 + 围栏信封同源）');
}

console.log('\n===== 变体 D：思考通道里的教学模板 =====');
{
  const text = read('glm-native-d-teaching-placeholder.txt');
  const got = parseAgentReply(text, { tools: TOOLS });
  console.log('  calls=' + got.calls.length + ' names=' + JSON.stringify(got.calls.map((c) => c.name)));
  // **这条判据不是「0 调用」**——那是我一开始写错的一版，被既有护栏挡下且挡得对：
  //   · test/nameless-call.test.mjs ⑨ 要求「未知工具名**原样保留**，交给 TOOL_UNKNOWN 判定」；
  //   · test/official-tool-calls.test.mjs「教学骨架」要求无工具表时骨架仍解析出 1 条。
  // 两条合起来说明「这个名字是占位符还是模型真写错了」在解析层**不可判定**。
  // 真正该守住的契约是：**解析出的调用名不得命中本会话工具表中的任何真实工具**，
  // 于是 lib/index.js 的工具表过滤（valid / unknownNames）能按设计把它转成
  // 「本会话可用工具清单 + 请重试」这条可行动提示，而不是执行一个不存在的工具。
  const real = new Set(TOOLS.map((t) => t.name));
  const bogus = got.calls.filter((c) => real.has(c.name));
  ok(bogus.length === 0, '占位符不会被误认成真实工具（解析层判不出真假，靠 index.js 工具表过滤）');
  ok(got.calls.every((c) => !real.has(c.name)), '所有解析结果都不是本会话的真实工具 ⇒ 会被 unknownNames 分支接住');
}

console.log('\n' + (fails ? `RESULT: FAIL（${fails} 条判据不成立）` : 'RESULT: PASS'));
process.exitCode = fails ? 1 : 0;
