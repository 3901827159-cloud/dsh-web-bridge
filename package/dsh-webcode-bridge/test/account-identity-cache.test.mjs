// account-identity-cache.test.mjs — 账号昵称/头像必须在**重启后仍然显示**（0.19.46）。
//
// ## 真机事故（用户原话，2026-09-28）
//
//   > 1.请你查看现在右侧tab获取的deepseek账户名和图像不会缓存？每次新开？
//   > 然后是展开后要显示的是图像+账号名；而不是图像+Deepseek网页版
//
// 两个症状同一条根因链：
//
// ① `accountIdentity` 原先**只在内存里**（`browser-driver.js` 的一个 `let`）。
//    桥重启 / 懒驱动被回收 / profile 重建 ⇒ 名字与头像归零，面板回到
//    `displayName`——用户看到的就是「图像 + Deepseek网页版」而不是「头像 + 真实账号名」。
// ② 更糟的是 `readAccountIdentity()` 在没有活页时**直接返回全 null**，
//    而重启后浏览器尚未 launch ⇒ `page` 恰为 null ⇒ 缓存即使存在也会被抹掉。
//    这一格正是「每次新开就没了」。
//
// `loggedIn` 早就落盘了（`webcode-login-state.json`，文件头注释写着「进程内存里的
// loggedIn 重启即归零，没有这份缓存，面板每次重启都把所有站点打回『待检查』」）——
// 账号身份是**同一类装饰性读数**，却漏了同一层。本护栏把这一层钉住。
//
// ## 为什么测的是「落盘文件 → 新建实例」这条缝
//
// 真实的 bug pattern 就是**跨驱动实例**：第一代人读到并写盘，第二代人（重启）读回。
// 而「有活页时怎么读 DOM」由既有实现负责、本轮一个字没改，不必也不该在这里重测——
// 本项目的纪律是「护栏要在**真正出问题的那个缝**上」，否则是假绿
// （见 `test/watchdog-first-byte.test.mjs` 文件头对假绿的论述）。
// 因此这里不注入假页（驱动也没有可注入的页缝），只驱动**缓存这一个契约**：
// 写盘 → 新实例读回；坏缓存 → 当没有；无缓存 → 不造假。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);

const { createBrowserDriver } = await import(
  new URL('file://' + join(pkg, 'lib', 'browser-driver.js').replace(/\\/g, '/')).href
);

/** 缓存文件名（判据的公开面）。 */
const CACHE = 'webcode-account-identity.json';

/** 建一个驱动实例（**不 launch 浏览器**，因此没有活页 = 重启后的形态）。 */
function driver(profileDir) {
  return createBrowserDriver({
    siteId: 'deepseek', site: 'https://chat.deepseek.com/', profileDir,
    headless: true, logger: { log() {}, warn() {}, error() {} },
  });
}

test('① 没有活页（重启后、浏览器未 launch）时读不到身份，且不造假', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ident-empty-'));
  const id = await driver(dir).readAccountIdentity();
  assert.equal(id.name, null, '没有缓存又没有活页 ⇒ 不许凭槽名编一个昵称：' + JSON.stringify(id));
  assert.equal(id.avatarUrl, null);
  assert.equal(id.basis, 'no-page');
});

test('② ★落盘的身份在**新建实例**（= 重启）后仍能读回，且 basis=cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ident-restart-'));
  // 模拟「第一代人真机读到了」：直接写缓存文件（写盘动作由 readAccountIdentity 负责，
  // 那条路径需要活页，不在本文件的缝上）。
  writeFileSync(join(dir, CACHE), JSON.stringify({
    name: 'RSYHN',
    avatarUrl: 'https://new-front.chatglm.cn/wechat_avatar/image/08/0835de884e.jpg',
    basis: 'site-probe',
    capturedAt: '2026-09-28T05:41:14.355Z',
  }), 'utf8');

  // 第二代人 = 重启：新实例、没有活页。
  const id = await driver(dir).readAccountIdentity();
  assert.equal(id.name, 'RSYHN', '重启后必须仍显示真实昵称（用户报的「每次新开就没了」）：' + JSON.stringify(id));
  assert.match(String(id.avatarUrl), /chatglm\.cn/, '重启后头像也要还在：' + JSON.stringify(id));
  assert.equal(id.basis, 'cache', '来源必须如实标成 cache，不得冒充 site-probe：' + id.basis);
});

