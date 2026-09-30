// profile-isolation.test.mjs — profile 落盘的测试隔离守卫（long-term-issues #37 的根因修复护栏）。
//
// ## 根因（真机取证 2026-09-30）
//
// 裸测试形态（apply() 不传 profileDir）回落 DEFAULTS 的**真实** ~/.dsh/webcode-edge-profile。
// settings / send-state / wait-stats 三个落盘路径此前**没有任何守卫**，后果两条（均实测）：
//   ① 裸测试读到真实 webcode-settings.json（sendGapMs=30000）与真实 send-state（24h 内
//      基准）→ regression/aux-delta-compact 的 WEB_SESSION_LOST 重放用例一轮真实等待
//      2×30s（60.02s），压线撞 node:test 的 60s 超时——#37 两条「常红」的根因，红绿随
//      本机状态漂移、与代码无关；
//   ② rememberSend 把测试的假发送时间戳**写回**真实 webcode-send-state.json（跑一遍
//      regression 后 deepseek 条目时间戳 = 测试运行时刻，逐字吻合）——用户的下一轮真实
//      请求被测试凭空压上发送间隔。
//
// 修法与 reply-log（lib/reply-log.js）/ prompt-store（lib/prompt-store.js）/
// continue-budget（lib/continue-budget.js）既有守卫严格同族：
//   profilePersistenceUsable = 显式传入 profileDir || 非测试进程（无 NODE_TEST_CONTEXT）
// 四个落盘点（settings 读 / settings 写 / send-state 读+写 / wait-stats 读+写 /
// cursor-state 读+写）共用同一判据。同时它修掉对称的另一半：旧 cursor-state 守卫
// 「只认显式 profileDir」把 DSH bundle 生产形态（cordis.patch.yml 不传 profileDir）
// 误杀——0.21.1 的游标持久化在生产从未生效（真实 profile 里没有
// webcode-cursor-state.json，实测），本守卫让「非测试进程」也放行。
//
// ## 本文件的跑法前提
//
// 守卫的测试分支只在 NODE_TEST_CONTEXT 在场时生效（node --test 设它；逐文件裸跑
// 按仓库纪律也要设 `NODE_TEST_CONTEXT=1`——见 doc/progress.md 多处「统一条件」段）。
// 因此本文件的用例自带前提断言：不设该变量时显式失败并说明跑法，而不是默默测了一个
// 不存在的守卫（那是「空转的闸门」的另一种形态）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const src = fs.readFileSync(path.join(repoRoot, 'lib', 'index.js'), 'utf8');

