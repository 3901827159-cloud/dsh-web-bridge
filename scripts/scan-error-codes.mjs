#!/usr/bin/env node
// scan-error-codes.mjs — 统计会话日志里**终止失败的错误码分布**，用来量
// 「本插件的错误码在 harness 边界活下来了没有」。
//
// ## 为什么需要这个文件
//
// DSH 的 `HarnessError.code` 是**唯一**的路由判据（`dsh-llm/lib/types/error.d.ts:13`
// 逐字：route on this, never by parsing `message`）。而 `dsh-llm` 的
// `normalizeLlmFailure()` 只对 `instanceof HarnessError` 保留 code，其余一律
// 归一化成 `UNKNOWN`（`dsh-llm/lib/types/adapter-failure.js:104-107`）。
//
// 本插件给普通 `Error` 挂 `.code`，于是**全部退化成 `UNKNOWN`**：
// 官方 `llm-retry` 的 `retryableCodes` 恒不命中 ⇒ 自动重试从未生效；
// `compaction-basic` 的 `CONTEXT_WINDOW_EXCEEDED` 判据恒不命中 ⇒ 自动压缩修复
// 从未触发。**这两件事都不会报错**，只会静默不发生。
//
// 所以「修好了没有」不能靠读代码判断，只能靠这个数字：
// **归因到本插件的 error finishes 里，还有多少条是 `UNKNOWN`。**
//
// 2026-10-02 基线（284 份会话）：171 条 error finishes，137 条 `UNKNOWN`（80.1%）；
// **137 条全部归因本插件**（存活率 0.0%），而官方 provider 丢码 **0** 条。
// 同码对照：`CONTEXT_WINDOW_EXCEEDED` 在官方适配器里活下来、在本插件里变成 UNKNOWN。
// 详见 `doc/research/2026-10-02-dsh-official-error-and-repair.md` §6。
//
// ## 用法
//
//   node scripts/scan-error-codes.mjs              # 全量：分布 + 归因拆分
//   node scripts/scan-error-codes.mjs --webcode    # 只看归因到本插件的消息
//   node scripts/scan-error-codes.mjs --json       # 机读（CI / 对照用）
//
// ## 判据（改完代码后照这条验收）
//
//   「归因本插件的 error finishes」中 `code=UNKNOWN` 的条数**应显著下降**。
//   理想是 0——但注意 §6.5：`RATE_LIMITED` 与官方 `RATE_LIMIT` **不是同一个码**，
//   只修异常类型而不对齐码名，`RATE_LIMITED` 仍不会被重试（但它至少不再显示
//   `UNKNOWN`，所以本脚本的数字仍会改善）。
//
// ## 刻意不做的事
//
//   · **不引第三方依赖**，也不 spawnSync（本机 spawnSync 调外部程序 EPERM，
//     见 `doc/progress.md` 的已知环境约束）。
//   · **不写任何文件**，只读会话日志并打印。
//   · **不改会话**：全部只读。
//
// 会话解码复用 `scripts/session-read.mjs` 的 `listAllSessions` / `readSessionLog`
// ——那里有多帧 zstd 的正确切法（帧尾不靠魔数硬切），不要在这里重写一遍。

import { listAllSessions, readSessionLog } from './session-read.mjs';

/**
 * 归因到本插件（`dsh-webcode-bridge`）的错误文案特征。
 *
 * ⚠ 这是**启发式**：靠消息文案判断，因为码本身已经丢了（这正是问题所在）。
 * 一旦码修好，这个表应当被「按 code 判」取代——那时 `--webcode` 才有可靠语义。
 * 表中每一项都来自真实日志的实测消息头（见研究文档 §6.3）。
 *
 * ⚠ `CONTEXT_WINDOW_EXCEEDED` 的**消息前缀**必须留在表里：本插件
 * `lib/index.js:1033` 的消息以 `CONTEXT_WINDOW_EXCEEDED: ` 开头，而**官方适配器
 * 的同类消息是 `400: {...}`**（裸 HTTP 状态 + JSON）。所以「消息以该码开头」
 * 恰是本插件独有的形状——漏掉它会把 2 条本插件的失败错算成官方失败
 * （首版就漏了，实测才发现）。
 */
const WEBCODE_MESSAGE = new RegExp([
  'WEB_NO_PROGRESS', 'WEB_SESSION', 'WEB_CAPTCHA',
  'RATE_LIMITED', 'TOOL_PROTOCOL_INVALID', 'PROMPT_TRUNCATED', 'PROMPT_WRITE_STALLED',
  'empty response from web AI', 'web capture ended', 'webcode relay',
  'locator\\.', 'page\\.goto', 'net::ERR_',
  'MODEL_UI_CHANGED', 'NEED_LOGIN', 'SEND_NOT_CONFIRMED', 'MODEL_UNAVAILABLE',
  'VISION_REQUIRES_IMAGE', 'DRIVER_BUSY', 'BRIDGE_ACCOUNT_BUSY', 'COOKIE_IMPORT',
  'ATTACH_UNAVAILABLE', 'ATTACH_NOT_CONFIRMED', 'STREAM_REWRITE',
  // 本插件在发送前拦下越界时用这个前缀（官方同码消息是 `400: {...}`）。
  'CONTEXT_WINDOW_EXCEEDED:',
].join('|'));