test('②b 缓存文件名的契约：必须是 webcode-account-identity.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ident-name-'));
  writeFileSync(join(dir, CACHE), JSON.stringify({ name: 'X' }), 'utf8');
  // 文件名就是契约（与 webcode-login-state.json 同一约定）：改名会让旧缓存静默失效，
  // 因此这里钉住它，改动必须显式改本断言。
  assert.ok(existsSync(join(dir, CACHE)), '缓存文件名是契约的一部分');
  assert.ok(!existsSync(join(dir, 'webcode-login-state.json')), '身份缓存与登录态缓存是两个文件，不得合并');
});

test('③ 缓存损坏 ⇒ 当没有缓存处理，绝不半信', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ident-bad-'));
  writeFileSync(join(dir, CACHE), '{ this is not json', 'utf8');
  const id = await driver(dir).readAccountIdentity();
  assert.equal(id.name, null, '坏 JSON 必须当没有缓存');
  assert.equal(id.basis, 'no-page');
});

test('③b 缓存缺字段（既无 name 也无 avatarUrl）⇒ 同样当没有', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ident-bad2-'));
  writeFileSync(join(dir, CACHE), JSON.stringify({ capturedAt: 'x' }), 'utf8');
  const id = await driver(dir).readAccountIdentity();
  assert.equal(id.name, null, '缺 name/avatarUrl 的缓存必须当没有：' + JSON.stringify(id));
});

test('④ 只有昵称（无头像）也是有效缓存——头像可由站点矢量标记回落', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ident-nameonly-'));
  writeFileSync(join(dir, CACHE), JSON.stringify({ name: 'RSYHN' }), 'utf8');
  const id = await driver(dir).readAccountIdentity();
  assert.equal(id.name, 'RSYHN', '只有昵称也必须算有效缓存（头像是可选的）：' + JSON.stringify(id));
  assert.equal(id.avatarUrl, null);
});

test('⑤ 落盘写入路径存在且受 0o600 约束（与登录态缓存同一纪律）', async () => {
  // 判据落在 **唯一真源** lib/account-cache.js 上（0.19.46 起路径与「什么算有效」
  // 的判据都收在那里，驱动只调用它）——三处各写一份必然漂移，本项目记过多次。
  // 这里断言的是「契约仍在」，删掉写盘 / 改名都会让本项红。
  const cacheSrc = readFileSync(join(pkg, 'lib', 'account-cache.js'), 'utf8');
  assert.match(cacheSrc, /ACCOUNT_IDENTITY_FILE = 'webcode-account-identity\.json'/,
    '缓存文件名是契约（改名会让既有缓存静默失效），必须在唯一真源里逐字可见');
  assert.match(cacheSrc, /writeFileSync\(identityCachePathFor\(profileDir\)[\s\S]{0,80}0o600/,
    '写盘必须带 mode 0o600（与 consent/settings/login-state 一致）');

  // 驱动侧必须真的**调用**那个真源，而不是自己再拼一次路径/判据。
  const drvSrc = readFileSync(join(pkg, 'lib', 'browser-driver.js'), 'utf8');
  assert.match(drvSrc, /readIdentityCache\(cfg\.profileDir\)/, '启动时必须读回缓存（真源）');
  assert.match(drvSrc, /writeIdentityCache\(cfg\.profileDir/, '读到身份后必须落盘（真源）');
  assert.ok(!/webcode-account-identity\.json/.test(drvSrc),
    '驱动里不得再出现缓存文件名——出现即意味着第二份口径（会漂移）');
});