if (!process.env.NODE_TEST_CONTEXT) {
  test('profile 隔离守卫需要 NODE_TEST_CONTEXT（跑法前提）', () => {
    assert.fail('本文件必须在 NODE_TEST_CONTEXT=1 下跑（node --test 或逐文件跑时显式设该变量）；'
      + '不设它时守卫的「非测试进程放行」分支会把用例变成对真实 profile 的读写测试');
  });
} else {
  /** 真实 profile 里的四个守卫目标文件（裸测试形态绝不能碰它们）。 */
  const GUARDED_FILES = [
    'webcode-settings.json',
    'webcode-send-state.json',
    'webcode-wait-stats.json',
    'webcode-cursor-state.json',
  ];

  /** 文件快照：存在性 + mtimeMs + size（mtime 精度不够时 size 兜底）。 */
  function snapshot(dir) {
    const out = {};
    for (const name of GUARDED_FILES) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        out[name] = `${st.mtimeMs}:${st.size}`;
      } catch { out[name] = null; }
    }
    return out;
  }

  /** 建一个裸 apply（不传 profileDir）+ 假驱动的桥，返回 { dispose, adapter }。 */
  async function openBareBridge(driver) {
    const { apply } = await import('../lib/index.js');
    let adapter;
    const dispose = apply(
      { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null, inject() {} },
      { port: 0, requireConsent: false, driver },
    );
    return { adapter, dispose };
  }

  /** 跑一轮最小流（首轮 fresh），确保 send/commit/save 三条路径都被踏过。 */
  async function runOneTurn(adapter, sessionId) {
    const chunks = [];
    for await (const c of adapter.stream({
      sessionId,
      model: 'deepseek:deepseek',
      tools: [{ name: 'read', description: '读文件', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: '隔离用例' }] }],
    })) chunks.push(c);
    return chunks;
  }

  const realProfile = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh'), 'webcode-edge-profile');

  test('① 裸 apply（不传 profileDir）跑完整轮：真实 profile 的四个守卫文件不被创建或改写', async () => {
    const before = snapshot(realProfile);
    const driver = {
      status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
      sendTurn: async (key, prompt, opts) => { opts.onDelta?.('答'); return { text: '答' }; },
      sendPrompt: async () => ({ text: '答' }),
    };
    const { adapter, dispose } = await openBareBridge(driver);
    try {
      const chunks = await runOneTurn(adapter, 'iso-guard-1');
      assert.equal(chunks.at(-1).type, 'finish');
    } finally { await dispose(); }
    const after = snapshot(realProfile);
    for (const name of GUARDED_FILES) {
      assert.equal(after[name], before[name],
        `裸测试形态不得改写真实 profile 的 ${name}（修前实测：rememberSend 会把测试假时间戳写进 webcode-send-state.json）`);
    }
  });

  test('② 裸 apply 的发送零等待：不读真实 settings 的 sendGapMs，也不读真实 send-state 基准', async () => {
    // 判据取自真机现场：真实 settings 里 sendGapMs=30000、send-state 里有 24h 内基准时，
    // 修前的一轮发送会真实 sleep 到 30s（#37 的 60.02s 压线来自两段 30s）。守卫生效时
    // 同一轮必须毫秒级。上限给 10s：正常 <1s，留足 CI 负载余量；修复退化时会撞 30s+，
    // 远超此判据。
    const driver = {
      status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
      sendTurn: async (key, prompt, opts) => { opts.onDelta?.('答'); return { text: '答' }; },
      sendPrompt: async () => ({ text: '答' }),
    };
    const { adapter, dispose } = await openBareBridge(driver);
    try {
      const t0 = Date.now();
      await runOneTurn(adapter, 'iso-guard-2');
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 10_000, `裸测试一轮必须在秒级完成（实际 ${elapsed}ms）——修前会真实等待用户设置的发送间隔（实测 30s）`);
    } finally { await dispose(); }
  });

  test('③ 守卫判据形状：四个落盘点共用 profilePersistenceUsable，且放行分支含「非测试进程」', () => {
    // 源码结构断言（护栏的最后手段形态，配反向验证使用）：
    // 判据必须同时包含「显式 profileDir」与「非测试进程」两个放行分支——只有前者
    // 就是 0.21.1 的旧形状（bundle 生产形态被误杀）；只有后者则裸测试放行。
    assert.match(src, /const profilePersistenceUsable = \(\) => Boolean\(config && config\.profileDir\) \|\| !process\.env\.NODE_TEST_CONTEXT;/,
      '守卫判据必须同时放行「显式 profileDir」与「非测试进程」两个分支');
    // \s+ 吃掉行尾差异（仓库文件是 CRLF）。
    for (const anchor of [
      /if \(!profilePersistenceUsable\(\)\) return \{ \.\.\.defaultConfig \};/,               // settings 读
      /if \(!settingsSaveUsable\(\)\) return merged;/,                                        // settings 写
      /if \(!profilePersistenceUsable\(\)\) return;\s+try \{\s+const raw = JSON\.parse\(fs\.readFileSync\(sendStatePath/, // send-state 读
      /function saveSendState\(\) \{\s+if \(!profilePersistenceUsable\(\)\) return;/u,        // send-state 写
      /loadWaitStats\(\) \{\s+if \(!profilePersistenceUsable\(\)\) return/u,                  // wait-stats 读
      /function saveWaitStats\(\) \{\s+if \(!profilePersistenceUsable\(\)\) return;/u,        // wait-stats 写
    ]) {
      assert.ok(anchor.test(src), `守卫必须挡住该落盘点：${anchor}`);
    }
    // cursor-state 的读写共用 cursorPersistenceUsable（= profilePersistenceUsable 别名）。
    const cursorUses = (src.match(/cursorPersistenceUsable\(\)/g) || []).length;
    assert.ok(cursorUses >= 2, `cursor-state 的读与写必须都走守卫（实际 ${cursorUses} 处）`);
  });

  test('④ 显式 profileDir 的落盘不受守卫影响（行为不回归）', async () => {
    // 守卫只拦「裸形态」；显式传 profileDir 的既有测试形态（cursor-persistence 等
    // 118 文件里的既有覆盖）必须原样放行。这里用最小落盘读数验证一次：
    // 显式目录 + 一轮 → send-state 落盘出现（rememberSend 真的在写）。
    const { apply } = await import('../lib/index.js');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(repoRoot, 'test', '.tmp-iso-'));
    let adapter;
    const driver = {
      status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
      sendTurn: async (key, prompt, opts) => { opts.onDelta?.('答'); return { text: '答' }; },
      sendPrompt: async () => ({ text: '答' }),
    };
    const dispose = apply(
      { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null, inject() {} },
      { port: 0, requireConsent: false, driver, profileDir: dir },
    );
    try {
      await runOneTurn(adapter, 'iso-guard-4');
      const stateFile = path.join(dir, 'webcode-send-state.json');
      assert.ok(fs.existsSync(stateFile), '显式 profileDir 时 send-state 必须照常落盘（守卫不得误伤既有行为）');
      const entry = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.ok(entry.deepseek && Number.isFinite(entry.deepseek.send), 'deepseek 的发送基准必须已被记录');
    } finally { await dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
