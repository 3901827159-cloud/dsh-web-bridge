// site-prompt-transport.test.mjs — 站点级「提示词投递形态」（0.19.32）。
//
// ## 用户原话
//
// > 「提示词投递：给每个模型站点都做到和『发送间隔（全局）』一样的逻辑：全局设置一个，
// >  但是针对每个单独网站设置能够单独设置」
//
// ## 为什么要做成「和发送间隔一样」
//
// 投递形态此前是**进程级**的一个开关（`promptTransport`）。而站点差异是真实存在的：
// deepseek 与 kimi 的输入框实测上限远低于全站默认阈值（见 browser-driver 的
// SITE_ATTACH_INLINE_LIMIT 取证）。全局只能二选一时，用户为了某一个站点收紧，
// 就得让**所有**站点一起改——这正是「发送间隔」当初加站点档要解决的问题，同构。
//
// ## 冻结契约（本文件的判据按它写）
//
// 回落链与 `accounts.sendGapForSlot` **逐字同构**：
//
//     站点档（本站点显式值） → 全局设置档 → 插件 config → 'attach'
//
//   · 站点档没配 ⇒ 逐字回到 0.19.31 的行为（这条最重要）；
//   · 站点档配了 ⇒ 覆盖全局，**只对本站点生效**；
//   · 站点档非法（手改设置文件写错）⇒ 视同没配，回落到全局那一档，
//     绝不产生第三种谁也没定义过的口径；
//   · 「跟随全局」用**删键**表达，落盘的字典里只有 'inline' / 'attach' 两个合法值。
//
// ## 四层各一条（缺一层就会出现「改了没生效」）
//
//   ① 判据层（真驱动）：站点档命中即覆盖，未命中回落全局——**行为**断言，不是源码 grep；
//   ② 现读纪律：读取函数每次现读（不是构造期快照），改设置立刻生效；
//   ③ 接线层：index.js 的**两个**构造点都传站点级读取函数（只传一个 ⇒ 账户2 分叉）；
//   ④ 面层（真 HTTP）：GET/POST settings 能往返；attach-status 按站点回答；
//      POST attach-status 必须存在（客户端带 body 就是 POST）。
//
// ③④ 是有来历的：0.15.3 真机上 `api('status', {sessionId})` 因「客户端 POST、服务端只注册
// GET」撞 405 而花名册永远读不到；0.16.3 的 promptTransport 也吃过「配置项够不着」
//（两个构造点只传一个）。同一个坑不踩第三次。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.dirname(import.meta.dirname);
const LIB = path.join(pkg, 'lib');

// ── ① 判据层：真驱动的 promptTransport 必须按站点合并 ─────────────────────────

test('① 站点档命中即覆盖全局；未命中逐字回落全局；非法值视同没配', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  const bySite = { glm: 'inline', kimi: 'attach' };
  const mk = (siteId, globalValue) => createBrowserDriver({
    siteId, site: 'https://example.com/',
    profileDir: path.join(pkg, '.tmp', 'siteprompt-' + siteId),
    headless: true,
    getPromptTransport: () => globalValue,
    getPromptTransportForSite: (sid) => bySite[sid],
  });

  // (a) 站点档命中 ⇒ 覆盖全局（全局是 attach，glm 被本站点压成 inline）。
  assert.equal(mk('glm', 'attach').status().promptTransport, 'inline',
    'glm 的站点档是 inline，status 却报了别的：站点级覆盖没生效');
  // (b) 反向：全局 inline、站点档 attach ⇒ 该站点必须是 attach（证明是**覆盖**不是单向收紧）。
  assert.equal(mk('kimi', 'inline').status().promptTransport, 'attach',
    'kimi 的站点档是 attach，status 却仍跟随全局 inline：覆盖只能往一个方向生效');
  // (c) 没配的站点逐字回落全局——**这一条是「没配就不改变行为」的主判据**。
  assert.equal(mk('qwen', 'inline').status().promptTransport, 'inline', '没配站点必须跟随全局');
  assert.equal(mk('qwen', 'attach').status().promptTransport, 'attach', '没配站点必须跟随全局');
  // (d) 非法值（手改设置文件写错）视同没配 ⇒ 回落全局，不产生第三态。
  const bad = createBrowserDriver({
    siteId: 'glm', site: 'https://example.com/',
    profileDir: path.join(pkg, '.tmp', 'siteprompt-bad'), headless: true,
    getPromptTransport: () => 'attach', getPromptTransportForSite: () => 'Inline',
  });
  assert.equal(bad.status().promptTransport, 'attach',
    '非法的站点档（大小写写错）必须退化成「跟随全局」，而不是被当成一个合法值');
  assert.equal(bad.status().promptTransportSite, null,
    '非法站点档必须报成「没有覆盖」（null）——报一个非法值会让面板显示第三种状态');
  // (e) 覆盖**存在性**必须可读：没配 null、配了就是那个值。
  assert.equal(mk('glm', 'attach').status().promptTransportSite, 'inline');
  assert.equal(mk('qwen', 'attach').status().promptTransportSite, null);
  // (f) 兼容性硬约束：**没传** getPromptTransportForSite 的调用点必须逐字走旧的
  // getPromptTransport（test/settings-transport.test.mjs ③ 钉的就是这条，新增一档
  // 不得把它改写）。
  const legacy = createBrowserDriver({
    siteId: 'glm', site: 'https://example.com/',
    profileDir: path.join(pkg, '.tmp', 'siteprompt-legacy'),
    headless: true, getPromptTransport: () => 'inline',
  });
  assert.equal(legacy.status().promptTransport, 'inline',
    '没传站点级读取函数时必须逐字走全局档（0.19.31 的既有语义不得被新增这一档改写）');
  assert.equal(legacy.status().promptTransportSite, null,
    '没接站点档时「覆盖存在性」必须是 null（没有覆盖，不是「覆盖成某个值」）');
});

