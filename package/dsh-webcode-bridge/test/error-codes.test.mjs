// error-codes.test.mjs — 0.19.54 护栏：错误码必须**活着穿过 harness 边界**。
//
// ## 这条护栏防的是什么（真实缺陷，2026-10-02）
//
// DSH 的 `HarnessError.code` 是**唯一**的机器路由判据（`dsh-llm/lib/types/error.d.ts:13`
// 逐字：*route on this, never by parsing `message`*），而它的归一化只认自己那一份类身份：
// `dsh-llm/lib/types/adapter-failure.js:104-107` 的 `harnessErrorCode()` 逐字返回
// `error instanceof HarnessError ? error.code : 'UNKNOWN'`（完整实现见
// `lib/error-codes.js` 文件头的引用块）。
//
// 本插件此前给普通 `Error` 挂 `.code`（24 处），于是**全部退化成 `UNKNOWN`**。
// 284 份真实会话全量实测（`node scripts/scan-error-codes.mjs`）：
// 归因本插件的 **137/137** 条 error finishes 全是 `UNKNOWN`，官方 provider 丢码 **0**。
//
// 后果是官方的两个自动修复动作**对本插件从未生效，且不报错**：
//   ① 自动重试（`dsh-llm-retry`）：`retryableCodes` 恒不命中；
//   ② 超限自动压缩（`dsh-compaction-basic:862`）：`CONTEXT_WINDOW_EXCEEDED` 判据恒不命中。
//
// ## 本文件锁住四条
//
//   ① **每个登记的码都必须能穿过归一化**——包括将来新增的（漏带 `failure` 快照就红）。
//   ② **代码里不许再出现裸 `err.code = '...'`**——那是本缺陷的原始形状。
//   ③ **`EMPTY_RESPONSE` 必须在官方默认可重试集里**（这是本次唯一新增的「官方会替我们
//      重试」的码），且空回复错误确实带它。
//   ④ **`CONTEXT_WINDOW_EXCEEDED` 绝不能进 `retryableCodes`**——见下「反向验证」。
//
// ## 反向验证（改坏了必须变红）
//
// · 把 `withWebcodeCode` 里的 `err.failure = ...` 删掉 ⇒ ① 大面积变红；
// · 把 `CONTEXT_WINDOW_EXCEEDED` 加进 `WEBCODE_RETRY_POLICY.retryableCodes` ⇒ ④ 变红。
//
// ④ 为什么值得单独立一条：`dsh-base/cordis.patch.yml` 里 **`llm-retry`（:91）注册在
// `compaction-basic`（:341）之前**，waterfall 按注册顺序调用 ⇒ `llm-retry` 先拿到事件，
// 一旦命中就**不再 `next()`**（`dsh-llm-retry/lib/index.js:160`）。所以把
// `CONTEXT_WINDOW_EXCEEDED` 放进可重试集，会让超限请求被**原样重发** N 次，
// 而**官方的压缩修复永远不会跑**——静默毁掉它。这条判据把那个诱惑钉死。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { webcodeError, withWebcodeCode, WEBCODE_CODES, WEBCODE_RETRY_POLICY } from '../lib/error-codes.js';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

/**
 * 官方 `DEFAULT_RETRYABLE_CODES`（`dsh-llm/lib/types/retry-policy.js:16-22`）逐字复制。
 *
 * ⚠ **本测试刻意不去 import `@deepseek-ai/dsh-llm`**：它只存在于 profile / 宿主安装
 * 目录，不在本仓库工作区（实测 `ERR_MODULE_NOT_FOUND`）。静态 import 会让整个测试
 * 文件在裸跑形态下加载失败——而这条护栏恰恰要在裸跑时也能跑。
 * 代价是「官方默认集」在这里是一份**副本**；它变了这里不会自动知道，故：
 * 该集合的变更只可能来自 DSH 升级，而升级本来就要重跑真机验收（doc/verify.md）。
 */