/**
 * 收集全部会话里 `reason.kind === 'error'` 的终止失败。
 *
 * 只看 `turn/end` 与 `step/end` 的 `reason`——那才是「这一轮/这一步以错误收场」的
 * 权威记录（`dsh-agent-loop/lib/index.js:1118-1134` 把 finish 的 failure 落到这里）。
 *
 * @returns {{total:number, unknown:number, webTotal:number, webUnknown:number,
 *            officialUnknown:number, codes:Record<string,number>,
 *            webMessages:Array<{count:number, message:string, code:string}>,
 *            sessions:number, unreadable:number}}
 */
export function scanErrorCodes() {
  const codes = {};
  const webMsg = new Map();
  let total = 0;
  let unknown = 0;
  let webTotal = 0;
  let webUnknown = 0;
  let officialUnknown = 0;
  let sessions = 0;
  let unreadable = 0;

  for (const entry of listAllSessions()) {
    let report;
    try {
      report = readSessionLog(entry.file);
    } catch {
      unreadable += 1;
      continue;
    }
    sessions += 1;
    for (const event of report.events) {
      const reason = event?.data?.reason;
      if (!reason || reason.kind !== 'error') continue;
      const failure = reason.error ?? {};
      // `code` 缺失也算一种失败形态（本插件有若干裸 Error 无 code）。
      const code = typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : '(missing)';
      const message = String(failure.message ?? '');
      const isWebcode = WEBCODE_MESSAGE.test(message);

      total += 1;
      codes[code] = (codes[code] ?? 0) + 1;
      if (isWebcode) webTotal += 1;
      if (code === 'UNKNOWN') {
        unknown += 1;
        if (isWebcode) {
          webUnknown += 1;
          const key = message.slice(0, 44);
          const prev = webMsg.get(key);
          webMsg.set(key, { count: (prev?.count ?? 0) + 1, message: key, code });
        } else {
          officialUnknown += 1;
        }
      }
    }
  }

  return {
    total,
    unknown,
    webTotal,
    webUnknown,
    officialUnknown,
    codes,
    webMessages: [...webMsg.values()].sort((a, b) => b.count - a.count),
    sessions,
    unreadable,
  };
}

/** 百分比（分母为 0 时回 `n/a`，避免打印 `NaN%`）。 */
function pct(part, whole) {
  return whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : 'n/a';
}

function main() {
  const argv = process.argv.slice(2);
  const result = scanErrorCodes();

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (argv.includes('--webcode')) {
    process.stdout.write(`归因本插件的失败消息（${result.webTotal} 条，其中 ${result.webUnknown} 条 code=UNKNOWN）\n\n`);
    for (const row of result.webMessages) {
      process.stdout.write(`${String(row.count).padStart(5)}  ${JSON.stringify(row.message)}\n`);
    }
    return;
  }

  process.stdout.write(`会话 ${result.sessions} 份（不可读 ${result.unreadable}）\n`);
  process.stdout.write(`终止失败（reason.kind=error）合计: ${result.total}\n`);
  process.stdout.write(`  code=UNKNOWN            : ${result.unknown} (${pct(result.unknown, result.total)})\n`);
  process.stdout.write(`    归因本插件            : ${result.webUnknown}\n`);
  process.stdout.write(`    非本插件（官方 provider）: ${result.officialUnknown}\n`);
  process.stdout.write(`归因本插件的失败合计      : ${result.webTotal}\n`);
  if (result.webTotal > 0) {
    process.stdout.write(
      `  ⇒ 本插件错误码存活率     : ${pct(result.webTotal - result.webUnknown, result.webTotal)}`
      + `（基线 2026-10-02 为 0.0%）\n`,
    );
  }
  process.stdout.write(`\n全部码分布: ${JSON.stringify(result.codes)}\n`);
  process.stdout.write('\n下一步：node scripts/scan-error-codes.mjs --webcode\n');
}

// 只在直接执行时跑 main（被 import 时只导出函数）。
//
// ⚠ 判据用 `pathToFileURL` 而不是手拼 `file://`：Windows 盘符路径
// （`D:\...`）拼成 `file://D:/...` 与 `import.meta.url` 的 `file:///D:/...`
// **不相等**，手拼会让脚本被直接执行时**静默什么都不做**。
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
