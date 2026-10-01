// session-stay.test.mjs — 「落地 URL 会话锚」（0.19.52）的护栏。
//
// ## 用户原话与它钉住的行为
//
// > 「现在所有网站都有的：切换新会话网页端会，导致对话条目每天异常多，最好能够同步
// > 就是 dsh 里面会话没问题同一网页端会话，后续也能保证同一会话」
//
// 根因（真机读数 2026-09-30）：`CONVERSATION_URL_SHAPES/BUILDERS` 只有三家
//（deepseek/glm/kimi），其余七站 `conversationNav` 恒回 `unsupported` ⇒ 每一轮
// 非 fresh 都 WEB_SESSION_LOST → 上层整段重放 → **每轮新开一个网页对话**
//（`webcode-sessions-zai.json` / `-doubao.json` 恒 2 字节空对象——从未存下过映射）。
//
// 修法：无形状站点的会话身份 = **上一轮落地的地址**（landedUrl）。页面没被导航走
// ⇒ 仍在那条会话上 ⇒ 原地续聊（stay），不导航、不重放、不新开。
//
// ## 护栏分层
//
//   ① 判据层：conversationStay（contract.js 纯函数）的八种输入；
//   ② 行为层（真 sendTurn + 脚本页）：zai 形态——首轮落地 `/c/<uuid>`；第二轮
//      非 fresh **不再** WEB_SESSION_LOST（走到 composer 才失败），且槽不被丢；
//   ③ 反向红线：页面被导航到**另一条**会话 ⇒ 必须 WEB_SESSION_LOST（绝不把增量
//      发进别人的对话——三条不可越界约束之二）；
//   ④ 落盘层：null-id + landedUrl 的槽记录跨驱动实例读得回（loadStore 的新形态）；
//   ⑤ 接线层：sendTurn 的 stay 分支 / noteLanded 的 landedIdentity / 成功路径不
//      误删 landedUrl（源码结构断言——sendTurn 作用域拿不到句柄时的既有纪律）。
//
// 反向验证记录（2026-09-30）：把 sendTurn 里 stay 分支的 `conversationStay({...})`
// 改成 `false &&` ⇒ ② 变红（err.code === 'WEB_SESSION_LOST'）；把成功路径的
// `!conversationFor(key)?.landedUrl` 守卫删掉 ⇒ ② 变红（槽被 forget）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conversationStay } from '../lib/contract.js';

const LIB = path.join(import.meta.dirname, '..', 'lib');