// ── ② 现读纪律：读取函数每次现读，不是构造期快照 ──────────────────────────────

test('② 站点档也是现读：改设置后立刻生效（不是构造期快照）', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  let site = undefined;
  const d = createBrowserDriver({
    siteId: 'glm', site: 'https://example.com/',
    profileDir: path.join(pkg, '.tmp', 'siteprompt-live'), headless: true,
    getPromptTransport: () => 'attach',
    getPromptTransportForSite: () => site,
  });
  assert.equal(d.status().promptTransport, 'attach', '未覆盖时跟随全局 attach');
  site = 'inline';
  assert.equal(d.status().promptTransport, 'inline',
    '站点档改成 inline 后 status 没跟着变：状态是构造期快照，用户在设置页改了行为不会变');
  site = undefined;
  assert.equal(d.status().promptTransport, 'attach', '删掉站点档后必须立刻回到跟随全局');
});

// ── ③ 接线层：DEFAULTS 声明 + 两个构造点都传站点级读取函数 ────────────────────

test('③ index.js：声明 promptTransportBySite 默认值，且两个构造点都传站点级读取函数', () => {
  const src = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
  assert.match(src, /promptTransportBySite:\s*\{\}/,
    'index.js 的 defaultConfig 没有声明 promptTransportBySite（默认空对象 = 全部跟随全局）');
  const callSites = [...src.matchAll(/createBrowserDriver\(\{/g)].length;
  const siteSites = [...src.matchAll(/getPromptTransportForSite\s*:/g)].length;
  assert.ok(callSites >= 2, '只找到 ' + callSites + ' 个 createBrowserDriver 调用点');
  assert.equal(siteSites, callSites,
    '有 ' + callSites + ' 个驱动构造点，却只有 ' + siteSites + ' 处传了 getPromptTransportForSite：'
    + '漏传的那个槽会永远跟随全局——「账户2 的站点」与「默认槽的站点」行为分叉'
    + '（0.16.3 的 promptTransport 正是这么漏过一次）');
});

// ── ④ 面层：真 HTTP 控制面 ────────────────────────────────────────────────────

/** 最小 DSH 宿主替身 + 真 HTTP 服务（只挂本插件控制面路由）。 */
async function withControlPlane({ config = {}, driver }, fn) {
  const routes = new Map();
  const ctx = {
    llm: { registerAdapter() {} },
    webServer: { register(def) { routes.set(def.path, def); return () => {}; } },
    get: () => null,
  };
  const { apply } = await import(pathToFileURL(path.join(LIB, 'index.js')).href);
  const profileDir = fs.mkdtempSync(path.join(pkg, '.tmp', 'siteprompt-cp-'));
  fs.writeFileSync(path.join(profileDir, 'webcode-consent.json'), JSON.stringify({ accepted: true }), 'utf8');
  const disposer = apply(ctx, { port: 0, host: '127.0.0.1', requireConsent: false, driver, profileDir, ...config });
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://loopback').pathname;
    const def = routes.get(p);
    if (def) return def.handler(req, res);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = async (method, name, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/__webcode/${name}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
    });
    return { status: r.status, json: await r.json() };
  };
  try {
    return await fn({ get: (n) => call('GET', n), post: (n, b) => call('POST', n, b) });
  } finally {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    try { await disposer?.(); } catch { /* 测试替身，忽略 */ }
  }
}

