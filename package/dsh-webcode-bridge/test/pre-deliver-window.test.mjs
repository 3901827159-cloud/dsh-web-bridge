// pre-deliver-window.test.mjs — 投放前等待（发送间隔 / 限流退避 / 排队）**不属于网页生成耗时**，
// 因此不得计入适配器的无进展看门狗窗口（0.19.44）。
//
// ## 真机事故（2026-09-28，GLM）
//
// 用户原话：「1.超长时间刚开始加载--40 前面版本我记得都是马上就接着思考而不是现在等近两分钟！
// 才开始有 2. 本轮运行失败 WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，上一轮
// 收束原因（120s 前） finished，判定相位=网页还没开口且驱动不在忙（按常规窗口未宽限））
// — 本轮已中止，可重试」+「这个是不是叠加1的问题引起的？」
//
// 答案：**是**。`relay.submit()` 调用后看门狗计时器当场开跑，而 `relay.submit` 只是入队；
// 从那一刻到消息真正落进网页 composer 之间，桥还要做几件与网页生成无关的事：
//   · 发送间隔等待（真机设置 `sendGapMs: 30000` + `sendGapBasis: "end-to-start"`；旧版本是
//     10000 + 默认 send-to-send，见 `webcode-settings.json.bak-0140`）；
//   · 限流退避重试；
//   · relay 排队；
//   · 驱动懒创建 + `ensure()` 冷启动（GLM 非 deepseek 默认槽，创建点在 `attempt()` 里，
//     在间隔等待**之后**）。
//
// 真机一轮 GLM 实测 97,993ms（`webcode-send-state.json` 的 `send`/`end` 差），而 30s 间隔 +
// 附件上传（GLM 走 `uploadTextAttachment`，注释里就有 85k 实测 53s）已把 120s 窗口吃掉大半
// ⇒「网页还没开口」就撞线。
//
// ## 判据（本文件钉住的三件事）
//
// ① **间隔等待必须被扣出窗口**：首字节延迟在窗口内时，无论间隔多大，本轮都必须成功。
// ② **窗口本身不得被放大**：首字节延迟超过窗口时，必须照旧失败（防「顺手放宽窗口」）。
// ③ **既有安全线不得被削弱**：驱动不忙、以及「从未投放」两种情形照旧快报
//    （与 test/watchdog-first-byte.test.mjs ②③ 同一条纪律）。
//
// 时间尺度说明：真实窗口是 120s，这里压到**毫秒级**（`cfg.idleTimeoutMs` 可配正是为此）。
// 断言的是**窗口里算了什么**，不是墙钟数字。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ②③ 是反向安全线。修完 ① 之后若有人图省事把窗口一律乘倍数、或干脆去掉判死，
// ②③ 会变红。本修复的第一版**真的写错过**：只把「定值后的投放前时长」扣掉，
// 而长间隔等待进行中该值恒为 0，于是 gap≥3000ms 的用例仍然失败（驱动调用只有 1 次
// ——那一轮根本没送到驱动）。因此 ① 的用例把 gap 拉到窗口的 8 倍以上，
// 正是为了钉住「等待期间也不得判死」这一格。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);

/** 最小 DSH 宿主替身：只需要 llm.registerAdapter（与 watchdog-first-byte 同一形状）。 */
function mockCtx() {
  const registered = { adapter: null };
  const llm = {
    registerConfigurableProviders() {},
    registerAdapter(ids, adapter) { registered.adapter = adapter; },
  };
  const ctx = {
    llm,
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'webServer') return { register() {} };
      return undefined;
    },
  };
  return { ctx, registered };
}

/**
 * 脚本驱动：把「网页侧多久吐第一个字节」与「驱动是否在忙」变成可控输入。
 *
 * ⚠ 两条投递通道都要给：会话模式走 `sendTurn`，无状态轮走 `sendPrompt`
 *（lib/index.js 的两个调用点）。只给一个会让另一条路抛
 * `sendTurn is not a function`——本修复的验证脚本先后踩过这两个坑。
 */
function scriptedDriver({ firstByteDelayMs = 0, busy = true } = {}) {
  const calls = [];
  const deliver = async ({ onDelta, onThink } = {}) => {
    calls.push(Date.now());
    if (firstByteDelayMs) await new Promise((r) => setTimeout(r, firstByteDelayMs));
    onThink?.('（思考）');
    onDelta?.('网页答复');
    return { text: '网页答复', sessionId: 'sess-web-1', metrics: {} };
  };
  return {
    calls,
    async sendTurn(key, message, opts = {}) { return deliver(opts); },
    async sendPrompt(message, opts = {}) { return deliver(opts); },
    async resetConversation() {},
    status() {
      return {
        running: true, busy, preview: true, lastActivityAt: Date.now(),
        domReplyChars: null, lastEndReason: null, lastRecovered: null,
        lastStalledSettle: null, thinkingOnlyTurns: 0, recoveredTurns: 0,
      };
    },
    async close() {},
  };
}