/** 临时目录（沙箱下 os.tmpdir 可能受限，回落包内 .tmp）。 */
function tmpDir(prefix = 'webcode-stay-') {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  } catch {
    const d = path.join(import.meta.dirname, '.tmp', prefix + Date.now());
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

// ── ① 判据层：conversationStay 的八种输入 ─────────────────────────────────────

test('① conversationStay：同源同路径=留、query 漂移=留、换路径/根/异源=不留', () => {
  const base = { origin: 'https://chat.z.ai', freshPath: '/' };
  // 留：页面从落地起没动过。
  assert.equal(conversationStay({ ...base, currentUrl: 'https://chat.z.ai/c/abc', landedUrl: 'https://chat.z.ai/c/abc' }), true,
    '同一会话地址必须判「留」');
  // 留：站点自己补 query（kimi 实测会补 ?chat_enter_method=home）。
  assert.equal(conversationStay({ ...base, currentUrl: 'https://chat.z.ai/c/abc?x=1', landedUrl: 'https://chat.z.ai/c/abc' }), true,
    'query 漂移不算离开（pathname 才携带会话身份）');
  // 不留：换了一条会话（用户在窗口里手动点开别的对话）。
  assert.equal(conversationStay({ ...base, currentUrl: 'https://chat.z.ai/c/other', landedUrl: 'https://chat.z.ai/c/abc' }), false,
    '另一条会话绝不能判「留」——那是把增量发进别人的对话');
  // 不留：回到站点根（手动开了新会话/回了首页）。
  assert.equal(conversationStay({ ...base, currentUrl: 'https://chat.z.ai/', landedUrl: 'https://chat.z.ai/c/abc' }), false,
    '站点根不携带会话身份，判「留」会让增量进一个空会话');
  // 不留：锚本身就是根（不该出现——noteLanded 有同一道防线，这里再钉一层）。
  assert.equal(conversationStay({ ...base, currentUrl: 'https://chat.z.ai/', landedUrl: 'https://chat.z.ai/' }), false,
    '根路径不能当会话锚');
  // 不留：doubao 形态——fresh 页是 /chat/（非 '/'），会话是 /chat/<id>；锚=fresh 路径不算。
  assert.equal(conversationStay({ origin: 'https://www.doubao.com', freshPath: '/chat/', currentUrl: 'https://www.doubao.com/chat/', landedUrl: 'https://www.doubao.com/chat/' }), false,
    'freshPath 本身不是会话锚（doubao 的开新会话页就是 /chat/）');
  assert.equal(conversationStay({ origin: 'https://www.doubao.com', freshPath: '/chat/', currentUrl: 'https://www.doubao.com/chat/s1', landedUrl: 'https://www.doubao.com/chat/s1?from=home' }), true,
    'doubao 的会话路径（/chat/<id>）正常判「留」');
  // 不留：异源 / 缺锚 / 缺当前地址。
  assert.equal(conversationStay({ ...base, currentUrl: 'https://evil.example/c/abc', landedUrl: 'https://chat.z.ai/c/abc' }), false, '异源不留');
  assert.equal(conversationStay({ ...base, currentUrl: 'https://chat.z.ai/c/abc', landedUrl: null }), false, '没有锚不留');
  assert.equal(conversationStay({ ...base, currentUrl: '', landedUrl: 'https://chat.z.ai/c/abc' }), false, '没有当前地址不留');
  assert.equal(conversationStay({}), false, '空入参不留（不得抛错）');
});

// ── ②③ 行为层：真 sendTurn + 脚本页（zai 形态：无形状站点）──────────────────

/**
 * zai 形态的脚本页：站点根开页，登录判定那一相位之后地址变成 `/c/<uuid>`
 *（真机 2026-09-30 两轮一致：发送后页面导航到 /c/<uuid>）。composer 动作一律失败
 *（locator count=0）——正好让每一轮「导航成功、发送失败」，把护栏焦点钉在**导航判定**。
 *
 * evaluate 按调用者分派（靠函数源码的指纹串区分，脚本页只服务本文件的判定路径）：
 *   · detectChallenge（'waf-title'）→ null（无风控页）；
 *   · captureChainAlive（'__webcodeCaptureInstalled'）→ true（捕获链活着）；
 *   · visibleComposerCount / 其它（'offsetWidth'）→ 1（有可见 composer ⇒ 已登录）；
 *   · snapEvaluate=false 时不改地址（模拟「重启后的新页停在根」——锚回导航用例）。
 */
function zaiScriptedPage({ landOn, stuck = false, snapEvaluate = true } = {}) {
  let url = 'https://chat.z.ai/';
  const landedUrl = landOn || 'https://chat.z.ai/c/uuid-1';
  const page = {
    isClosed: () => false,
    url: () => url,
    async goto(u) { if (stuck) { url = landedUrl; return; } url = String(u); },
    async waitForSelector() { return null; },
    async evaluate(fn) {
      // 真机的「发送后地址切到会话页」压缩成「每次 evaluate 后地址都停在会话页」
      // ——与 ①c 的 scriptedPage 同型（evaluate 相位切地址）。为什么必须**每次**都切：
      // gotoFreshChat 看到「不在站点根」会先 goto 回根，若只切一次，noteLanded('nav')
      // 读到的又是根地址，锚就落不上。
      if (snapEvaluate) url = landedUrl;
      const src = String(fn);
      if (src.includes('waf-title')) return null;                 // detectChallenge：无风控
      if (src.includes('__webcodeCaptureInstalled')) return true;  // captureChainAlive：活着
      return 1;                                                    // visibleComposerCount 等：有输入框
    },
    on() {}, off() {},
    async close() {},
    locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
  };
  page.context = () => ({ on() {}, newPage: async () => page, close: async () => {} });
  return page;
}

test('② 行为：zai 无形状站点——首轮落地 /c/<uuid> 后，第二轮不再 WEB_SESSION_LOST', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  const profileDir = tmpDir('webcode-stay-a-');
  const d = createBrowserDriver({
    siteId: 'zai', site: 'https://chat.z.ai/', profileDir, headless: true,
    page: zaiScriptedPage(),
    requestTimeoutMs: 5_000,
  });
  try {
    // 首轮 fresh：落地在 /c/uuid-1（evaluate 相位切地址），composer 失败。
    let t1err = null;
    try { await d.sendTurn('sess-stay', '首轮提示词', { fresh: true }); }
    catch (err) { t1err = err; }
    assert.ok(t1err, '脚本页没有 composer 动作，首轮必然失败（与 ①c 同型）');
    const slot1 = d.status().sessionSlot;
    assert.equal(slot1.webSessionId, null, 'zai 解不出 id（没有地址形状），webSessionId 必须是 null');
    assert.equal(slot1.landedUrl, 'https://chat.z.ai/c/uuid-1',
      '首轮落地必须把地址锚进槽（这枚锚就是无形状站点的会话身份）：' + JSON.stringify(slot1));

    // 第二轮 !fresh：页面还停在 /c/uuid-1 ⇒ stay ⇒ 走到 composer 才失败，
    // 而**不是** WEB_SESSION_LOST（修前：no-stored-session ⇒ 整段重放 ⇒ 又开新对话）。
    let t2err = null;
    try { await d.sendTurn('sess-stay', '第二轮增量', { fresh: false }); }
    catch (err) { t2err = err; }
    assert.ok(t2err, '脚本页第二轮同样会在 composer 处失败');
    assert.notEqual(t2err?.code, 'WEB_SESSION_LOST',
      '页面明明还停在本轮会话上，却报了 WEB_SESSION_LOST（' + t2err?.code + '）——'
      + '这会触发整段重放并新开一个网页对话，正是本护栏要防的回归');
    const slot2 = d.status().sessionSlot;
    assert.equal(slot2.landedUrl, 'https://chat.z.ai/c/uuid-1',
      'stay 轮之后锚必须还在（丢锚 = 下一轮又整段重建）');

    // 会话丢失计数不应增长（stay 不是丢失）。
    assert.equal(d.status().sessionLostCount, 0, 'stay 轮不该计入 sessionLostCount');
  } finally {
    try { await d.close(); } catch { /* 脚本页 */ }
  }
});

