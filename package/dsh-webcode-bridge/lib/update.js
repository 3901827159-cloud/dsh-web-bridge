// update.js — 本插件的「检查更新 / 安装 / 重启提醒」逻辑层（0.19.39）。
//
// 需求（用户原话）：「参考 dsh-store 的设置界面顶部『插件市场 / dsh-market /
// v1.65.1 / 更新插件市场 / 本次全部忽略』设计好本插件的更新和只做提醒重启操作，
// 替换现在空白的单独 github 按钮」。
//
// 三个设计决定，各有理由：
//
// 1. **只提醒重启，绝不代重启**。「装完不重启 dsh web = 等于没装」是本项目反复
//    记录过的一条事实（README 与 doc/progress.md 都写着）。但重启 dsh web 会
//    终止正在跑的会话——而那正是用户此刻在用的东西。所以装完之后给的是**一句
//    提醒**，不是一次自动重启。这是「只做提醒重启操作」的字面含义。
//
// 2. **检查走 npm registry，装走 dsh CLI**。检查是一个只读 HTTP GET（registry 的
//    packument），装是一次真的进程调用。两者失败面完全不同，因此分开两个动作：
//    查不到就说查不到（不假装「已是最新」），装失败就报退出码与 stderr 片段。
//
// 3. **纯判据与本进程调用分离**。版本解析/比较/挑最新版全是纯函数（可离线反向
//    验证，见 test/update.test.mjs），只有 `runInstall` 碰 child_process——
//    这样「哪个版本算更新」这件事不依赖任何进程或网络就能钉死。

import { spawn } from 'node:child_process';

/** 本插件的包名（检查更新与安装都用它，写一处避免两处漂移）。 */
export const PACKAGE_NAME = 'dsh-webcode-bridge';

/** 默认 registry。可用 WEBCODE_REGISTRY 覆盖（企业内网/镜像场景）。 */
export const DEFAULT_REGISTRY = process.env.WEBCODE_REGISTRY || 'https://registry.npmjs.org';

/**
 * 把一个 semver 字符串解析成可比较的三段数字 + 预发布标记。
 *
 * 为什么自己写而不引 semver 包：本插件**零运行时依赖**（只有 playwright-core），
 * 而这里需要的比较规则很窄——「谁是更新的正式版」。引一个包来回答这一个问题，
 * 换来的是一份供应链面。
 *
 * 预发布（`1.2.3-rc.1`）**不参与**「谁更新」的比较：`1.2.3-rc.1` 与 `1.2.3` 的
 * 数字段相同，而正式版应当胜过同号的预发布。因此预发布标记只用来**排除**候选
 *（见 pickLatest），不用来排序——这比实现完整的 semver 优先级规则更不容易出错。
 *
 * @param {string} v
 * @returns {{major:number,minor:number,patch:number,prerelease:string}|null} 解析失败返回 null
 */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] || '' };
}

/**
 * 比较两个版本号。
 *
 * @returns {number} a>b → 1，a<b → -1，相等或无法比较 → 0
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;   // 无法比较时**不猜**：返回 0 表示「不分高下」
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  // 数字段相同：正式版 > 预发布版；两个预发布之间不排序（返回 0）。
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  return 0;
}

/**
 * 从 npm packument 里挑出**最新的正式版**。
 *
 * 为什么不用 packument 的 `dist-tags.latest`：它可能指向一个预发布版（发布者
 * 用 `npm publish --tag latest` 就能做到），而本插件不想把一个 rc 当成「有更新」。
 * 因此按 `versions` 里的键自己挑——**只认正式版**。
 *
 * `dist-tags.latest` 仍作为**后备**：若 versions 全被过滤光（例如该包只发过 rc），
 * 就用它，而不是回答「没有更新」——那会把「有得装」说成「没得装」。
 *
 * @param {object} packument npm registry 的响应体
 * @returns {string|null}
 */
