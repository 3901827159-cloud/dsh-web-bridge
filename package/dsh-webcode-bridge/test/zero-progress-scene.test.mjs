// zero-progress-scene.test.mjs — 「空回复」报错的两条取证纪律（0.19.45）。
//
// ## 真机事故（2026-09-28，GLM，会话 session-ee3a8650）
//
// 用户报错原文：
//   `本轮运行失败 empty response from web AI（收束原因 finished） | 流首段: data:
//    {"id":"6ab9fff5a0610b1da4035fd6","conversation_id":"6ab9fe16a0610b1da4035b49",
//    ..."parts":[],"created_at":"2026-09-28 13:49:41","status":"init","last_error`
//
// 那一轮的会话存档（`session.v4.jsonl.zstd`）逐条读数：turn 2 里**前 9 个 assistant
// 步骤都正常带 tool-call**（05:44:09 → 05:49:11），第 10 步返回空流。
//
// 两处取证缺陷都在这一句话里：
//
// ① **收束原因是一句假陈述。** 旧实现
//    （`browser-driver.js` 的 `noteEndReason(lastFinished?.settled_by || 'finished')`）
//    兜底那格**无条件写 'finished'**，不看解码器给的是 `{complete:true}` 还是
//    `{complete:false, reason:'incomplete'}`。GLM 只在 `status === 'finish'` 帧
//    才置 done，那一轮只有 `status:"init"` 就断了 ⇒ 解码器给 incomplete，
//    报错却说「网页正常收束」。与本项目记过的同族缺陷（旧读数冒充本轮、
//    `mid-stream` 被印成「已开流后的静默」）逐字同构。
//
// ② **流首段按构造必然误导。** `status:"init"` + `parts:[]` 是 GLM **每一轮**的
//    正常开帧，与这一轮为什么空毫无关系；真因（限流原话 / 审核提示 / `last_error`）
//    都在**后面的帧**里。旧报错只截首段前 200 字符，因此「真因」这一格永远看不到。
//
// ## 判据（本文件钉住的三件事）
//
// ① 收束原因必须与「本轮到底有没有交付」自洽：跑完整才写 finished，
//    没收完整必须如实带出解码器的 reason；
// ② 报错现场必须同时含**流首段与流尾段**（真因在尾段）；
// ③ 首尾相同时不得重复印同一段（读数要短且不误导）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWebResponseError } from '../lib/zero-progress.js';

// 那一轮的真实首帧（逐字取自用户报错文本）。
const HEAD = 'data:  {"id":"6ab9fff5a0610b1da4035fd6","conversation_id":"6ab9fe16a0610b1da4035b49",'
  + '"assistant_id":"65940acff94777010aa6b796","parts":[],"created_at":"2026-09-28 13:49:41",'
  + '"status":"init","last_error":null}';
// 真因所在的尾帧（真机形态：限流原话走 last_error）。
const TAIL = 'data: {"status":"init","parts":[],"last_error":{"code":"1301",'
  + '"message":"当前访问人数过多，请稍后重试"}}';

const empty = { text: '', thinking: '', images: [] };

test('① 收束原因不得把「没跑完」说成 finished（修前那句假陈述）', () => {
  const msg = emptyWebResponseError(empty, {
    lastEndReason: 'partial:incomplete', rawHead: HEAD, rawTail: TAIL,
  }).message;
  assert.match(msg, /收束原因 partial:incomplete/, '必须如实带出解码器的 reason：' + msg);
  assert.ok(!/收束原因 finished/.test(msg),
    '流没有 finished 时绝不许印「收束原因 finished」——那是一句假陈述：' + msg);
});

test('② 报错必须同时含流首段与流尾段（真因在尾段）', () => {
  const msg = emptyWebResponseError(empty, {
    lastEndReason: 'partial:incomplete', rawHead: HEAD, rawTail: TAIL,
  }).message;
  assert.match(msg, /流首段:/, '首段要保留（它证明流确实开过）：' + msg);
  assert.match(msg, /流尾段:/, '尾段是**唯一**能看到真因的地方，缺了等于没有取证：' + msg);
  assert.match(msg, /当前访问人数过多/, '尾段的真因必须真的出现在报错里：' + msg);
});

test('②b 反向：只给首段（旧调用形状）时不得凭空编一个尾段出来', () => {
  const msg = emptyWebResponseError(empty, { lastEndReason: 'partial:incomplete', rawHead: HEAD }).message;
  assert.match(msg, /流首段:/);
  assert.ok(!/流尾段:/.test(msg), '没有尾段读数时不许印「流尾段」（编造读数比没有读数更坏）：' + msg);
});

test('③ 首尾读数相同时只印一次，不重复同一段', () => {
  const same = 'A'.repeat(300);
  const msg = emptyWebResponseError(empty, { rawHead: same, rawTail: same }).message;
  const hits = msg.split('流首段:').length - 1;
  assert.equal(hits, 1, '首尾重合时应只保留一段：' + msg.slice(0, 120));
  assert.ok(!/流尾段:/.test(msg), '重合时不该再印一份尾段：' + msg.slice(0, 120));
});

test('④ 有内容（正文/思考/图片任一）时绝不报错——既有契约不得被本改动破坏', () => {
  assert.equal(emptyWebResponseError({ text: '有正文', thinking: '', images: [] }, {}), null);
  assert.equal(emptyWebResponseError({ text: '', thinking: '有思考', images: [] }, {}), null);
  assert.equal(emptyWebResponseError({ text: '', thinking: '', images: [{ url: 'u' }] }, {}), null);
  // 全空才报
  assert.ok(emptyWebResponseError(empty, {}) instanceof Error);
});
