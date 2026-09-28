// composer-single-write.test.mjs — 护栏：富文本（contenteditable）输入框必须**一次性**写入。
//
// ## 这个文件防的是哪一次真缺陷
//
// 用户报障（2026-09-27，kimi:k3）：「你好，请你了解这个插件项目」这一句话就必然失败——
//
//   PROMPT_TRUNCATED: 网页输入框只接收了 20158/38807 字符（网页端长度上限）
//
// 报错**归因错了**：20158 不是 kimi 输入框的上限。真机取证
// （`.tmp-probe/kimi/RESULT.md`，副本 profile、产品同源路径）逐档实测：
//
//   | 写入方式 | 写入 | 回读 | 丢失 |
//   | --- | --- | --- | --- |
//   | 单次 insertText | 8,000 / 16,000 / 20,158 / 24,000 / 32,000 / 38,807 | 逐字相等 | 0 |
//   | 单次 insertText | 50,000 / 100,000 / 200,000（中文+换行） | 逐字相等 | 0（43/94/167ms）|
//   | **分块 20,000+18,400（含换行）** | 38,400 | **20,002** | 尾部 18,398 |
//   | 分块 10,000+10,000（含换行） | 20,000 | **10,060** | 尾部 |
//   | 分块 20,000+18,400（纯 ASCII） | 38,400 | 38,400 | 0 |
//
// 也就是：**丢内容的是桥自己的分块写入**（kimi 的编辑器只吃第一块），而不是网页。
// 块间间隔 0/100/300/600/1000/2000/4000ms 七档读数**完全一致**、插入后 4 秒轨迹稳定
// ⇒ 「等久一点再写第二块」救不了它，只有一次性写入可靠。
//
// ## 为什么必须有这条护栏
//
// 「分块写入」看起来更稳妥（失败更早、带 PROMPT_WRITE_STALLED 现场），所以下一次
// 「提高健壮性」的重构非常容易把它加回来——而加回来的代价是**静默丢半截上下文**，
// 失败形态还是那条会把人引向错误方向的 PROMPT_TRUNCATED。判据必须钉在源码结构上。
//
// ## 判据
//
//   ① `fillComposer` 里 `kind === 'field'` 之后的富文本分支**不得**出现按块循环；
//   ② 富文本分支对 `page.keyboard.insertText` 的调用必须**恰好一次**；
//   ③ `page.evaluate((el, v) => …)` 形式的每块写入也在禁止之列（同一形态的换皮写法）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DRIVER = path.join(import.meta.dirname, '..', 'lib', 'browser-driver.js');
const SRC = fs.readFileSync(DRIVER, 'utf8');

// 框出 fillComposer 的函数体。复用与 upload-attachment-structure.test.mjs 同一套
// 「扫字符串/注释/正则不计配平」的做法——这里只切**一段**，不数嵌套花括号，
// 因此比那份简单：从声明处切到同文件里下一个顶层 `async function` 之前即可。
const declAt = SRC.search(/async\s+function\s+fillComposer\s*\(/);
assert.ok(declAt > 0, '源码里找不到 fillComposer 的声明——本护栏失去作用对象，必须复核');
const nextAt = SRC.indexOf('\n  async function ', declAt + 10);
const BODY = SRC.slice(declAt, nextAt > 0 ? nextAt : SRC.length);

// 富文本分支的起点：`kind === 'field'` 这一支结束之后的部分。
// 为什么按这个锚点切：`kind === 'field'` 的返回值是两条路径的**唯一分界**，
// 它一旦被改名/删除，下面的断言会以「切不出富文本分支」直接变红，而不是静默通过。
const fieldAt = BODY.indexOf("if (kind === 'field')");
const editable = fieldAt >= 0 ? BODY.slice(fieldAt) : '';

test('① 富文本分支切得出来（判据本身必须有作用对象）', () => {
  assert.ok(fieldAt >= 0, 'fillComposer 里找不到 `if (kind === \'field\')` 分支：'
    + '富文本写入路径的判据已经失去作用对象，本文件的断言会变成永远的绿');
  assert.ok(editable.length > 200, '富文本分支只切到 ' + editable.length + ' 字符，明显不对');
  assert.match(editable, /keyboard\.insertText\(/, '富文本分支里找不到 keyboard.insertText');
});

test('② 富文本写入必须一次性：不得有按块循环（kimi 真机：第二块几乎全丢）', () => {
  assert.ok(!/\bfor\s*\(/.test(editable),
    '富文本分支里出现了 for 循环：这是「分块写入」被加回来的形态。'
    + '真机 kimi 实测 20,000+18,400 分块只回读到 20,002 字符（尾部 18,398 字符静默丢失），'
    + '而单次 insertText 38,807 / 200,000 都逐字回读。'
    + '分块写入的失败形态被上层报成 PROMPT_TRUNCATED「网页端长度上限」，'
    + '把人引向「压缩上下文」这个错误方向。若确有必要（新站点只吃分块），'
    + '必须同时把「写入量 vs 回读量」落进 error 现场，并在这里显式记录该站点的真机读数。');
  assert.ok(!/\.slice\(i\s*,/.test(editable) && !/i\s*\+=\s*plan\.chunkChars/.test(editable),
    '富文本分支里出现了按 chunkChars 切片/步进的写法：分块写入的另一种外形');
});

test('③ 富文本分支对 insertText 的调用恰好一次', () => {
  const calls = (editable.match(/keyboard\.insertText\(/g) || []).length;
  assert.equal(calls, 1, '富文本分支里 keyboard.insertText 出现 ' + calls + ' 次，必须是 1 次'
    + '（多次＝分块；0 次＝写入路径被删）');
});

test('④ 富文本分支不得改用每块 evaluate 写入（同一形态的换皮）', () => {
  assert.ok(!/evaluate\([\s\S]{0,200}insertText/.test(editable),
    '富文本分支里出现了 evaluate + insertText 的组合：这会把「一次键盘插入」换成'
    + '「每块一次跨进程往返」，与分块写入同一后果（且更慢）。'
    + '真机三路径对照：keyboard.insertText 24,000 ✓ / execCommand 24,000 ✓ / '
    + 'el.innerText= 只有 1 字符（编辑器用自身状态重渲染丢弃）——三条里只有前两条可用。');
});
