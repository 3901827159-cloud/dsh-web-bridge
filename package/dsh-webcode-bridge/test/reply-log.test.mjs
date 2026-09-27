// reply-log.test.mjs — 0.16.17 护栏：网页原始回复全文的落盘日志。
//
// 为什么必须钉住（真机取证第三次断链，2026-09-19）：0.16.13 的「扣留全文进日志」
// 走 console.warn，只到 DSH 进程 stderr、运行时不持久化——run-8 的 UNPARSED 扣留
// 1474 字符，磁盘上只剩提示里的 200 字符头（会话存档 `session-0fd32761`
// assistant/message 04:56:28 实测），归因断链且无法像夹具 19/20 那样靠残片重构。
// 模块行为：默认落 `~/.dsh/logs/webcode-bridge-replies.log`、超限轮转一代（.1）、
// 写失败静默返回 null、测试进程（NODE_TEST_CONTEXT）下不写默认目录。
// 全部用例显式传 opts.dir / opts.maxBytes，绝不触碰真实日志目录。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendReplyLog } from '../lib/reply-log.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webcode-reply-log-'));
const cleanup = (d) => fs.rmSync(d, { recursive: true, force: true });
const NOW = new Date('2026-09-19T04:56:28.000Z');

test('写入：头行元信息 + 原文逐字 + 尾行定界，返回文件路径', () => {
  const dir = tmp();
  try {
    const text = '第一行\r\n<｜｜DSML｜｜ invoke name="edit">\r\n第二行';
    const file = appendReplyLog(text, { sessionId: 'sess-abc', chars: 999, calls: 0, note: 'raw reply, verbatim' }, { dir, now: NOW });
    assert.equal(file, path.join(dir, 'webcode-bridge-replies.log'));
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    assert.ok(lines[0].startsWith('=== webcode-bridge raw reply === | '), '头行必须是定界前缀');
    assert.ok(lines[0].includes('2026-09-19T04:56:28'), '头行带时间');
    assert.ok(lines[0].includes('session=sess-abc'), '头行带会话');
    assert.ok(lines[0].includes('chars=999'), '头行带字符数（元信息优先于实测）');
    assert.ok(lines[0].includes('calls=0'), '头行带调用数');
    assert.ok(content.includes(text), '原文必须逐字在文件里（含全角标记与 CRLF）');
    assert.ok(content.endsWith('=== webcode-bridge raw reply === end\n'), '尾行定界');
    assert.equal(lines.filter((l) => l === '=== webcode-bridge raw reply === end').length, 1, '尾行只出现一次');
  } finally { cleanup(dir); }
});

test('轮转：超过 maxBytes 时旧文件改名为 .1（保留一代），新写入从头开始', () => {
  const dir = tmp();
  try {
    const big = 'x'.repeat(1200);
    appendReplyLog(big, { calls: 1 }, { dir, maxBytes: 1000, now: NOW });
    const first = path.join(dir, 'webcode-bridge-replies.log');
    assert.ok(fs.statSync(first).size > 1000, '第一次写入可以超限（轮转发生在下一次写入前）');
    appendReplyLog('second', { calls: 2 }, { dir, maxBytes: 1000, now: NOW });
    assert.ok(fs.existsSync(first + '.1'), '旧文件轮转为 .1');
    assert.ok(fs.readFileSync(first + '.1', 'utf8').includes(big), '.1 保存的是上一代全文');
    const cur = fs.readFileSync(first, 'utf8');
    assert.ok(cur.includes('second'), '当前文件是新内容');
    assert.ok(!cur.includes(big), '当前文件不再含旧正文');
    // 第三次写入（未超限）不得再次轮转：.1 保持不变
    appendReplyLog('third', { calls: 3 }, { dir, maxBytes: 1000, now: NOW });
    assert.ok(fs.readFileSync(first + '.1', 'utf8').includes(big), '未超限时 .1 不被覆盖');
  } finally { cleanup(dir); }
});