const OFFICIAL_DEFAULT_RETRYABLE = Object.freeze([
  'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
]);

test('① 每个登记的码都能穿过官方归一化（快照必须与 code 一致）', () => {
  for (const code of Object.keys(WEBCODE_CODES)) {
    const err = webcodeError('测试: ' + code, code);
    // 官方 `ownFailureSnapshot` 的采信条件就是这两者一致。
    assert.equal(err.code, code, `${code}: err.code 必须等于入参`);
    assert.equal(err.failure.code, code, `${code}: failure.code 必须与 err.code 同源`);
    assert.equal(err.failure.message, err.message, `${code}: failure.message 必须与 message 同源`);
    // 官方读的是 own **data** 属性（Object.getOwnPropertyDescriptor + 'value' in descriptor）。
    const d = Object.getOwnPropertyDescriptor(err, 'failure');
    assert.ok(d && 'value' in d, `${code}: failure 必须是 own data 属性（getter 会被官方拒绝）`);
  }
});

test('①b withWebcodeCode 与 webcodeError 语义一致（同一对赋值）', () => {
  const a = withWebcodeCode(new Error('RATE_LIMITED: x'), 'RATE_LIMITED');
  assert.equal(a.code, 'RATE_LIMITED');
  assert.equal(a.failure.code, 'RATE_LIMITED');
  assert.equal(a.failure.message, 'RATE_LIMITED: x');
  // 就地修改：返回的就是同一个对象（调用点依赖这一点继续挂现场字段）。
  const orig = new Error('m');
  assert.equal(withWebcodeCode(orig, 'DRIVER_BUSY'), orig);
});

test('①c 非法入参要当场抛，不许静默造出无码错误', () => {
  assert.throws(() => webcodeError('m', ''), TypeError);
  assert.throws(() => webcodeError('m', null), TypeError);
  assert.throws(() => withWebcodeCode(new Error('m'), ''), TypeError);
  assert.throws(() => withWebcodeCode({ not: 'an error' }, 'X'), TypeError);
});

test('①d extra 现场字段仍然挂着（不被快照吞掉）', () => {
  const err = webcodeError('m', 'ATTACH_NOT_CONFIRMED', { attachDiag: { a: 1 }, accepted: 42 });
  assert.deepEqual(err.attachDiag, { a: 1 });
  assert.equal(err.accepted, 42);
  assert.equal(err.failure.code, 'ATTACH_NOT_CONFIRMED', 'extra 不得破坏快照');
});

test('② lib/ 下不许再出现裸 `err.code = \'...\'`（本缺陷的原始形状）', () => {
  const offenders = [];
  for (const name of fs.readdirSync(LIB)) {
    if (!name.endsWith('.js')) continue;
    const file = path.join(LIB, name);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // 只查**赋值语句**形状；注释里的说明（如 error-codes.js 的「不要手写」）不算。
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (/\.code\s*=\s*'[A-Z_]+'\s*;/.test(line)) offenders.push(`${name}:${i + 1}  ${trimmed}`);
    });
  }
  assert.deepEqual(
    offenders, [],
    '必须走 lib/error-codes.js 的 webcodeError / withWebcodeCode——裸赋值不带 failure 快照，'
    + '码会在 harness 边界退化成 UNKNOWN：\n' + offenders.join('\n'),
  );
});

test('③ EMPTY_RESPONSE 在官方默认可重试集里（本次唯一新增的「官方会重试」的码）', () => {
  assert.ok(
    OFFICIAL_DEFAULT_RETRYABLE.includes('EMPTY_RESPONSE'),
    '官方 EMPTY_RESPONSE_CODE 必须在默认集里（retry-policy.js:16-22）',
  );
  assert.ok(
    WEBCODE_RETRY_POLICY.retryableCodes.includes('EMPTY_RESPONSE'),
    '本插件的 retryableCodes 必须含 EMPTY_RESPONSE，否则空回复仍不会被重试',
  );
});

