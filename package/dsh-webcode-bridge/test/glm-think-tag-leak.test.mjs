// glm-think-tag-leak.test.mjs — GLM 走错通道的思考闭合标签必须从正文里剥掉（0.19.46）。
//
// ## 真机取证（2026-09-28，GLM 长跑探针 step 1）
//
// 证据：`%TEMP%\glm-longrun-EVIDENCE.txt` 的 step 1 `replyHead` 逐字为
//
//     ```json
//     {"name": "pwsh", "arguments": {…}}
//     ```</think>两条输出分别是"LQ524"和"STEP2-LQ524"。
//
// 即 `</think>` 夹在**代码围栏与后续散文之间**。用户报的「正文回复明显不对」
// 有一份就是它：一个纯属**传输残留**的标签混进了交给用户的正文。
//
// 机理：思考内容本来走 `type === 'think'` 的独立通道（解码器已正确处理），
// 所以 text 通道里的 `</think>` 不可能是正文的一部分——是模型把两个通道的
// 边界写串了。剥掉它是**去噪声，不改语义**。
//
// ## 判据（本文件钉住的两件事）
//
// ① `</think>` / `</thinking>` 不得出现在外发正文里（onDelta 与 finish().text 两条路都要干净
//    ——`finish()` 的 text 才是交给上层的权威全文，只清洗增量是不够的）；
// ② **不得误伤**：`<thinking>` 开标签（可能是散文里的引用）、普通 HTML 标签、
//    以及任何不含该标签的正文，必须逐字保留。
//
// ## 反向验证（doc/comment-style.md §9.3）
//
// 把 GlmDecoder 的 `emitText` 覆写删掉 ⇒ ① 必须变红（正文重新带上 `</think>`）。
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/decoder.js';

const GlmDecoder = globalThis.WebCodeStreamDecoders?.glm;
if (!GlmDecoder) { throw new Error('glm decoder not registered'); }

/** 构造一个只含 text content 的 GLM SSE 帧（与 glm-tool-snapshot-dedup 同一形状）。 */
function frame(text, { status = 'init' } = {}) {
  return 'data: ' + JSON.stringify({
    id: 'assist1', conversation_id: 'conv-1', status,
    parts: [{ role: 'assistant', content: [{ type: 'text', text, tool_calls: {} }], status }],
  }) + '\n\n';
}

/** 跑一段文本，返回 `{ deltas, finalText }`（两条出口都要看）。 */
function run(text) {
  const deltas = [];
  const dec = new GlmDecoder();
  dec.onDelta = (t) => { if (t) deltas.push(t); };
  dec.push(frame(text));
  const fin = dec.finish();
  return { deltas: deltas.join(''), finalText: String(fin.text || '') };
}

// 真机那一段（逐字取自证据包，只把参数压短以免断言被长 JSON 淹没）。
const REAL = '```json\n{"name":"pwsh"}\n```</think>两条输出分别是"LQ524"和"STEP2-LQ524"。';

test('① 真机形态：`</think>` 不得出现在正文里（增量与权威全文两条出口）', () => {
  const r = run(REAL);
  assert.ok(!r.deltas.includes('</think>'), '增量通道仍带 </think>：' + JSON.stringify(r.deltas));
  assert.ok(!r.finalText.includes('</think>'), 'finish().text 仍带 </think>（它才是交给上层的全文）：' + JSON.stringify(r.finalText));
  // 剥掉标签**不能**顺带吃掉后面的散文——那才是真内容。
  assert.ok(r.finalText.includes('两条输出分别是'), '剥标签时误删了正文：' + JSON.stringify(r.finalText));
  assert.ok(r.finalText.includes('"name":"pwsh"'), '调用载荷必须原样保留');
});

test('①b `</thinking>` 长形态同样剥掉', () => {
  const r = run('正文A</thinking>正文B');
  assert.equal(r.finalText, '正文A正文B', '实际：' + JSON.stringify(r.finalText));
});

test('② 不得误伤：开标签 / 普通 HTML / 无标签正文逐字保留', () => {
  // `<thinking>` 的**开**标签可能是散文里的引用 ⇒ 刻意保留（宁可留着也不误删）。
  assert.equal(run('<thinking>是引用</thinking>').finalText, '<thinking>是引用');
  // 普通标签不碰。
  assert.equal(run('正文里的 <b>粗体</b> 与 <div> 保留').finalText, '正文里的 <b>粗体</b> 与 <div> 保留');
  // 无标签逐字不变（这条同时防止「清洗函数把整段吃掉」这类回归）。
  const plain = '一点标签都没有的普通回复，含 123 与 English。';
  assert.equal(run(plain).finalText, plain);
});

test('③ 只剥标签本身，多余空白一并收掉但不吃掉后续字符', () => {
  assert.equal(run('a</think> b').finalText, 'a b'.replace(' ', ''), '紧邻空白随标签一起收掉');
  assert.equal(run('a</think>\n\nb').finalText, 'ab');
});