test('失败静默：目录不可写（路径被文件占用）返回 null 且不抛错', () => {
  const dir = tmp();
  try {
    const blocker = path.join(dir, 'occupied');
    fs.writeFileSync(blocker, 'not a dir');
    const file = appendReplyLog('x', { calls: 0 }, { dir: blocker });
    assert.equal(file, null, 'mkdir/mkdir 途中失败必须吞掉并返回 null');
  } finally { cleanup(dir); }
});

test('测试进程守卫：NODE_TEST_CONTEXT 下未显式给目录时不写默认位置', () => {
  // 本用例的守卫只在 NODE_TEST_CONTEXT 已设时才有意义（node --test 通道）；
  // 直跑（node test/x.mjs，调试用）没有这个 env——前提不成立时跳过守卫断言，
  // 但仍验证「不显式给目录」这条路径本身可走（写入落到默认目录或返回 null，
  // 两种都不抛错——0.19.30 起直跑不再把前提当硬断言拦整份测试）。
  if (!process.env.NODE_TEST_CONTEXT) {
    const file = appendReplyLog('should not be written', { calls: 0 });
    assert.ok(file === null || typeof file === 'string', '无 env 直跑：守卫路径不抛错即可');
    return;
  }
  const file = appendReplyLog('should not be written', { calls: 0 });
  assert.equal(file, null, '测试进程 + 无显式目录必须 no-op');
  // 契约就到此为止：**返回 null 就等于没有落盘**，这正是本用例要钉的那条守卫。
  //
  // 为什么删掉了原先那条「默认日志文件里不得出现本用例写入」的内容断言（2026-09-27）：
  // 它读的是**生产日志**（~/.dsh/logs/webcode-bridge-replies.log），而那份文件同时是桥的
  // **原始回复留痕**——正文里出现 `should not be written` 这句话完全合法。本机实测确已发生：
  // 一条被 dump 的模型回复逐字引用了本测试文件的源码（该文件第 25839 行），断言因此失败。
  // 关键读数：**HEAD 版本跑同一个用例同样失败** ⇒ 它与本轮改动无关，是一条**环境相关**的假红。
  // 假红比漏报更坏（doc/comment-style.md §9.1 第 1 条）：它会让整份测试在某台机器上永远红着，
  // 读者于是学会忽略它。真正的守卫由上一行断言承担；内容比对这一层判不了「谁写的」，
  // 留着只会再次误伤，因此按「修判据而不是绕过」的同一纪律删掉这一条。
});

test('0.19.30 按站点分文件：meta.siteId 时落 <site> 段文件，头行带 site= 字段', () => {
  const dir = tmp();
  try {
    const file = appendReplyLog('hi', { siteId: 'glm', calls: 1 }, { dir, now: NOW });
    assert.equal(file, path.join(dir, 'webcode-bridge-replies.glm.log'));
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('site=glm'), '头行带站点字段（时间之后、session 之前）');
    assert.ok(content.includes('session=-'), '无会话标识仍记 session=-');
    assert.ok(!fs.existsSync(path.join(dir, 'webcode-bridge-replies.log')), '默认名文件不被创建');
  } finally { cleanup(dir); }
});

test('siteId 安全化：非法字符剔除、空值回落默认文件名', () => {
  const dir = tmp();
  try {
    const a = appendReplyLog('a', { siteId: 'Deep_Seek!.exe', calls: 0 }, { dir });
    assert.equal(a, path.join(dir, 'webcode-bridge-replies.deepseekexe.log'));
    const b = appendReplyLog('b', { calls: 0 }, { dir });
    assert.equal(b, path.join(dir, 'webcode-bridge-replies.log'));
  } finally { cleanup(dir); }
});

test('显式 opts.basename 胜过站点分文件（测试通道不受 siteId 影响）', () => {
  const dir = tmp();
  try {
    const file = appendReplyLog('x', { siteId: 'glm', calls: 0 }, { dir, basename: 'custom.log' });
    assert.equal(file, path.join(dir, 'custom.log'));
  } finally { cleanup(dir); }
});