test('③ 反向红线：页面被导航到另一条会话 ⇒ 必须 WEB_SESSION_LOST，绝不原地续聊', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  const profileDir = tmpDir('webcode-stay-b-');
  // 第一步：先在本 profile 上锚住一条会话（/c/uuid-1）——与 ② 同型。
  const d0 = createBrowserDriver({
    siteId: 'zai', site: 'https://chat.z.ai/', profileDir, headless: true,
    page: zaiScriptedPage({ landOn: 'https://chat.z.ai/c/uuid-1' }),
    requestTimeoutMs: 5_000,
  });
  try { await d0.sendTurn('sess-stay-x', '首轮提示词', { fresh: true }).catch(() => {}); } finally { try { await d0.close(); } catch {} }
  assert.equal(d0.sessionSlot('sess-stay-x').landedUrl, 'https://chat.z.ai/c/uuid-1',
    '前置：首轮应把锚落成 /c/uuid-1');

  // 第二步：同 profile 起新驱动，页面此刻停在**另一条**会话上（用户手动点开别的对话）。
  // stay 判据必须拒绝（pathname 不同）⇒ WEB_SESSION_LOST ⇒ 上层整段重建。
  const d = createBrowserDriver({
    siteId: 'zai', site: 'https://chat.z.ai/', profileDir, headless: true,
    page: zaiScriptedPage({ landOn: 'https://chat.z.ai/c/uuid-2', stuck: true }),
    requestTimeoutMs: 5_000,
  });
  try {
    let failed = null;
    try { await d.sendTurn('sess-stay-x', '增量', { fresh: false }); }
    catch (err) { failed = err; }
    assert.equal(failed?.code, 'WEB_SESSION_LOST',
      '页面在别人的会话上（/c/uuid-2，锚是 /c/uuid-1）时必须报 WEB_SESSION_LOST 让上层整段重建——'
      + '实际 ' + failed?.code + '：把增量发进没有前文的对话就是「跑着跑着变傻」');
    assert.equal(d.status().sessionLostCount, 1, '这次拒绝必须计入 sessionLostCount（可观测）');
  } finally {
    try { await d.close(); } catch { /* 脚本页 */ }
  }
});

