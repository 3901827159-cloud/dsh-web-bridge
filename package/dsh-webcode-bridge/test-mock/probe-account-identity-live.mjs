// probe-account-identity-live.mjs — **活页面**版账号身份取证（2026-10-03）。
//
// # 为什么需要「活页面」这一版
//
// 另一版 `probe-account-identity.mjs` 走的是**拷贝落盘 profile** 的路子。它在
// 「桥正在运行」时**不可靠**，真机已核实（2026-10-03）：运行中的 Chromium 独占
// `<profile>/Default/Network/Cookies`，拷贝抛 EBUSY 后被静默吞掉 ⇒ 副本没有登录态，
// 页面渲染成游客态，而读数看起来「完全正常」。这与长期问题 #32（「拷 profile 副本式
// 探针拿到的是游客页」）同族，只是范围更大：**不是 kimi 特例，而是运行中的 profile 一律如此**。
//
// 因此本机唯一可靠的取证路径是**桥自己的活页面**：让桥连接该站点（它本来就持有
// 真实 profile 与登录态），再由 0.19.60 新增的 `debug` 通道把页面上的候选节点读出来。
//
// # 用法
//
//   node test-mock/probe-account-identity-live.mjs                 # 默认：/status 里 loggedIn===true 的全部槽
//   node test-mock/probe-account-identity-live.mjs doubao zai      # 指定站点
//   node test-mock/probe-account-identity-live.mjs deepseek#2      # 指定槽（`站点#槽`）
//   node test-mock/probe-account-identity-live.mjs --gap 25000     # 站点之间的间隔（默认 20s，风控纪律）
//   node test-mock/probe-account-identity-live.mjs --url http://127.0.0.1:19387
//
// 输出：`test-mock/out/account-identity-live-<siteId>[-<slot>]-<ts>.json`（每站一份）
//       stdout：每站的紧凑摘要（昵称候选 / 头像候选各前 8 条）。
//
// # 安全边界
//
//   · 只调**只读**动作：`connect`（幂等；已连上时只查一次登录态）与
//     `account-identity {debug:true}`（只读 DOM，不导航、不发消息、不点击）；
//   · **串行**并保持间隔（默认 20s）：这是仓库的风控纪律，不要改成并发；
//   · 不写任何站点数据；不碰 profile 目录。

import fs from 'node:fs';
import path from 'node:path';

const PKG = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const GAP_MS = Math.max(0, Number(argOf('--gap', '20000')));
const BASE = String(argOf('--url', process.env.DSH_WEB_URL || 'http://127.0.0.1:19387')).replace(/\/+$/, '');
const WANT = argv.filter((a, i) => !a.startsWith('--') && !['--gap', '--url'].includes(argv[i - 1]));

const OUT_DIR = path.join(PKG, 'test-mock', 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** 控制面请求。Origin 必须是同源（web-control 的 csrfSafe 判据），Host 必须是回环。 */
async function post(action, body, timeoutMs = 180000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + '/__webcode/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
    return { status: res.status, json, text };
  } finally { clearTimeout(timer); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseKey = (k) => { const i = String(k).indexOf('#'); return i < 0 ? { siteId: k, slot: '' } : { siteId: k.slice(0, i), slot: k.slice(i + 1) }; };

/** 默认名单：/status 里 loggedIn === true 的槽（未登录的站点读到的是游客页，取证没有意义）。 */
async function defaultTargets() {
  const res = await fetch(BASE + '/__webcode/status');
  const s = await res.json();
  const rows = Array.isArray(s?.driver?.sites) ? s.driver.sites : [];
  return rows.filter((r) => r && r.loggedIn === true).map((r) => (r.slot && r.slot !== 'default' ? r.siteId + '#' + r.slot : r.siteId));
}

const targets = WANT.length ? WANT : await defaultTargets();
if (!targets.length) { console.error('没有可取证的目标（/status 里没有 loggedIn===true 的槽）'); process.exit(1); }
console.log('[live-probe] base=' + BASE + '  目标 ' + targets.length + ' 个：' + targets.join(', ') + '  gap=' + GAP_MS + 'ms');

const summary = [];
for (let i = 0; i < targets.length; i++) {
  const key = targets[i];
  const { siteId, slot } = parseKey(key);
  const body = slot ? { siteId, slot } : { siteId };
  console.log('\n===== ' + key + ' =====');
  const rec = { target: key, siteId, slot, at: new Date().toISOString(), connect: null, identity: null, error: null };
  try {
    const c = await post('connect', body);
    rec.connect = c.json || { status: c.status, text: c.text.slice(0, 300) };
    console.log('  connect: ' + JSON.stringify(rec.connect).slice(0, 200));

    const idr = await post('account-identity', { ...body, debug: true });
    rec.identity = idr.json || { status: idr.status, text: idr.text.slice(0, 300) };
    const id = rec.identity || {};
    console.log('  身份读数: name=' + JSON.stringify(id.name) + '  basis=' + id.basis
      + (id.candidatesError ? '  candidatesError=' + id.candidatesError : ''));
    const cand = id.candidates;
    if (cand) {
      console.log('  url=' + cand.url + '  title=' + JSON.stringify(cand.title) + '  loginHints=' + JSON.stringify(cand.loginHints));
      console.log('  nameCandidates (' + cand.nameCandidates.length + ') 前 8:');
      for (const n of cand.nameCandidates.slice(0, 8)) console.log('    * ' + n.selectorHint + '  = ' + JSON.stringify(n.text) + '  score=' + n.score);
      console.log('  avatarCandidates (' + cand.avatarCandidates.length + ') 前 8:');
      for (const a of cand.avatarCandidates.slice(0, 8)) console.log('    * ' + a.selectorHint + '  src=' + String(a.src || a.bgUrl || '').slice(0, 70) + '  score=' + a.score);
      if (cand.notes?.length) for (const n of cand.notes) console.log('    ! ' + n);
    } else {
      console.log('  （无 candidates：驱动没有活页，或该站点未连接成功）');
    }
  } catch (e) {
    rec.error = String(e?.message || e);
    console.log('  ✗ ' + rec.error);
  }
  const file = path.join(OUT_DIR, 'account-identity-live-' + key.replace('#', '-') + '-' + TS + '.json');
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  console.log('  证据: ' + file);
  summary.push({ target: key, name: rec.identity?.name ?? null, nameCands: rec.identity?.candidates?.nameCandidates?.length ?? 0, avatarCands: rec.identity?.candidates?.avatarCandidates?.length ?? 0, file });
  if (i < targets.length - 1 && GAP_MS) { console.log('  …等待 ' + GAP_MS + 'ms（风控纪律：串行 + 间隔）'); await sleep(GAP_MS); }
}

console.log('\n===== 汇总 =====');
for (const s of summary) console.log('  ' + s.target.padEnd(12) + ' name=' + JSON.stringify(s.name).padEnd(14) + ' 昵称候选=' + s.nameCands + ' 头像候选=' + s.avatarCands);
