// kimi-decoder.test.mjs — 护栏：kimi Connect-RPC 的**权威信号**必须被用起来（0.19.41）。
//
// ## 这个文件防的是哪两次真缺陷（都是 Lead 真机跑出来的）
//
// ### ① 生成状态被丢掉 ⇒ 一轮还在思考的回复被 2.5s 稳态收束
//
// 真机现场（带附件轮，`.tmp-probe/kimi/lead-final-out.json` 的前几轮）：
//
//   [webcode-driver:kimi] wip steady state — settling turn with 0 chars answer / 114 chars thinking
//                         (partial-wip-settled)
//   [webcode-driver:kimi] partial web stream accepted (incomplete, status=n/a, 0 chars, 0 image(s))
//
// 正文一个字符都没等到就收束了。而 kimi 的 Connect-RPC 流里**本来就带**
// `message.status = MESSAGE_STATUS_GENERATING / MESSAGE_STATUS_COMPLETED`——
// 旧实现看到了却什么都没做（那句注释写着「此处只做 completion 锚点」，
// 而它连锚点都没设），于是驱动侧只能靠「流静默 + DOM 停长」推断，
// 而 kimi 的思考阶段正文节点读不到内容，推断必然出错。
//
// ### ② 服务端原话被丢掉 ⇒ 用户只看到 `invalid_stream`
//
// 真机原始帧：
//
//   {"error":{"code":"resource_exhausted","details":[{"type":"common.error.v1.ErrorDetail",
//     "value":"CHUSSQoFemgtQ04SQOWSjEtpbWnogYrlpKnnmoTkurrlpKrlpJrkuobvvIzor7fm…"}]}}
//
// base64 解出来是「和Kimi聊天的人太多了，请根据当前速率限制信息后重试。（Request ID…）」。
// 旧实现只置 `failed = true`，整轮报成 `invalid_stream | 流首段: {"heartbeat":{}}`——
// **排查者看不到服务端说了什么**，而那句话正好解释了「为什么发不出去」。
//
// ## 判据
//
//   ① assistant 消息 `GENERATING` ⇒ `isGenerating()` 为真（驱动据此推迟收束）；
//   ② 终态 `COMPLETED` ⇒ `isGenerating()` 转假 **且** `done` 置真（finish 交回 complete）；
//   ③ 错误帧的 base64 原话必须解进 `reason`（含 code 与中文原话），不得只有 `invalid_stream`；
//   ④ 反向安全线：**没有** generating 信号的站点（基类）行为与既有实现逐字相同。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// decoder.js 是浏览器侧 bundle 形状（IIFE 挂 globalThis），用 vm 驱动它，
// 与 test/multi-site-decoder.test.mjs 同一做法。
const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'decoder.js'), 'utf8');
function loadDecoders() {
  const sandbox = { globalThis: null, window: undefined, Buffer, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.WebCodeStreamDecoders;
}

const DECODERS = loadDecoders();
const mk = (kind = 'kimi-connect') => new DECODERS[kind]();
// 逐帧喂入：**必须带换行**——`JsonLinesDecoder.push` 按 `\n` 切行，
// 不带换行的帧会留在缓冲区里等下一段（这是 2026-09-27 本测试首版写错的地方：
// 四条用例全红而实现是对的，红的原因在测试自己的喂帧形状）。
const feed = (d, ...frames) => { for (const f of frames) d.push(f + '\n'); };

// 真机帧（逐字，2026-09-27 kimi Connect-RPC）
const F_ASSISTANT_GENERATING = '{"op":"set","mask":"message","eventOffset":6,"message":{"id":"1a0e2869-d252-88c2-8000-0ac2a96f6b4b","parentId":"1a0e2869-d252-88c2-8000-0ac2816680d6","role":"assistant","status":"MESSAGE_STATUS_GENERATING","scenario":"SCENARIO_OK_COMPUTER"}}';
const F_THINK = '{"op":"set","mask":"block.think","eventOffset":10,"block":{"id":"3","parentId":"2","think":{"content":"用户"}}}';
const F_TEXT = '{"op":"set","mask":"block.text","eventOffset":30,"block":{"id":"4","parentId":"2","text":{"content":"标记值：ABC123"}}}';
const F_ASSISTANT_COMPLETED = '{"op":"set","mask":"message","eventOffset":40,"message":{"id":"1a0e2869-d252-88c2-8000-0ac2a96f6b4b","role":"assistant","status":"MESSAGE_STATUS_COMPLETED"}}';
// 真机帧（2026-09-27 kimi Connect-RPC）。⚠ 这条 `value` 是**从终端读数里抄回来的**，
// 中段个别汉字可能在转录中失真；但**帧形状、code、base64 结构、以及 `zh-CN@和Kimi聊天
// 的人太多了` 这一段**是逐字稳定的，判据只钉这几点（不去断言我抄不准的那部分）。
const F_ERROR = '{"error":{"code":"resource_exhausted","details":[{"type":"common.error.v1.ErrorDetail","value":"CHUSSQoFemgtQ04SQOWSjEtpbWnogYrlpKnnmoTkurrlpKrlpJrkuobvvIzor7fmoLnmja3lvZPliY3pgJ/or53pgJDnjofkv6Hmga/lkI7ph43or5XjgILvvIhSZXF1ZXN0IElEkTg=="}]}}';

test('① assistant GENERATING ⇒ isGenerating() 为真（驱动据此推迟收束）', () => {
  const d = mk();
  feed(d, F_ASSISTANT_GENERATING);
  assert.equal(d.isGenerating(), true,
    'assistant 消息处于 MESSAGE_STATUS_GENERATING，解码器却没报「还在生成」⇒ '
    + '驱动只能靠「流静默 2.5s + DOM 停长」推断，而 kimi 思考阶段正文节点读不到内容，'
    + '真机后果是「0 chars answer / 114 chars thinking」被当成稳态收束');
  assert.equal(d.finish().complete, false, '还在生成时 finish 不得报 complete');
});

test('② 终态 COMPLETED ⇒ 停止「还在生成」且 complete 为真', () => {
  const d = mk();
  feed(d, F_ASSISTANT_GENERATING);
  feed(d, F_THINK);
  feed(d, F_TEXT);
  feed(d, F_ASSISTANT_COMPLETED);
  assert.equal(d.isGenerating(), false, '终态之后仍报「还在生成」⇒ 驱动会一直等到硬上限');
  const r = d.finish();
  assert.equal(r.complete, true,
    '网页明确说了 MESSAGE_STATUS_COMPLETED，finish() 却仍报 incomplete ⇒ '
    + '一轮正常完成的回复被当部分流落账（真机读数 partial web stream accepted (incomplete…)）');
  assert.equal(r.text, '标记值：ABC123', '正文不得丢');
  assert.equal(r.thinking, '用户', '思考不得丢');
});

test('③ 错误帧的服务端原话必须解进 reason（不得只有 invalid_stream）', () => {
  const d = mk();
  feed(d, F_ERROR);
  const r = d.finish();
  const reason = String(r.reason);
  assert.equal(r.complete, false);
  assert.match(reason, /resource_exhausted/,
    'reason 必须带服务端的 code（实际 ' + JSON.stringify(reason) + '）');
  assert.match(reason, /zh-CN/,
    'base64 里的原话必须被解出来（真机解出的是 `zh-CN@和Kimi聊天的人太多了，'
    + '请根据当前速率限制信息后重试。（Request ID…）`）；只报 invalid_stream 等于把线索丢掉。'
    + '实际 reason=' + JSON.stringify(reason));
  assert.match(reason, /聊天的人太多/,
    '原话必须带出**服务端到底说了什么**（这一段在真机解码里逐字稳定）；实际 ' + JSON.stringify(reason));
  // 反面：不许是一句被编造的通用文案——解不出来时应当**原样**带出 value 前缀。
  assert.ok(reason.length > 20, 'reason 太短，像是被编造的通用文案：' + JSON.stringify(reason));
});

test('④ 反向安全线：没有 generating 信号的解码器行为逐字不变', () => {
  // 基类提供默认实现，但**不是所有解码器都继承 JsonLinesDecoder**
  //（`openai-sse` 就是独立的类，实例上没有 isGenerating）⇒ 驱动侧必须按
  // **可选方法**调用。这条断言把那个容错钉住：删掉 `?.` 就会在真机上抛 TypeError。
  const bd = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'browser-driver.js'), 'utf8');
  assert.match(bd, /isGenerating\?\.\(\)/,
    '驱动侧必须以可选方法调用 isGenerating（不是所有解码器都有它 —— openai-sse 就没有）');
  const k = mk();
  assert.equal(typeof k.isGenerating, 'function', 'kimi-connect 继承的基类必须提供 isGenerating');
  assert.equal(k.isGenerating(), false, '默认必须是 false，否则会把既有站点挂到硬上限');
  assert.equal(k.finish().reason, 'incomplete', '未完成时的既有 reason 必须逐字不变');
  k.failed = true;
  assert.equal(k.finish().reason, 'invalid_stream', '没有可读原话时必须退回既有 invalid_stream');
});

test('⑤ 解码器源码必须真的**读** message.status（而不是只在新字段上做样子）', () => {
  const seg = SRC.slice(SRC.indexOf('class KimiConnectDecoder'), SRC.indexOf('// 注册表：driver 按'));
  assert.match(seg, /MESSAGE_STATUS|GENERATING/i, 'KimiConnectDecoder 里找不到对生成状态的判定');
  assert.match(seg, /this\.generating\s*=/, '没有把生成状态写进 this.generating');
  assert.match(seg, /this\.done\s*=\s*true/, '终态没有真的置 done（那正是「只做锚点却什么都没做」的旧形态）');
});