/**
 * 建一个 apply 实例并在**同一实例上连跑两轮**。
 *
 * 为什么必须同实例连跑：发送间隔由 `sendStateByAccount` 记账，第一轮结束时才写下
 * `end`。只跑一轮的话 `computeSendGap` 拿不到基准、`waitMs` 恒为 0——间隔等待
 * 根本没发生，用例会静默假绿（「没有宽限也能过」是本项目出现过的一类假绿）。
 *
 * @returns {Promise<{warm: object, second: object, calls: number}>}
 */
async function runTwoTurns({ gapMs, firstByteDelayMs, busy = true, idleTimeoutMs = 1000, multiplier = 2, sendGapBasis = 'end-to-start' }) {
  const { apply } = await import(pathToFileURL(join(pkg, 'lib', 'index.js')).href);
  const driver = scriptedDriver({ firstByteDelayMs, busy });
  const { ctx, registered } = mockCtx();
  const profileDir = mkdtempSync(join(tmpdir(), 'webcode-predeliver-'));
  // 间隔走设置文件：executor 读的是**本轮 meta**（由设置派生），pluginConfig 够不着它。
  writeFileSync(join(profileDir, 'webcode-settings.json'),
    JSON.stringify({ defaultModel: 'deepseek:deepseek', sendGapMs: gapMs, sendGapBasis }), 'utf8');
  const disposer = apply(ctx, {
    port: 0, host: '127.0.0.1', requireConsent: false, driver, profileDir,
    wipIdleMs: 200, idleTimeoutMs, idleFirstByteMultiplier: multiplier,
  });
  const run = async () => {
    const t0 = Date.now();
    try {
      for await (const chunk of registered.adapter.stream({
        purpose: null, model: 'deepseek',
        messages: [{ role: 'user', content: '你好' }],
        tools: [], sessionId: 'predeliver-session',
      })) { /* 消费到底 */ }
      return { ok: true, ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, code: err?.code, msg: String(err?.message || '') };
    }
  };
  try {
    const warm = await run();
    const second = await run();
    // 投递时刻的原始读数（每次**真正交给驱动**那一刻的 epoch ms）。①b 用它量间隔：
    // 两轮的**墙钟之差**在 end-to-start 基准下不成立（见那条用例的注释）。
    return { warm, second, calls: driver.calls.length, callTimes: [...driver.calls] };
  } finally { try { disposer?.(); } catch { /* 测试替身 */ } }
}

// ── ① 正向：间隔等待必须被扣出窗口（这就是真机事故的修法）─────────────────
//
// 常规窗口 1200ms（max(wipIdleMs+1000, idleTimeoutMs)）、驱动忙 ×2 ⇒ 有效 ≈2600ms，
// 配合 250ms 的投放前轮询步长实测约 2600-2700ms。间隔最大取 20000ms（窗口的 8 倍），
// 首字节延迟固定 800ms（稳稳在窗口内）⇒ 每一档都必须成功。

test('① 发送间隔等待不计入看门狗窗口：间隔再大，首字节在窗口内就必须成功', async () => {
  for (const gapMs of [0, 1000, 2000, 3000, 5000, 8000, 20000]) {
    const r = await runTwoTurns({ gapMs, firstByteDelayMs: 800 });
    assert.equal(r.second.ok, true,
      `gap=${gapMs}ms 时本轮应当成功（间隔等待不属于网页生成耗时），实际报错：`
      + `${r.second.code} ${r.second.msg}`);
    // 驱动必须真的被调用 2 次（warm + second）。只 1 次说明第二轮**根本没送到驱动**
    // ——那正是修复前 gap≥3000ms 的现场，最容易被误读成「驱动慢」。
    assert.equal(r.calls, 2, `gap=${gapMs}ms 时驱动应当被调用 2 次（两轮各一次），实际 ${r.calls} 次`);
  }
});