test('③b 锚回导航：重启后的新页停在站点根时，导航回锚并验证成功 ⇒ 原地续聊', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  const profileDir = tmpDir('webcode-stay-d-');
  // 前置：锚住 /c/uuid-1（与 ② 同型）。
  const d0 = createBrowserDriver({
    siteId: 'zai', site: 'https://chat.z.ai/', profileDir, headless: true,
    page: zaiScriptedPage({ landOn: 'https://chat.z.ai/c/uuid-1' }),
    requestTimeoutMs: 5_000,
  });
  try { await d0.sendTurn('sess-restart', '首轮提示词', { fresh: true }).catch(() => {}); } finally { try { await d0.close(); } catch {} }
  assert.equal(d0.sessionSlot('sess-restart').landedUrl, 'https://chat.z.ai/c/uuid-1', '前置：锚已落成');

  // 重启形态：新驱动的新页**停在站点根**（snapEvaluate=false——evaluate 不再把地址
  // 拉回会话页），模拟「浏览器重启后 launch 出来的干净新页」。stay-goto 应导航回锚
  //（goto 是真导航），验证通过 ⇒ 原地续聊（而非 WEB_SESSION_LOST 整段重放）。
  const d = createBrowserDriver({
    siteId: 'zai', site: 'https://chat.z.ai/', profileDir, headless: true,
    page: zaiScriptedPage({ landOn: 'https://chat.z.ai/c/uuid-1', snapEvaluate: false }),
    requestTimeoutMs: 5_000,
  });
  try {
    let t2err = null;
    try { await d.sendTurn('sess-restart', '重启后的增量', { fresh: false }); }
    catch (err) { t2err = err; }
    assert.ok(t2err, '脚本页仍会在 composer 处失败（用例聚焦导航判定）');
    assert.notEqual(t2err?.code, 'WEB_SESSION_LOST',
      '锚回导航成功后仍报 WEB_SESSION_LOST（实际 ' + t2err?.code + '）——重启一次就丢会话，'
      + '「后续也能保证同一会话」不成立');
    assert.equal(d.status().sessionLostCount, 0, '锚回导航成功不算会话丢失');
    // navTrace 里应有 stay-goto + stay 两笔（排障读数）。
    const phases = d.status().navTrace.map((t) => t.phase).join(',');
    assert.ok(phases.includes('stay-goto'), 'navTrace 应记录锚回导航（stay-goto）：' + phases);
    assert.ok(phases.includes('landed:nav') || phases.includes('stay'), 'navTrace 应记录 stay/落地：' + phases);
  } finally {
    try { await d.close(); } catch { /* 脚本页 */ }
  }
});

// ── ④ 落盘层：null-id + landedUrl 的槽记录跨驱动实例读得回 ───────────────────

test('④ 落盘：landedUrl 形态的槽记录（webSessionId=null）跨实例读得回', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  const seeded = tmpDir('webcode-stay-c-');
  fs.writeFileSync(path.join(seeded, 'webcode-sessions-zai.json'), JSON.stringify({
    'sess-x::zai': { webSessionId: null, landedUrl: 'https://chat.z.ai/c/persist-1', at: 1_760_000_000_000, source: 'store' },
    // 脏记录（两个身份都没有）：必须被丢弃，不得让 loadStore 抛错。
    'sess-bad::zai': { webSessionId: null, at: 1 },
  }), 'utf8');
  const d = createBrowserDriver({ siteId: 'zai', site: 'https://chat.z.ai/', profileDir: seeded, headless: true });
  assert.equal(d.conversationFor('sess-x::zai')?.landedUrl, 'https://chat.z.ai/c/persist-1',
    'landedUrl 形态的记录没被读回来——loadStore 的旧判据只认 string webSessionId');
  assert.equal(d.conversationFor('sess-bad::zai'), null, '两个身份都没有的脏记录必须被丢弃');
  const slot = d.sessionSlot('sess-x::zai');
  assert.deepEqual(
    { webSessionId: slot.webSessionId, landedUrl: slot.landedUrl, source: slot.source },
    { webSessionId: null, landedUrl: 'https://chat.z.ai/c/persist-1', source: 'store' },
    'sessionSlot 投影必须如实带出 landedUrl 形态：' + JSON.stringify(slot));
});

// ── ⑤ 接线层：stay 分支 / landedIdentity / 成功路径守卫（源码结构）────────────

test('⑤ 接线：sendTurn 的 stay 分支、noteLanded 的地址锚、成功路径不误删', () => {
  const src = fs.readFileSync(path.join(LIB, 'browser-driver.js'), 'utf8');
  assert.match(src, /const staysNow = \(\) => Boolean\(currentUrl && conversationStay\(\{/,
    'sendTurn 必须在 unsupported 之后、抛错之前问一次 conversationStay（含锚回导航后的复问）');
  assert.match(src, /if \(!page \|\| page\.isClosed\?\.\(\)\) \{ try \{ await ensure\(\); \} catch/,
    'stay 分支判锚前必须先起页（懒启动下 sendTurn 阶段 page 还是 null——锚判据读不到地址）');
  assert.match(src, /reason: 'landed-url-stay'/,
    'stay 命中必须写进 nav reason（排障读数，与 fresh/resume 的 reason 同族）');
  assert.match(src, /phase: 'stay-goto'/,
    '锚回导航必须记 navTrace（stay-goto 相位——重启后续会话的排障读数）');
  assert.match(src, /landedIdentity/,
    'noteLanded 必须在解不出 id 时尝试「地址即身份」（landedIdentity）');
  assert.match(src, /else if \(navigate !== 'fresh' && !conversationFor\(key\)\?\.landedUrl\)/,
    '成功路径的 forget 守卫必须放行 landedUrl 形态——旧写法会把无形状站点的锚每轮丢一次');
  assert.match(src, /v\.webSessionId === null && typeof v\.landedUrl === 'string'/,
    'loadStore 必须接受 null-id + landedUrl 的新形态记录');
});
