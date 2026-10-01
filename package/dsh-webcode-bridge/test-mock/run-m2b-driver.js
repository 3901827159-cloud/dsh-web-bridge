// run-m2b-driver.js — E2E gate for the in-package driver architecture:
// standalone relay + playwright-driven system Edge (headless) against the
// local mock DeepSeek site. No extension involved.
//
//   1. consent gate starts CLOSED when WEBCODE_NO_CONSENT=1 → requests must fail fast
//   2. default form (0.19.31 起 consent 默认开，用户指令「连接自动化设为默认开启」）：
//      POST /v1/chat/completions (JSON) → mock answer via driver
//   3. POST /v1/chat/completions (SSE)  → chunk frames + [DONE]
//   4. THINK fragments never leak
//
// 0.19.52：本门此前在本机「恒 FAIL」的归因链（#9 的正文记录曾判 UNTESTABLE——
// spawn EPERM 之下断言从未真正跑过；danger-full-access 会话里真跑后的实锤）：
//   ① 旧断言「consent gate starts closed」停在 0.19.31 之前的默认语义（现在默认开）；
//   ② bin/bridge-standalone.js 的 driverFor 条件反了——mock 形态（WEBCODE_SITE 已设）
//      的 deepseek 请求被派去指向真实站点的懒驱动 ⇒ NEED_LOGIN ⇒ chars=0（同门修复）。

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const PORT = 30000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures += 1;
};

function start(script, args, env = {}) {
  const child = spawn(process.execPath, [join(pkg, script), ...args], {
    cwd: pkg, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, getOut: () => out };
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label);
    await delay(200);
  }
}

async function waitUp(base, ms = 10_000) {
  await waitFor(async () => {
    const s = await (await fetch(`${base}/bridge/status`)).json();
    return s.running;
  }, ms, 'relay');
  await waitFor(async () => (await fetch('http://127.0.0.1:8932/')).ok, ms, 'mock site');
}

/** 非流式响应的 content 兼容两种形态：旧字符串与 0.16.x 起的 parts 数组（图片支持）。 */
function textOf(completion) {
  const raw = completion?.choices?.[0]?.message?.content;
  return Array.isArray(raw)
    ? raw.filter((p) => p?.type === 'text').map((p) => p?.text || '').join('')
    : String(raw || '');
}

// mock 只起一份：A/B 两相共用（8932 是 mock 约定端口，两个桥各自随机端口）。
const mock = start('test-mock/mock-server.js', ['8932']);

// ---- A. 关闸形态：显式关过的 consent 存档（requireConsent=true + consent=false）----
// （一个排队 300s 的等待曾把 DSH UI 冻住——这条快拒就是防它复发的护栏。
//   注意不能用 WEBCODE_NO_CONSENT：那是「整条闸不存在」（requireConsent=false、
//   请求照常派发），不是「闸关着」。关闸的正确形态是 0.19.31 的「默认开 +
//   落盘记录里显式 accepted:false」。）
{
  const profileA = join(pkg, 'test-mock', '.driver-profile-a');
  rmSync(profileA, { recursive: true, force: true });
  mkdirSync(profileA, { recursive: true });
  writeFileSync(join(profileA, 'webcode-consent.json'), JSON.stringify({ accepted: false }), 'utf8');
  let bridgeA = null;
  try {
    bridgeA = start('bin/bridge-standalone.js', [String(PORT)], {
      WEBCODE_SITE: 'http://127.0.0.1:8932/',
      WEBCODE_PROFILE_DIR: profileA,
      WEBCODE_QUEUE_TIMEOUT_MS: '20000',
    });
    await waitUp(BASE);
    const st0 = await (await fetch(`${BASE}/bridge/status`)).json();
    ok('consent can be closed (explicit accepted:false)', st0.consent === false && st0.requireConsent === true,
      `consent=${st0.consent}, requireConsent=${st0.requireConsent}`);
    const tRefused = Date.now();
    const refusedResp = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-web', messages: [{ role: 'user', content: '不应被派发' }] }),
    });
    const refusedBody = await refusedResp.json();
    ok('no dispatch before consent (fast fail)', refusedResp.status === 503 && refusedBody?.error?.message?.includes('consent not granted') && Date.now() - tRefused < 5000, `status=${refusedResp.status}, ${Date.now() - tRefused}ms`);
  } catch (err) {
    failures += 1;
    console.log('  ❌ M2b gate-closed harness failure:', err.message);
  } finally {
    try { bridgeA?.child.kill(); } catch {}
  }
}

// ---- B. 默认形态：consent 默认开（0.19.31）+ 驱动端到端（JSON / SSE / THINK 不泄漏）----
const profile = join(pkg, 'test-mock', '.driver-profile');
let bridge = null;
try {
  rmSync(profile, { recursive: true, force: true });
  bridge = start('bin/bridge-standalone.js', [String(PORT)], {
    WEBCODE_SITE: 'http://127.0.0.1:8932/',
    WEBCODE_PROFILE_DIR: profile,
    WEBCODE_QUEUE_TIMEOUT_MS: '20000',
  });

  await waitUp(BASE);

  const st1 = await (await fetch(`${BASE}/bridge/status`)).json();
  ok('consent defaults to on (0.19.31 用户指令)', st1.consent === true, `consent=${st1.consent}`);

  // JSON completion through the driver
  const completion = await (await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-web', messages: [{ role: 'user', content: 'M2b 驱动冒烟 XYZ789' }] }),
  })).json();
  const content = textOf(completion);
  ok('end-to-end JSON via in-package driver', completion?.object === 'chat.completion' && content.includes('MOCK-ANSWER'), `chars=${content.length}`);
  ok('prompt reached the mock page', content.includes('XYZ789'), content.slice(0, 80));
  ok('THINK fragments never leak', !content.includes('思考片段'), content.slice(0, 80));

  // SSE completion
  const sseResp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-web', stream: true, messages: [{ role: 'user', content: 'M2b 流式' }] }),
  });
  const raw = await sseResp.text();
  const frames = raw.split('\n').filter((l) => l.startsWith('data: '));
  const text = frames.slice(0, -1).map((f) => { try { return JSON.parse(f.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; } }).join('');
  ok('end-to-end SSE via in-package driver', frames[frames.length - 1] === 'data: [DONE]' && text.includes('MOCK-ANSWER'), `frames=${frames.length}, chars=${text.length}`);

  const st2 = await (await fetch(`${BASE}/bridge/status`)).json();
  ok('driver healthy after turns', st2.driver?.running === true && st2.busy === false, JSON.stringify({ running: st2.driver?.running, busy: st2.busy }));
} catch (err) {
  failures += 1;
  console.log('  ❌ M2b harness failure:', err.message);
  if (bridge) console.log('  --- bridge ---\n' + bridge.getOut().slice(-2000));
  if (mock) console.log('  --- mock ---\n' + mock.getOut().slice(-600));
} finally {
  try { mock?.child.kill(); bridge?.child.kill(); } catch {}
}

console.log(failures === 0 ? '\nM2b RESULT: PASS' : `\nM2b RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