/** 桩驱动：status 带着驱动自己算出来的合并值。 */
function statusStub({ siteId = 'deepseek', promptTransport = 'attach', promptTransportSite = null } = {}) {
  return {
    async sendTurn() { return { text: 'x' }; },
    async resetConversation() {},
    conversationFor() { return null; },
    status() {
      return {
        running: true, busy: false, siteId, preview: true,
        promptTransport, promptTransportSite, attachTransport: null, attachProbe: null,
        sessionSlot: { webSessionId: null, at: null, source: 'none' },
      };
    },
    async close() {},
  };
}

test('④ 控制面：站点档能往返，attach-status 按站点回答，且 POST 别名在', async () => {
  await withControlPlane({ driver: statusStub({}) }, async ({ get, post }) => {
    // (a) 默认：没有任何覆盖 ⇒ 全部跟随全局。
    const s0 = await get('settings');
    assert.deepEqual(s0.json.promptTransportBySite, {},
      'GET settings 必须把站点字典带回来（缺了前端会渲染成「加载失败」）：' + JSON.stringify(s0.json.promptTransportBySite));

    // (b) 写入能往返：只给 glm 一档，不碰全局。
    const w = await post('settings', { promptTransportBySite: { glm: 'inline' } });
    assert.equal(w.status, 200, 'POST settings 必须可用：' + w.status);
    const s1 = await get('settings');
    assert.deepEqual(s1.json.promptTransportBySite, { glm: 'inline' },
      '站点档写进去读不回来：' + JSON.stringify(s1.json.promptTransportBySite));
    assert.equal(s1.json.promptTransport, 'attach',
      '写站点档**不得**动到全局档（用户要的是「全局一个 + 各站点可单独设」两条独立设置）');

    // (c) 归一化：未知站点的键丢弃、非法值丢弃、非法键不留第三种值。
    await post('settings', { promptTransportBySite: { glm: 'inline', 'no-such-site': 'inline', kimi: 'Inline', qwen: 42 } });
    const s2 = await get('settings');
    assert.deepEqual(s2.json.promptTransportBySite, { glm: 'inline' },
      '站点档归一化不对（未知站点/非法值必须丢弃，只留合法项）：' + JSON.stringify(s2.json.promptTransportBySite));

    // (d) 删键 = 回落到跟随全局（不是一个第三值）。
    await post('settings', { promptTransportBySite: {} });
    const s3 = await get('settings');
    assert.deepEqual(s3.json.promptTransportBySite, {}, '删键后必须回到「全部跟随全局」');
  });

  // (e) attach-status 必须**按站点**回答，并说清是覆盖还是跟随。
  await withControlPlane({ driver: statusStub({ siteId: 'deepseek', promptTransport: 'attach' }) }, async ({ get, post }) => {
    await post('settings', { promptTransportBySite: { glm: 'inline' } });

    const g = await get('attach-status?siteId=glm');
    assert.equal(g.json.effective, 'inline',
      'glm 的站点档是 inline，attach-status 却报 ' + g.json.effective + '：面板会显示错的路');
    assert.equal(g.json.sitePick, 'inline', '必须能读出「本站点有覆盖」');
    assert.match(String(g.json.transportLine), /本站点单独设置/,
      '站点档命中时文案必须说出来，否则「跟随全局」与「已覆盖」看起来一样：' + g.json.transportLine);

    const q = await get('attach-status?siteId=qwen');
    assert.equal(q.json.effective, 'attach', '没配的站点必须跟随全局 attach');
    assert.equal(q.json.sitePick, null, '没配的站点 sitePick 必须是 null（没有覆盖）');
    assert.match(String(q.json.transportLine), /跟随全局/,
      '没配的站点文案必须说「跟随全局」：' + q.json.transportLine);

    // (f) POST 别名必须存在——客户端带 body 就是 POST（`api('attach-status', {siteId})`），
    //     只有 GET 会撞 405 + 空 body，那一行会永远停在「读数加载中…」（0.15.3 同款缺陷）。
    const p = await post('attach-status', { siteId: 'glm' });
    assert.equal(p.status, 200, 'POST attach-status 必须存在（客户端带 siteId 时走的就是它）：' + p.status);
    assert.equal(p.json.effective, 'inline', 'POST 与 GET 必须给出同一份读数');
  });
});

// ── ⑤ 面板：站点页必须有这一档入口，且写的是既有设置键 ────────────────────────