test('③b 真实空回复错误带 EMPTY_RESPONSE 码（两个抛点都要）', async () => {
  const { emptyWebResponseError } = await import('../lib/zero-progress.js');
  const err = emptyWebResponseError({ text: '', thinking: '', images: [] }, { lastEndReason: 'finished' });
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'EMPTY_RESPONSE');
  // 文案逐字不变：既有日志/告警与 test/empty-response.test.mjs 按它匹配。
  assert.match(err.message, /^empty response from web AI/);
  assert.match(err.message, /finished/, '报错必须带收束现场（报错自带取证的纪律）');
});

test('④ ⚠ CONTEXT_WINDOW_EXCEEDED 绝不许进 retryableCodes（会静默顶掉官方压缩修复）', () => {
  assert.ok(
    !WEBCODE_RETRY_POLICY.retryableCodes.includes('CONTEXT_WINDOW_EXCEEDED'),
    'llm-retry 注册在 compaction-basic 之前（dsh-base/cordis.patch.yml:91 vs :341），'
    + '命中即不再 next() ⇒ 超限请求会被原样重发 N 次，而官方的压缩修复永远不跑。'
    + '官方默认集里没有它，正是这个道理——保持原样。',
  );
  // 其余自定码同理：它们不在官方集里，且本插件有自己的退避（RATE_LIMITED 等）。
  const custom = Object.keys(WEBCODE_CODES).filter((c) => WEBCODE_CODES[c].official === false);
  const leaked = custom.filter((c) => WEBCODE_RETRY_POLICY.retryableCodes.includes(c));
  assert.deepEqual(leaked, [], '自定码不得混进官方可重试集：' + leaked.join(', '));
});

test('⑤ 策略形状满足官方 retryPolicyKey / recover 的读取要求', () => {
  const p = WEBCODE_RETRY_POLICY;
  assert.equal(p.mode, 'normal', '不用 always——那是无限重试，对浏览器驱动等于死循环');
  assert.ok(Number.isSafeInteger(p.maxRetries) && p.maxRetries >= 0);
  assert.ok(p.retryableCodes.length > 0, '官方 resolveRetryPolicy 拒绝空 retryableCodes');
  assert.equal(new Set(p.retryableCodes).size, p.retryableCodes.length, '不得有重复码');
  assert.ok(p.initialDelayMs > 0 && p.maxDelayMs > 0);
  assert.ok(p.initialDelayMs <= p.maxDelayMs, '官方校验 initialDelayMs <= maxDelayMs');
  assert.ok(p.jitterRatio >= 0 && p.jitterRatio <= 1, '官方校验 jitterRatio ∈ [0,1]');
  // 浏览器投递很贵：上限必须是 1，不是官方的 HTTP 默认 5。
  assert.equal(p.maxRetries, 1, '重试一次 = 再驱动一次浏览器；5 次是 HTTP 语义，不适用');
});

test('⑥ 登记表与真实抛点对得上（防新增抛点漏登记）', () => {
  // 扫出所有 webcodeError / withWebcodeCode 的字面量码，逐个必须在表里。
  const used = new Set();
  for (const name of fs.readdirSync(LIB)) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(LIB, name), 'utf8');
    for (const m of src.matchAll(/withWebcodeCode\(\s*err\s*,\s*'([A-Z_]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/webcodeError\(\s*[^,]+,\s*'([A-Z_]+)'/g)) used.add(m[1]);
  }
  const unregistered = [...used].filter((c) => !(c in WEBCODE_CODES));
  assert.deepEqual(
    unregistered, [],
    '这些码被抛出但没登记进 WEBCODE_CODES（新增抛点必须同时登记，否则没人知道它该不该被重试）：'
    + unregistered.join(', '),
  );
  assert.ok(used.size >= 15, `扫到的码太少（${used.size}）——判据可能已失效，请检查正则`);
});
