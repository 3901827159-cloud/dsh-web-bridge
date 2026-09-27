#!/usr/bin/env node
// real-attach-ingest-kimi.mjs — kimi 站点级附件阈值收紧的真机判定探针。
//
// 背景（2026-09-25）：kimi 轮 38,807 字符在全站默认 60,000 之下走 inline，
// 而 kimi contenteditable 输入框实测上限 ~20K，超限部分**静默丢失**——模型
// 只见前半，会话上下文被无声截断（详见 browser-driver.js SITE_ATTACH_INLINE_LIMIT
// 表的 kimi 注释）。本支隔离验证两件事：
//   ① 收紧阈值后，典型尺寸（> 8,000）的轮真的走附件（attachTransport === 'attach'）
//   ② 附件正文真的被模型读到（标记值回显，与 deepseek 版同构的内容级判定）
//
// 判定手法（内容级，不可伪证）：把标记**只写进附件正文**，随附指令只说
// 「把附件里那一行的值回给我」。模型若没读附件，就不可能知道那个值。
import path from 'node:path';
import { createBrowserDriver } from '../lib/browser-driver.js';

const PROFILE = process.env.REAL_PROFILE || path.join(process.cwd(), '.tmp', 'real-profile-kimi-probe');
const MARK = 'ZK77';
const sizes = (process.env.ATTACH_SIZES || '3500,20000,39000').split(',').map(Number);

const driver = createBrowserDriver({
  site: 'https://www.kimi.com/', profileDir: PROFILE, headless: true,
  requestTimeoutMs: 200_000, attachInlineLimitChars: 500, logger: console,
});

function bodyOf(size) {
  const head = '以下是本地工程的上下文快照。\n';
  const marker = `ATTACH_MARKER_7f3a=${MARK}\n`;
  const pad = '填充行：本地上下文占位内容，用于把附件推到目标尺寸。\n';
  let s = head + marker;
  while (s.length < size) s += pad;
  return s.slice(0, size);
}

const rows = [];
try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }
  for (const size of sizes) {
    const body = bodyOf(size);
    const instruction = '附件里有一行以 ATTACH_MARKER_7f3a= 开头的记录，请只回那个等号后面的值（不要解释）。';
    const key = 'real-ingest-kimi-' + size;
    const t0 = Date.now();
    let acc = '';
    let err = null;
    try {
      const r = await driver.sendTurn(key, body + '\n\n' + instruction, { fresh: true, model: 'kimi', onDelta: (d) => { acc += d; } });
      if (!acc) acc = r?.text || '';
    } catch (e) { err = e?.message || String(e); }
    const st = (() => { try { return driver.status(); } catch { return null; } })();
    const text = String(acc).trim();
    rows.push({
      size,
      ms: Date.now() - t0,
      replyChars: text.length,
      markerEchoed: text.includes(MARK),
      promptChars: st?.driver?.attachTransport?.chars ?? null,
      attachTransport: st?.driver?.attachTransport ?? null,
      attachBlocked: st?.driver?.attachBlocked ?? null,
      lastEndReason: st?.driver?.lastEndReason ?? null,
      lastTimeoutScene: st?.driver?.lastTimeoutScene ?? null,
      error: err,
      replyHead: text.slice(0, 100),
    });
    console.log('\n--- size=' + size + ' ---');
    console.log(JSON.stringify(rows.at(-1), null, 2));
    await driver.resetConversation(key).catch(() => {});
  }
} catch (e) {
  console.log('ERR: ' + (e?.message || e));
} finally {
  try { await driver.close(); } catch {}
}
console.log('\n===== 汇总 =====');
for (const r of rows) console.log(`size=${r.size} ms=${r.ms} replyChars=${r.replyChars} markerEchoed=${r.markerEchoed} transport=${r.attachTransport?.transport ?? '-'} endReason=${r.lastEndReason} err=${r.error || '-'}`);
const allAttach = rows.filter((r) => r.size > 8_000).every((r) => r.attachTransport?.transport === 'attach');
const allRead = rows.length > 0 && rows.every((r) => r.markerEchoed);
console.log(`\nRESULT(阈值收紧生效·>8K 走附件): ${allAttach ? 'PASS' : 'FAIL'}`);
console.log(`RESULT(附件被读): ${allRead ? 'PASS（每个尺寸都回出了只在附件里的值）' : 'PARTIAL/FAIL'}`);