test('⑤ 面板必须给站点页一个「投递形态」入口，写 promptTransportBySite（不新造设置键）', () => {
  const src = fs.readFileSync(path.join(LIB, 'client.cjs'), 'utf8');
  assert.match(src, /saveSiteTransport/, '找不到站点级投递形态的保存函数');
  assert.match(src, /promptTransportBySite: next/,
    '站点级投递形态没有写到 promptTransportBySite —— 不要新造设置键（服务端只归一化这一个）');
  // 三态：跟随全局 / 附件投递 / 纯文本，缺一不可（缺「跟随全局」就没有清除覆盖的路）。
  for (const label of ['跟随全局', '附件投递', '纯文本']) {
    assert.ok(src.includes(label), '站点级投递形态缺选项：' + label);
  }
  // 独立设置页同样要有入口（两张设置面各写一份 UI 是本仓库的既有形态）。
  const page = fs.readFileSync(path.join(LIB, 'settings-page.js'), 'utf8');
  assert.match(page, /promptTransportBySite/, '独立设置页没有站点级投递形态入口');
  assert.match(page, /siteTransports/, '独立设置页缺少站点级投递形态的容器');
});

// ── ⑥ 设置写入后，派生读数必须能「跟上」（0.19.33）──────────────────────────────
//
// ## 用户原话
//
// > 「现在设置界面分站点的投递选择更改后提示词更新跟不上，请你修复」
//
// ## 真缺陷是什么
//
// 设置面有一批读数是服务端**现算**的（提示词模板 / 增量再教学 / 投递形态生效值），
// 而客户端的拉取时机此前只有「挂载时一次」：`usePromptVariants` 的 effect 依赖是
// `[load]`，而 `load` 是 `useCallback(fn, [])`。于是用户在站点页改完投递形态后，
// 那些读数永远停在首次挂载那一刻 —— 面板上「已保存」与「看到的仍是旧的」同时成立。
//
// ## 修法与判据
//
// 服务端在**每次落盘**后自增一个 settingsRevision，并随 /settings、/attach-status、
// /prompt-variants 一起回；客户端把它当依赖，号一变就重拉。
//
// 这一组判据分三层，缺一层就会出现「改了没生效」：
//   (a) 服务端：号必须随写入**前进**，且 POST 的响应里**当场**带回新号
//       （否则保存后还要等一个轮询周期，用户看到的仍是滞后）；
//   (b) 控制面：三条读数路由都必须带这个号（漏一条 ⇒ 那条读数不会重拉）；
//   (c) 客户端：所有设置写入点都必须把号应用到 state 上（漏一处 ⇒ 那条路径永远滞后），
//       且派生读数的 effect 依赖里必须有它。

test('⑥a 服务端：设置修订号随写入前进，且 POST 响应当场带回新号', async () => {
  await withControlPlane({ driver: statusStub({}) }, async ({ get, post }) => {
    const before = await get('settings');
    assert.equal(typeof before.json.settingsRevision, 'number',
      'GET settings 必须带 settingsRevision（否则客户端没有可依赖的「设置变了」信号）：'
      + JSON.stringify(before.json.settingsRevision));

    const w = await post('settings', { promptTransportBySite: { glm: 'inline' } });
    assert.equal(typeof w.json.settingsRevision, 'number',
      'POST settings 的响应必须**当场**带回新修订号：客户端据此在同一次交互里重拉读数，'
      + '否则「点了保存、提示词还是旧的」会一直持续到下一次轮询（甚至永远，如果没人轮询）');
    assert.ok(w.json.settingsRevision > before.json.settingsRevision,
      '写入后修订号没有前进（' + before.json.settingsRevision + ' → ' + w.json.settingsRevision
      + '）：客户端因此不会重拉任何派生读数');

    const after = await get('settings');
    assert.equal(after.json.settingsRevision, w.json.settingsRevision,
      'POST 回的号与随后 GET 到的号必须一致——两处不一致时客户端会白重拉或永远不重拉');
  });
});

test('⑥b 控制面：attach-status 与 prompt-variants 也必须带修订号', async () => {
  await withControlPlane({ driver: statusStub({ siteId: 'deepseek' }) }, async ({ get, post }) => {
    // attach-status：这一条是「当前生效：…」那一行的数据源，站点页保存后要重读它。
    const a = await get('attach-status?siteId=glm');
    assert.equal(typeof a.json.settingsRevision, 'number',
      'attach-status 必须带 settingsRevision：站点页保存后重读的那一次读不到号，'
      + '「当前生效：」那一行就会停在旧值');
    // prompt-variants：这一条是提示词模板 / 再教学的数据源。
    const v = await get('prompt-variants');
    assert.equal(typeof v.json.settingsRevision, 'number',
      'prompt-variants 必须带 settingsRevision：这是「提示词更新跟不上」的直接数据源');

    // 写入后三条读数必须给出**同一个新号**（同源，不是各算各的）。
    const w = await post('settings', { promptTransportBySite: { glm: 'inline' } });
    const a2 = await get('attach-status?siteId=glm');
    const v2 = await get('prompt-variants');
    assert.equal(a2.json.settingsRevision, w.json.settingsRevision,
      'attach-status 的号与写入回的号不一致');
    assert.equal(v2.json.settingsRevision, w.json.settingsRevision,
      'prompt-variants 的号与写入回的号不一致');
  });
});