export function pickLatest(packument) {
  const versions = packument && typeof packument === 'object' && packument.versions && typeof packument.versions === 'object'
    ? Object.keys(packument.versions)
    : [];
  let best = null;
  for (const v of versions) {
    const p = parseVersion(v);
    if (!p || p.prerelease) continue;   // 预发布不参与「谁最新」
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  if (best) return best;
  const tag = packument && packument['dist-tags'] && packument['dist-tags'].latest;
  return parseVersion(tag) ? String(tag) : null;
}

/**
 * 判据：当前版本 vs registry 上的最新版。
 *
 * 返回的 `status` 只有三种，每种对应一句**可以说出来的话**：
 *   · `current`  —— 已是最新（或当前版本比 registry 还新，本地 tgz 场景很常见）
 *   · `outdated` —— 有新版，给出 latest
 *   · `unknown`  —— 查不到（网络失败/包不存在/版本号不可解析）
 * `unknown` **不是** `current`：把「没查到」说成「已是最新」是本项目反复记过的
 * 假陈述。调用方据此显示的是「检查失败」而不是一个绿色的「已是最新」。
 *
 * @param {{current?:string, packument?:object, error?:string}} o
 * @returns {{status:'current'|'outdated'|'unknown', current:string, latest:string|null, reason?:string}}
 */
export function updateDecision({ current, packument, error } = {}) {
  const cur = String(current || '').trim();
  if (!parseVersion(cur)) return { status: 'unknown', current: cur, latest: null, reason: '当前版本号无法解析' };
  if (error) return { status: 'unknown', current: cur, latest: null, reason: String(error).slice(0, 160) };
  const latest = pickLatest(packument);
  if (!latest) return { status: 'unknown', current: cur, latest: null, reason: 'registry 上没有可用的正式版' };
  // compareVersions > 0 才算「有新版」：等于不算，更**新**的当前版也不算
  //（本地 tgz 比 registry 新是真实存在的状态，那时不该提示「有更新」）。
  return compareVersions(latest, cur) > 0
    ? { status: 'outdated', current: cur, latest }
    : { status: 'current', current: cur, latest };
}

/**
 * 到 registry 取一个包的 packument（只读 GET）。
 *
 * 超时**必须**有：registry 不可达时，设置页不该卡在一次等待里。8 秒是「足够慢的
 * 网络也能回」与「用户不会以为界面坏了」之间的取中。
 *
 * @param {{name?:string, registry?:string, timeoutMs?:number}} o
 * @returns {Promise<{ok:boolean, packument?:object, error?:string}>}
 */
export async function fetchPackument({ name = PACKAGE_NAME, registry = DEFAULT_REGISTRY, timeoutMs = 8000 } = {}) {
  const base = String(registry || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return { ok: false, error: 'registry 地址不是 http(s)：' + base };
  const url = base + '/' + encodeURIComponent(name).replace(/^%40/, '@');
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 8000)),
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    return { ok: true, packument: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * 真的执行一次安装：`dsh plugin --profile <p> add <spec>`。
 *
 * 为什么用 `dsh` 而不是直接 `pnpm add`：profile 的依赖与 bundles 声明由 dsh 自己
 * 维护（它还会写 package.json 与 lockfile）。绕过它直接动 node_modules，会让
 * 「声明」与「实装」分家——而本项目刚在 0.19.x 反复处理过这种不一致。
 *
 * 为什么返回 `needsRestart` 而不是自己重启：见文件头第 1 条。装完**必然**要重启
 * 才生效（这是本项目的第一号踩坑），但重启会杀会话，所以只提醒。
 *
 * @param {{profile?:string, spec?:string, timeoutMs?:number}} o
 * @returns {Promise<{ok:boolean, output?:string, error?:string, needsRestart:boolean, command:string}>}
 */
export function runInstall({ profile = 'web', spec = PACKAGE_NAME, timeoutMs = 180000 } = {}) {
  const args = ['plugin', '--profile', String(profile), 'add', String(spec)];
  const command = 'dsh ' + args.join(' ');
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve({ needsRestart: true, command, ...v }); } };
    let child;
    try {
      // Windows 上 `dsh` 是 .cmd/.ps1 脚本，必须 shell:true 才找得到；
      // 参数由我们自己拼（spec 来自配置，不是用户输入），因此不引入注入面。
      child = spawn('dsh', args, { shell: process.platform === 'win32', windowsHide: true });
    } catch (e) {
      return done({ ok: false, error: String(e?.message || e) });
    }
    let out = '';
    const cap = (buf) => { if (out.length < 8000) out += String(buf); };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      done({ ok: false, error: '安装超时（' + Math.round(timeoutMs / 1000) + 's）', output: out.slice(-2000) });
    }, Math.max(10000, Number(timeoutMs) || 180000));
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: String(e?.message || e), output: out.slice(-2000) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 退出码是唯一判据：不看输出里有没有「error」字样（那会误判警告）。
      done(code === 0
        ? { ok: true, output: out.slice(-2000) }
        : { ok: false, error: 'dsh 退出码 ' + code, output: out.slice(-2000) });
    });
  });
}