test('①b 间隔确实发生了：两次投递的时间差必须体现等待（防「间隔根本没生效」的假绿）', async () => {
  // ## 为什么量「两次投递之差」，而不是「两轮墙钟之差」
  //
  // 旧判据是 `large.second.ms - small.second.ms > 3000`（两轮的**整轮墙钟**之差）。
  // 它在默认基准 `end-to-start` 下**恒不成立**：那个基准是从上一轮**生成结束**
  // 起算的，而上一轮「生成结束」到本轮提交之间还夹着驱动的稳态收尾（实测约 1.2s），
  // 那段时间会先吃掉一部分间隔 ⇒ 墙钟之差 ≈ gap − 1.2s，且**差多少取决于机器**。
  // CI（windows-latest）上实测 `4302ms vs 1514ms`（差 2788 < 3000）就是这样红的
  // ——判据在量一个与它想量的问题无关的量，不是产品缺陷。
  //
  // 现在改用 `send-to-send` 基准并直接量**驱动被调用的两次时刻之差**：那个基准
  // 从上一轮**发出**起算（`rememberSend` 就在投递前一刻），所以
  //     `calls[1] - calls[0]` 必须 ≥ gap，且 gap=0 时只剩驱动自身耗时。
  // 这个差值不掺任何别的成分，与机器快慢无关。
  //
  // 基准语义本身由 `test/send-gap-basis.test.mjs` 单独钉住，这里只负责
  // 「间隔真的发生了」这一条。
  const small = await runTwoTurns({ gapMs: 0, firstByteDelayMs: 300, sendGapBasis: 'send-to-send' });
  const large = await runTwoTurns({ gapMs: 4000, firstByteDelayMs: 300, sendGapBasis: 'send-to-send' });
  const dSmall = small.callTimes[1] - small.callTimes[0];
  const dLarge = large.callTimes[1] - large.callTimes[0];
  assert.ok(dSmall > 0 && dSmall < 2000,
    `gap=0 时两次投递只应相差驱动自身的耗时，实际 ${dSmall}ms`);
  assert.ok(dLarge >= 4000 - 200,
    'gap=4000 时两次投递的时间差必须几乎等于那 4000ms（说明间隔真的生效了）：'
    + `${dLarge}ms vs gap=0 时的 ${dSmall}ms`);
});

// ── ② 反向安全线：窗口本身不得被放大 ─────────────────────────────────────

test('② 首字节超过窗口 ⇒ 仍然判死（本修只扣等待，不放宽窗口）', async () => {
  const r = await runTwoTurns({ gapMs: 0, firstByteDelayMs: 4000 });
  assert.equal(r.second.ok, false, '首字节 4000ms 远超窗口（≈2600ms）必须仍报错');
  assert.match(String(r.second.code || ''), /WEB_NO_PROGRESS/);
  assert.ok(r.second.ms < 4000, `应按窗口判死而不是等首字节到达，实际 ${r.second.ms}ms`);
});

test('②b 扣等待≠免判死：间隔 3000ms + 首字节 4000ms ⇒ 仍必须判死', async () => {
  const r = await runTwoTurns({ gapMs: 3000, firstByteDelayMs: 4000 });
  assert.equal(r.second.ok, false,
    '扣掉间隔之后，首字节仍超出窗口 ⇒ 必须判死（防「修成永不超时」）');
  assert.match(String(r.second.code || ''), /WEB_NO_PROGRESS/);
});

// ── ③ 反向安全线：既有判据一格都不许动 ───────────────────────────────────

test('③ 驱动不在忙 + 首字节超窗口 ⇒ 仍按常规窗口快报，不得因本修被宽限', async () => {
  const r = await runTwoTurns({ gapMs: 0, firstByteDelayMs: 4000, busy: false });
  assert.equal(r.second.ok, false);
  assert.match(String(r.second.code || ''), /WEB_NO_PROGRESS/);
  // 常规窗口 1200ms（无倍数）⇒ 必须在 ~1200-1500ms 内开火，而不是等到 2600ms。
  assert.ok(r.second.ms < 2400,
    `驱动不忙时不得宽限（窗口 1200ms），实际 ${r.second.ms}ms`);
});

test('④ 从未投放（驱动挂住永不返回）⇒ 必须按窗口判死，不得永不失败', async () => {
  const { apply } = await import(pathToFileURL(join(pkg, 'lib', 'index.js')).href);
  const driver = scriptedDriver({ firstByteDelayMs: 0 });
  driver.sendTurn = async () => new Promise(() => {});
  driver.sendPrompt = async () => new Promise(() => {});
  const { ctx, registered } = mockCtx();
  const profileDir = mkdtempSync(join(tmpdir(), 'webcode-predeliver-hang-'));
  writeFileSync(join(profileDir, 'webcode-settings.json'),
    JSON.stringify({ defaultModel: 'deepseek:deepseek', sendGapMs: 0 }), 'utf8');
  const disposer = apply(ctx, {
    port: 0, host: '127.0.0.1', requireConsent: false, driver, profileDir,
    wipIdleMs: 200, idleTimeoutMs: 1000, idleFirstByteMultiplier: 2,
  });
  const t0 = Date.now();
  let err = null;
  try {
    for await (const chunk of registered.adapter.stream({
      purpose: null, model: 'deepseek',
      messages: [{ role: 'user', content: '你好' }],
      tools: [], sessionId: 'predeliver-hang',
    })) { /* 消费到底 */ }
  } catch (e) { err = e; } finally { try { disposer?.(); } catch { /* 测试替身 */ } }
  const dt = Date.now() - t0;
  assert.ok(err, '驱动挂住时本轮必须失败，而不是无限等待');
  assert.match(String(err?.code || ''), /WEB_NO_PROGRESS/);
  assert.ok(dt < 5000, `必须按窗口判死，实际等了 ${dt}ms`);
});