test('⑥c 客户端：所有设置写入点都应用修订号，且派生读数的 effect 依赖里有它', () => {
  const src = fs.readFileSync(path.join(LIB, 'client.cjs'), 'utf8');

  // (1) 派生读数必须真的把号当依赖 —— 这是「重拉」成立的前提。
  assert.match(src, /function usePromptVariants\(revision\)/,
    'usePromptVariants 必须接受 revision：没有它，提示词模板与再教学的 effect 只能按挂载拉一次'
    + '（这正是用户报的「提示词更新跟不上」）');
  assert.match(src, /\}, \[revision\]\);/,
    'usePromptVariants 的 effect 依赖里没有 revision ⇒ 号变了也不会重拉');

  // (2) 三处消费点都要把号传下去（漏一处 ⇒ 那一处永远滞后）。
  for (const [re, what] of [
    [/usePromptVariants\(revision\)/, 'PromptPanel / SitePromptCard 的 hook 调用'],
    [/revision: settingsRevision/, 'SitePromptCard 的 revision prop'],
    [/h\(PromptSection, \{ revision: settingsRevision \}\)/, '全局页 PromptSection 的 revision prop'],
  ]) {
    assert.match(src, re, '缺少把修订号传到派生读数的那一跳：' + what);
  }

  // (3) 所有 api('settings', …) 写入点都必须应用号。
  //     判据是「每一个写入调用点的**函数体内**出现应用动作」，而不是全局数个数 ——
  //     数个数会漏掉「新加了一个 saver 但忘了应用」这一类，而那正是要防的。
  //
  //     两种合法形态（都用，取决于写入点在哪个组件里）：
  //       · 主设置组件内 → 直接 `applyRevision(r)`；
  //       · 另一个组件内（GlobalPrompt）→ `onRevision?.(r)` 回调。
  //         **不能**在子组件里直接调 applyRevision：那是跨作用域引用，点击时必然抛
  //         `ReferenceError: applyRevision is not defined`（本仓库 nav / sleep 同型）。
  const APPLIED = /applyRevision\(r\)|onRevision\?\.\(r\)/;
  const writePoints = [...src.matchAll(/await api\('settings', \{[^}]*\}\);/g)];
  assert.ok(writePoints.length >= 6,
    '只找到 ' + writePoints.length + ' 个设置写入点，夹具失效（预期至少 6 个）');
  for (const m of writePoints) {
    // 窗口刻意给得宽（1200 字符）：写入点后面常常跟着一段「为什么这么写」的注释
    //（本仓库的注释纪律要求把理由留在代码里），窗口太窄会把注释后面的应用动作
    // 切掉，于是护栏报出一个**假红**——那比漏报更糟，因为它会训练人放宽判据。
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    assert.match(after, APPLIED,
      '有一个设置写入点没有应用修订号：\n  ' + m[0]
      + '\n  ⇒ 这条路径保存后派生读数不会重拉（界面上完全看不出来：保存提示照常成功）');
  }

  // (4) 全局指令那条路径走的是组件外回调（GlobalPrompt 是另一个作用域，
  //     直接调主组件的 applyRevision 会抛 ReferenceError —— 本仓库的 nav/sleep 同型）。
  assert.match(src, /h\(GlobalPrompt, \{ onRevision: applyRevision \}\)/,
    'GlobalPrompt 必须通过 onRevision 回调拿到 applyRevision：跨组件直接调用会在点击时抛 ReferenceError');

  // (5) 独立设置页：保存后必须重读读数（只重拉模板会让「当前生效：」停在旧值）。
  const page = fs.readFileSync(path.join(LIB, 'settings-page.js'), 'utf8');
  assert.match(page, /refreshSiteTransportLines/,
    '独立设置页缺少逐站点生效读数的读取函数');
  const submitBlock = page.slice(page.indexOf("form.addEventListener('submit'"), page.indexOf("form.addEventListener('submit'") + 2600);
  assert.match(submitBlock, /loadTransportStatus\(\)/,
    '独立设置页保存后没有重读投递读数：那一行会停在旧值（保存成功与读数不变同时成立）');
});
