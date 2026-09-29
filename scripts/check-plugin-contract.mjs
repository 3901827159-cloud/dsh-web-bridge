#!/usr/bin/env node
// check-plugin-contract.mjs — 把 DSH STORE 收录契约与插件规范里「机器可判」的六条变成红灯。
//
// ## 为什么需要这个文件
//
// DSH STORE 的目录状态给本插件的是 `blocked`，与源码有关的三条理由是：manifest 的
// `repository` 与 canonical 仓库不一致、manifest 与 GitHub 的许可证元数据不一致、
// 运行依赖需要单独的供应链审查。前两条是**声明层的事实错误**，第三条的一半是
// 「声明了却没有任何运行时代码用它」的死依赖（`ws` 当时就挂在 `dependencies` 里）。
//
// 这三条有一个共同点：**它们都不是代码缺陷，任何单测都不会因为它们变红**。
// 本仓库已经吃过一次同型的亏（见 `scripts/check-ledger.mjs` 文件头：靠自觉的约定
// 失败三次之后要换机制，「记得改 repository」同理——它不是机制）。
//
// ## 判据（七条；前四条与 `doc/permissions-and-boundaries.md` §5 的措辞一一对应，
// ## 后三条对齐 0.1.7/0.2.0 的插件规范与 host 的兼容闸门）
//
//   1. **仓库指向**：manifest 的 `repository.url` == 本仓库 `origin` 的 URL，且
//      `repository.directory` == 该 manifest 相对仓库根的**实际**目录。
//   2. **许可证三处一致**：根 `LICENSE` 与包内 `LICENSE` **字节相同**；`license`
//      字段与许可文本自称的许可一致；**正文与标准 MIT 模板逐字一致**（多插一段说明会让
//      GitHub 的许可识别把 `spdx_id` 打成 `NOASSERTION`，反而与 manifest 不一致）；
//      `files` 白名单**真的把它装进分发产物**。
//   3. **运行依赖无死声明**：`dependencies` 里每个名字都必须被**随包发布的源码**
//      （`lib/`、`bin/`）导入；反过来 `devDependencies` 里的名字不得被它导入。
//   4. **边界声明存在且被索引**：`doc/permissions-and-boundaries.md` 存在、含四节
//      标题（运行依赖 / 权限 / 外部服务 / 失败边界）、且已登记进 `doc/README.md`。
//
//   5. **`dsh.client.inject` 的值是包名，不是 Cordis 服务名**（0.19.50 新增）。
//      规范逐字：`DshClientManifest.inject` 是
//      「**Informational package-name dependencies, not Cordis service injection**」，
//      同一句话在 `WebBootEntry.inject` 上再次出现。**官方把「不是服务注入」写进了字段注释**
//      ——这正是最容易混的一处。
//
//      为什么这条只有本仓库有：官方闸门 `scripts/verify-client-packages.ts` 对 `inject`
//      **只查空值与重复**，不查「是不是真包」。于是这个错误会**静默存活**：
//      三条消费路径（`arriveGraphRow` 的 `graphRows.get()`、`orderByModuleGraph` 的
//      `external` 遍历、官方闸门）**全部容忍**它——`graphRows.get('slots')` 返回 `undefined`
//      就被静默跳过，既不报错也不产生任何到达顺序保证。
//
//      本仓库真实发生过一次：0.19.1 合规审计把 `inject: ['slots','settingsScope',…]`
//      记为「合规」，直到 0.1.7 升级才暴露 `settingsScope` 已改名。**那条死声明的真正代价
//      不是它自己错，而是它遮住了真问题**（0.19.2 的阻断级故障靠它才被误诊为「插件不见了」）。
//
//   6. **显示元数据（`icon` / `locale/`）声明了就必须合法**（0.19.50 新增）。
//      两条通道都在 0.1.7-alpha.2 起可用，且都是**可选**的（官方采用率 `icon` 2/85、
//      `locale/` 7/85，且读取失败是**容忍**的）。因此本判据的形状是「**声明了才判**」——
//      没声明不红；声明了就必须满足它自己的契约：`icon` 必须在 manifest 目录内、
//      ≤256 KiB、是 SVG/PNG/JPEG/WebP；`locale/en.json` 必须存在（规范：英文是必需回落）
//      且 `exports` 必须暴露 `./locale/*.json`（否则 Node ESM resolver 读不到）。
//
//      与判据 5 的区别：那条判「声明**错**了」，这条判「声明了却**做不到**」。
//
//   7. **`@deepseek-ai/dsh*` 的 peer 范围必须放行它所声明的每一代宿主**（0.19.51 新增）。
//
//      **这条是 0.2.0-rc.2 那次整包消失换来的。** 事实：`peerDependencies` 写
//      `^0.1.5-alpha.1`，在 0.1.7-alpha.2 上**恰好为真**（所以当时全套测试与真机验收
//      全绿），升到 0.2.0-rc.2 就**恰好为假**。而 `dsh-app-boot` 的
//      `evaluatePluginCompatibility` 对失败的处理是：**整个 bundle 从配置里静默消失**
//      （`--dump-config` 里连一行都不剩），只在 stderr 留一句 warn。
//
//      这个失效形状最贵的地方不是「写窄了」，而是**没有任何测试会因为能力消失而变红**：
//      插件根本没被加载，于是它的所有单测照常通过。本仓库记过同型的账
//      （判据 5 的 `settingsScope`：死声明的代价是它遮住了真问题）。
//
//      两条臂，分别对应「能判」与「判得准」：
//
//      · **形状臂（离线，任何环境都跑）**：`@deepseek-ai/dsh*` 的 peer 范围**不得**
//        是对 `0.x` 版本的 caret/tilde 范围。理由是 semver 的规则本身：对 `0.x`，
//        `^0.1.5` ⇒ `>=0.1.5 <0.2.0`——**它只覆盖一个 minor 代**。宿主每发一个
//        minor，声明就无声地变成假的。要求写成显式 `>=<下界> <<上界>`，等于把
//        「我不支持哪一版」从**默认**变成**作者的决定**。
//        （`peerDependenciesMeta.optional: true` **不豁免**这一点：实测它**不参与**
//         `evaluatePluginCompatibility` 的判定，optional peer 写窄了照样整包被跳过。）
//
//      · **事实臂（本机装了 dsh 时跑）**：用**该 dsh 自带的 `semver`** 复算
//        `satisfies(运行时版本, 声明范围)`——即**直接跑宿主那道判据**。装了 dsh 却算
//        不过 ⇒ 红。没装 dsh ⇒ skip 并**打印原因**（不静默假绿）。
//
//      刻意**不**给形状臂放宽：它判的是「这份声明有没有给上界」，与当前装了哪个
//      版本无关，因此在 CI（不装 dsh）里也是有效的。
//
// ## 刻意不做的事
//
//   · **不用 `spawnSync` 去问 git**：读 `.git/config` 就够了。本机实测 Node 里
//     `spawnSync` 调任何外部程序都 `EPERM`（见 `doc/progress.md`「已知环境约束」），
//     那会让闸门在本机空转——而**空转的闸门比没有闸门更坏**。
//   · **不引第三方依赖**。与 check-ledger / check-repo-hygiene / lint-comments 同一传统。
//   · **不修文件**。改 `repository` 是作者的判断，不是脚本的判断；脚本只报警。
//
// ## 用法
//
//   node scripts/check-plugin-contract.mjs            # 人读输出
//   node scripts/check-plugin-contract.mjs --json     # 机读输出（CI 归档）
//   node scripts/check-plugin-contract.mjs --self-test # 判据 5 的自检（正反例都对才退 0）
//
// 退出码：0 = 六条全绿；1 = 有不一致项；2 = 脚本自身出错（读不到文件等）。
//
// ## 已知边界（宁可漏报也不制造假红）
//
// 「运行依赖无死声明」只判**静态导入**。将来若出现动态拼出的模块名，它会被误判成
// 死声明——那时应把该名字加进 `DEAD_DEP_ALLOWLIST` 并在此处写清理由，**不要放宽判据**，
// 否则这道闸门会退化成「永远是绿的」。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const pkgDir = path.join(repoRoot, 'package', 'dsh-webcode-bridge');

const PKG_JSON = path.join(pkgDir, 'package.json');
const ROOT_LICENSE = path.join(repoRoot, 'LICENSE');
const PKG_LICENSE = path.join(pkgDir, 'LICENSE');
const BOUNDARIES_DOC = path.join(repoRoot, 'doc', 'permissions-and-boundaries.md');
const DOC_INDEX = path.join(repoRoot, 'doc', 'README.md');

/** 随包发布的运行时代码目录（相对包目录）。判据 3 的扫描面就是这两个。 */
const SHIPPED_DIRS = ['lib', 'bin'];

/**
 * 「声明了但运行时不引用」的显式豁免名单。
 *
 * 空着是刻意的：本项目 0.19.24 把唯一的死声明（`ws`，唯一引用者是
 * `test/fake-extension.js` 这个测试替身）移进了 `devDependencies`。将来真要豁免，
 * 在这里写 `名字: '理由'`，让豁免本身也留下痕迹。
 */
const DEAD_DEP_ALLOWLIST = {};

/**
 * 裸包名豁免名单（判据 5 用）。
 *
 * 判据 5 默认**只接受 scoped 包名**（`@scope/name`）——官方 85 个包与两个参考实现里
 * `dsh.client.inject` 的值**没有一条不是 scoped**（机检输出为空）。
 * 但 npm 上确实存在合法的**裸包名**（`react`、`react-dom` 这类）。将来真要用到，
 * 在这里登记名字并写清理由，**不要放宽判据**：本闸门的全部价值就在于它不迁就。
 */
const BARE_PACKAGE_ALLOWLIST = {};

/**
 * 一个值是不是「包名」而不是「Cordis 服务名」。
 *
 * 规范逐字：`dsh.client.inject` 是「Informational package-name dependencies,
 * **not** Cordis service injection」。两者最容易混，因为**字段同名**——
 * `lib/client.cjs` 里那个 Cordis 插件的 `inject` 用的就是同一批短名。
 *
 * 判据取「形状」而不是「查 npm」：本仓库的闸门一律**离线、不引第三方、不 spawn**
 * （理由见文件头），查包是否存在做不到。形状判据在本项目上是够用的——
 * 四个错值（`slots` / `settingsScope` / `sidebarRightTabs` / `sidebarRight`）
 * 全部是无斜杠的裸标识符，一条都过不了。
 */
function isPackageName(v) {
  if (typeof v !== 'string' || v.length === 0) return false;
  if (BARE_PACKAGE_ALLOWLIST[v]) return true;
  return /^@[^/\s]+\/[^/\s]+/.test(v);
}

/** 判据 4 要求的四节标题。顺序与 `doc/permissions-and-boundaries.md` 一致。 */
const REQUIRED_DOC_SECTIONS = [
  /^##\s*1\.\s*运行依赖\s*$/m,
  /^##\s*2\.\s*权限\s*$/m,
  /^##\s*3\.\s*外部服务\s*$/m,
  /^##\s*4\.\s*失败边界\s*$/m,
];

/**
 * 标准 MIT 正文（不含标题行与版权行——那两行本来就该逐项目不同）。
 *
 * ## 为什么要把正文**逐字**钉住，而不是只看向量里的 `license` 字段
 *
 * 2026-09-26 真事故：根 `LICENSE` 曾经在标准 MIT 全文中间插了一段第三方来源说明，
 * `package.json` 写着 `"license": "MIT"`、文件也在，看起来三处都「有」许可——但 GitHub 的
 * 许可识别（Licensee）是拿 MIT 模板做**相似度**匹配，多出的段落把它压到阈值之下，于是它
 * 对外报的是 `license.key='other'`、`spdx_id='NOASSERTION'`（本机实读 GitHub API）。
 * 那正是 DSH STORE 收录阻断「manifest 与 GitHub 的许可证元数据不一致」——只补文件不够，
 * **正文的形状**才是被判的东西。
 *
 * 这条判据离线可判、且直接对应上面那个后果：正文里多出一段、少一段、改一个词都会红。
 * 额外说明（第三方来源、商标、免责补充）应当放进 `README.md` 或独立的 NOTICE 文件，
 * **不要塞进许可正文**——塞进去就会把 `spdx_id` 从 `MIT` 变成 `NOASSERTION`。
 */
const MIT_BODY = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
].join('\n');

/**
 * 把一份许可文本归一成「只比较正文」的形状：去掉标题行与版权行、统一空白。
 *
 * 去掉的两行是**本来就该逐项目不同**的部分（`MIT License` 标题、`Copyright (c) …`），
 * 其余逐字保留——正是这样才判得出「多插了一段」。
 */
function normalizeLicenseBody(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*MIT License\s*$/i.test(line) && !/^\s*Copyright\b/i.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把 git URL 归一成可以逐字比较的形状：**与协议/传输方式无关**的 `host/owner/repo`。
 *
 * 处理：去 `git+`、去 `ssh://[user@]`、把 SCP 形 `git@host:owner/repo` 的 `:` 换成 `/`、
 * 去 `https://`、去末尾 `.git` 与 `/`。
 *
 * **为什么要认 SSH 两种形态**：`origin` 配成 `git@github.com:owner/repo.git` 而 manifest 的
 * `repository.url` 按 npm 惯例写 `git+https://github.com/owner/repo.git` 时，两者指向
 * **同一个仓库**（本机 HTTPS 到 github.com 不通、只能用 SSH 时就是这种组合）。只按字面比较
 * 会把这种**合法**配置判成「仓库指向不一致」——那是**假红**，不是发现问题。
 * 归一**不降低判据强度**：host 与 owner/repo 路径仍必须逐字相同（见本文件自带的用例）。
 */
function normalizeGitUrl(url) {
  return String(url || '')
    .trim()
    .replace(/^git\+/, '')
    .replace(/^ssh:\/\/(?:[^@/]+@)?/i, '')
    .replace(/^[^@/]+@([^:/]+):/, '$1/')
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/**
 * 从 `.git/config` 读出 `origin` 的 URL（纯 `fs`，不 spawn git——理由见文件头）。
 *
 * 覆盖两种仓库形态：`.git` 是目录（常规克隆）与 `.git` 是文件（worktree / 子模块，
 * 内容是 `gitdir: <path>`）。读不到时返回 null 并由调用方**如实报出来**，
 * 而不是假装通过。
 */
function readOriginUrl() {
  const dotGit = path.join(repoRoot, '.git');
  let configPath = path.join(dotGit, 'config');
  if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
    const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    configPath = path.join(path.resolve(repoRoot, m[1].trim()), 'config');
  }
  if (!fs.existsSync(configPath)) return null;
  const cfg = fs.readFileSync(configPath, 'utf8');
  // 取 `[remote "origin"]` 段里的 `url`，到下一个段头为止。
  const section = cfg.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/);
  if (!section) return null;
  const url = section[1].match(/^\s*url\s*=\s*(.+)$/m);
  return url ? url[1].trim() : null;
}

/** 递归收集目录下的 `.js` / `.mjs` / `.cjs`（判据 3 的扫描面）。 */
function collectSources(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectSources(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 抽出一个源码文件里的**模块说明符**（`from 'x'` / `require('x')` / `import('x')` /
 * 裸 `import 'x'`）。刻意只认这四种官方形态：本项目不写动态导入。
 */
function moduleSpecifiers(text) {
  const specs = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** 说明符是否来自某个包（含子路径导入，如 `pkg/sub`）。 */
function specifierUsesPackage(spec, name) {
  return spec === name || spec.startsWith(name + '/');
}

/**
 * 读出**运行中**那台 dsh 的版本号（判据 7 的事实臂要用它当被比较的一方）。
 *
 * 取法刻意不是 `dsh --version`（那要 spawn，本机 `EPERM`，理由见文件头），
 * 而是**读已安装 dsh 自己的 `package.json`**——`evaluatePluginCompatibility`
 * 的默认 `runtimeVersion` 正是 `getDshRuntimeVersion()`，而它读的也是同一处。
 *
 * 读不到时返回 `null`：调用方据此把事实臂标为 SKIP 并**打印原因**，
 * 不拿一个猜出来的版本号去判。
 */
function readDshRuntimeVersion() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ];
  for (const d of candidates) {
    const f = path.join(d, 'package.json');
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (typeof j.version === 'string' && j.version.length) return j.version;
    } catch { /* 读坏了就当没有，由调用方报 unavailable */ }
  }
  return null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 判据 7 的形状臂：一个 `@deepseek-ai/dsh*` peer 范围是不是**危险形状**。
 *
 * 「危险」的定义刻意窄且有依据——**对 `0.x` 版本的 caret / tilde**：
 *
 *   `^0.1.5-alpha.1`  ⇒ `>=0.1.5-alpha.1 <0.2.0`   （只覆盖一个 minor 代）
 *   `~0.1.5-alpha.1`  ⇒ `>=0.1.5-alpha.1 <0.2.0`   （同上）
 *
 * semver 对 `0.x` 的这条规则意味着：宿主每发一个 minor，声明就**无声地**失真。
 * 本项目实装经历过 0.1.6 → 0.1.7 → 0.2.0-rc.2 三代，正好跨过这道边界。
 *
 * 返回 null 表示形状可接受；否则返回一句人读的理由。
 *
 * 刻意**不**判「范围太宽」（那会把 `>=0.1.5-alpha.1 <1.0.0` 判红，而它正是
 * 本判据推荐的写法）——判据只盯「有没有给上界、上界是不是一个 minor」。
 */
function narrowZeroRange(range) {
  const r = String(range).trim();
  // `^0.x` / `~0.x`：caret/tilde 落在 0 主版本上 ⇒ 只覆盖一个 minor 代。
  const m = /^[\^~]\s*0\./.exec(r);
  if (m) return '`' + r + '` 对 `0.x` 只覆盖一个 minor 代（semver：`' + (m[0][0] === '^' ? '^' : '~')
    + '0.1.5` ⇒ `>=0.1.5 <0.2.0`），宿主每发一个 minor 它就会无声失真';
  return null;
}

/**
 * 判据 7 的事实臂：用**宿主自带的 semver** 复算 `satisfies(运行时, 声明)`。
 *
 * 为什么必须用宿主那个 semver 而不是自己实现：这道判据的**唯一目的**就是预演
 * `dsh-app-boot` 的 `evaluatePluginCompatibility`（它用
 * `{ includePrerelease: true }`）。自己写一套近似的比较，就会在 prerelease 上
 * 与宿主分叉——而本项目全部版本号都是 prerelease。
 *
 * 返回 `{ status, detail }`：`status` ∈ `'ok' | 'mismatch' | 'unavailable'`。
 * 找不到 dsh 时是 `unavailable`，调用方据此**打印原因**而不是假装通过。
 */
function evaluateAgainstInstalledDsh(runtimeVersion, peerRanges) {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ].filter((d) => fs.existsSync(path.join(d, 'package.json')));

  if (candidates.length === 0) return { status: 'unavailable', detail: '本机找不到已安装的 dsh' };

  const dshDir = candidates[0];
  let semver;
  try {
    // 用 createRequire 指向 dsh 目录，于是解析到的是**宿主自己那份** semver。
    semver = createRequire(path.join(dshDir, 'noop.js'))('semver');
  } catch (e) {
    return { status: 'unavailable', detail: '装到 dsh 但取不到它自带的 semver：' + (e && e.message) };
  }

  const bad = [];
  for (const [name, range] of Object.entries(peerRanges)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
    let ok;
    try {
      ok = semver.satisfies(runtimeVersion, range, { includePrerelease: true });
    } catch (e) {
      bad.push(name + ' 的范围无法解析（' + String(e && e.message) + '）');
      continue;
    }
    if (!ok) bad.push(name + ' 声明 ' + JSON.stringify(range) + ' —— 运行中的 dsh ' + runtimeVersion + ' 不满足它');
  }
  if (bad.length) return { status: 'mismatch', detail: bad.join('；'), dshDir, runtimeVersion };
  return { status: 'ok', detail: '运行中的 dsh ' + runtimeVersion + '（' + dshDir + '）满足全部 @deepseek-ai/dsh* peer', dshDir, runtimeVersion };
}

/**
 * 判据 5 的自检：正例必须过、反例必须红。
 *
 * ## 为什么只给判据 5 加自检，不给前四条加
 *
 * 前四条判的是**文件、字节、字节相同**（两份 LICENSE 的 sha256、import 说明符、文件是否存在）
 * ——它们的失效形态是「报错」，看得见。判据 5 判的是**形状**（一个字符串像不像包名），
 * 而形状判据最典型的失效形态与 `check-long-term-issues.mjs` 文件头写的是同一件事：
 * **悄悄不再匹配任何东西**。那时它会一路 PASS，看起来比谁都干净。
 *
 * 反例里刻意包含**必须不报**的形态（`undefined` = 未声明），否则闸门会在**正确的清单**上恒红。
 */
function selfTest() {
  const CASES = [
    { name: '正例：scoped 包名', v: '@deepseek-ai/dsh-client-locale', expect: true },
    { name: '正例：带子路径的 scoped 名', v: '@deepseek-ai/dsh-tool-subagent-control/list-agents', expect: true },
    { name: '反例：Cordis 服务名 slots（本仓库真实错过的那个字段）', v: 'slots', expect: false },
    { name: '反例：Cordis 服务名 settingsScope（0.1.7 改名后暴露的那个）', v: 'settingsScope', expect: false },
    { name: '反例：服务名 sidebarRightTabs', v: 'sidebarRightTabs', expect: false },
    { name: '反例：空字符串', v: '', expect: false },
    { name: '反例：非字符串', v: 42, expect: false },
  ];

  const failures = [];
  for (const c of CASES) {
    const got = isPackageName(c.v);
    if (got !== c.expect) {
      failures.push(c.name + '\n      期望: ' + c.expect + '\n      实得: ' + got);
    }
  }

  if (failures.length) {
    process.stderr.write('[contract] 判据 5 自检失败（' + failures.length + '/' + CASES.length + ' 个用例）：\n');
    for (const f of failures) process.stderr.write('  · ' + f + '\n');
    process.stderr.write('[contract] 判据已经漂移。修本脚本的 isPackageName，不要改用例去迁就实现。\n');
    return 1;
  }
  process.stdout.write('[contract] ✔ 判据 5 自检通过（' + CASES.length + ' 个用例：正例 2、反例 5）。\n');
  return 0;
}

function main() {
  const json = process.argv.includes('--json');

  if (process.argv.includes('--self-test')) return selfTest();
  const problems = [];
  const results = [];

  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));

  // ---- 判据 1：仓库指向 ----
  const originUrl = readOriginUrl();
  const manifestUrl = pkg.repository && pkg.repository.url;
  const expectedDir = path.relative(repoRoot, pkgDir).split(path.sep).join('/');
  const actualDir = pkg.repository && pkg.repository.directory;
  const repoChecks = [
    { what: 'manifest 有 repository.url', ok: typeof manifestUrl === 'string' && manifestUrl.length > 0 },
    { what: 'repository.url 指向本仓库 origin（' + normalizeGitUrl(originUrl) + '）',
      ok: originUrl !== null && normalizeGitUrl(manifestUrl) === normalizeGitUrl(originUrl) },
    { what: 'repository.directory == ' + expectedDir, ok: actualDir === expectedDir },
    { what: 'homepage 指向同一仓库',
      ok: normalizeGitUrl(pkg.homepage).startsWith(normalizeGitUrl(originUrl) || '\u0000') },
    { what: 'bugs.url 指向同一仓库',
      ok: !!(pkg.bugs && pkg.bugs.url)
        && normalizeGitUrl(pkg.bugs.url).startsWith(normalizeGitUrl(originUrl) || '\u0000') },
  ];
  if (originUrl === null) {
    problems.push('读不到 `.git/config` 里 `origin` 的 URL——判据 1 无法与事实对照（不是通过）。');
  }
  for (const c of repoChecks) if (!c.ok) problems.push('仓库指向：' + c.what + ' —— 不成立。');
  results.push({ item: 'repository', ok: repoChecks.every((c) => c.ok) && originUrl !== null });

  // ---- 判据 2：许可证三处一致 ----
  const licChecks = [];
  const rootHas = fs.existsSync(ROOT_LICENSE);
  const pkgHas = fs.existsSync(PKG_LICENSE);
  licChecks.push({ what: '根 LICENSE 存在', ok: rootHas });
  licChecks.push({ what: '包内 LICENSE 存在', ok: pkgHas });
  let identical = false;
  if (rootHas && pkgHas) {
    identical = sha256(ROOT_LICENSE) === sha256(PKG_LICENSE);
    licChecks.push({ what: '两份 LICENSE 字节相同（分发产物与 GitHub 一致）', ok: identical });
    const licText = fs.readFileSync(ROOT_LICENSE, 'utf8');
    const firstLine = licText.split(/\r?\n/)[0];
    licChecks.push({
      what: '许可文本自称 ' + pkg.license + '（首行：' + firstLine.trim() + '）',
      ok: new RegExp('^' + String(pkg.license) + '\\b', 'i').test(firstLine.trim())
        || /MIT License/i.test(firstLine) && pkg.license === 'MIT',
    });
    // 正文必须与标准 MIT 模板逐字一致：多插一段就会让 GitHub 把 spdx_id 判成
    // NOASSERTION（见 MIT_BODY 的注释）。这一段是该判据里**唯一能提前发现**那类事故的检查。
    licChecks.push({
      what: '许可正文与标准 MIT 模板逐字一致（多插段落会让 GitHub 判成 NOASSERTION）',
      ok: normalizeLicenseBody(licText) === normalizeLicenseBody(MIT_BODY),
    });
    if (!fs.readFileSync(ROOT_LICENSE, 'utf8').includes('MIT License')) {
      problems.push('许可证：正文里没有 `MIT License` 标题行——GitHub 的识别依赖它。');
    }
  }
  licChecks.push({
    what: 'package.json 的 files 白名单含 LICENSE',
    ok: Array.isArray(pkg.files) && pkg.files.includes('LICENSE'),
  });
  for (const c of licChecks) if (!c.ok) problems.push('许可证：' + c.what + ' —— 不成立。');
  results.push({ item: 'license', ok: licChecks.every((c) => c.ok) });

  // ---- 判据 3：运行依赖无死声明 ----
  const sources = SHIPPED_DIRS.flatMap((d) => collectSources(path.join(pkgDir, d)));
  const used = new Set();
  for (const f of sources) {
    for (const s of moduleSpecifiers(fs.readFileSync(f, 'utf8'))) used.add(s);
  }
  const deps = Object.keys(pkg.dependencies || {});
  const devDeps = Object.keys(pkg.devDependencies || {});
  const depChecks = [];
  for (const name of deps) {
    if (DEAD_DEP_ALLOWLIST[name]) continue;
    depChecks.push({
      what: '运行依赖 `' + name + '` 被 lib/ 或 bin/ 导入',
      ok: [...used].some((s) => specifierUsesPackage(s, name)),
    });
  }
  for (const name of devDeps) {
    const leaked = [...used].some((s) => specifierUsesPackage(s, name));
    depChecks.push({
      what: '开发依赖 `' + name + '` 未被运行时代码导入' + (leaked ? '（实际被导入，装机后会缺）' : ''),
      ok: !leaked,
    });
  }
  for (const c of depChecks) if (!c.ok) problems.push('依赖：' + c.what + ' —— 不成立。');
  results.push({
    item: 'dependencies',
    ok: depChecks.every((c) => c.ok),
    detail: deps.length + ' 运行 / ' + devDeps.length + ' 开发，扫了 ' + sources.length + ' 个随包源码文件',
  });

  // ---- 判据 4：边界声明存在且被索引 ----
  const docChecks = [];
  const docHas = fs.existsSync(BOUNDARIES_DOC);
  docChecks.push({ what: 'doc/permissions-and-boundaries.md 存在', ok: docHas });
  if (docHas) {
    const md = fs.readFileSync(BOUNDARIES_DOC, 'utf8');
    for (const re of REQUIRED_DOC_SECTIONS) {
      docChecks.push({ what: '含小节标题 `' + re.source + '`', ok: re.test(md) });
    }
  }
  const indexHas = fs.existsSync(DOC_INDEX)
    && fs.readFileSync(DOC_INDEX, 'utf8').includes('(permissions-and-boundaries.md)');
  docChecks.push({ what: 'doc/README.md 索引里有它', ok: indexHas });
  for (const c of docChecks) if (!c.ok) problems.push('边界声明：' + c.what + ' —— 不成立。');
  results.push({ item: 'boundaries-doc', ok: docChecks.every((c) => c.ok) });

  // ---- 判据 5：dsh.client.inject 的值是包名 ----
  const injectChecks = [];
  const clientInject = pkg.dsh && pkg.dsh.client ? pkg.dsh.client.inject : undefined;
  if (clientInject === undefined) {
    // 不声明是**合规**的（平台种子由 PLATFORM_MODULES 保证，无需声明），
    // 本插件的现状正是如此。这里记一条读数而不是问题，让输出说清楚「是没声明，不是没检查」。
    injectChecks.push({ what: 'dsh.client.inject 未声明（合规：平台种子无需声明）', ok: true });
  } else if (!Array.isArray(clientInject)) {
    injectChecks.push({ what: 'dsh.client.inject 必须是数组', ok: false });
  } else {
    const bad = clientInject.filter((v) => !isPackageName(v));
    injectChecks.push({
      what: 'dsh.client.inject 的每个值都是包名（规范：package-name dependencies, NOT Cordis service injection）'
        + (bad.length ? '——不是包名的值：' + bad.map((v) => JSON.stringify(v)).join(', ') : ''),
      ok: bad.length === 0,
    });
  }
  for (const c of injectChecks) {
    if (!c.ok) {
      problems.push('客户端清单：' + c.what + ' —— 不成立。'
        + '（正确值形如 `@scope/name`；服务名如 `slots` 不合法，它是 Cordis 插件的 inject 用的）');
    }
  }
  results.push({ item: 'client-inject', ok: injectChecks.every((c) => c.ok) });

  // ---- 判据 6：显示元数据（icon / locale） ----
  //
  // 规范（`DshPackageManifest.icon` / `PluginLocalizedMeta`）：`icon` 是
  // 「SVG, PNG, JPEG, or WebP file relative to this manifest's directory, at most 256 KiB
  // and contained there after realpath resolution」；`locale/<lang>.json` 里的
  // `{ meta: { title, description } }` 经 Node ESM resolver 读，**必须在 `exports` 里可达**。
  //
  // 这两条都是**可选**通道（官方采用率 icon 2/85、locale 7/85），所以判据的形状是
  // 「**声明了才判**」——没声明不红，声明了就必须满足它自己的契约。
  // 这与判据 5 不同：那条判的是「声明错了」，这条判的是「声明了却做不到」。
  const META_ICON_LIMIT = 262144; // 256 KiB，规范逐字给的数
  const metaChecks = [];
  const iconRel = pkg.icon;
  if (iconRel === undefined) {
    metaChecks.push({ what: 'icon 未声明（可选通道，合规）', ok: true });
  } else {
    const iconAbs = path.resolve(pkgDir, iconRel);
    const inside = iconAbs === pkgDir || iconAbs.startsWith(pkgDir + path.sep);
    metaChecks.push({ what: 'icon 路径在 manifest 目录内（' + iconRel + '）', ok: inside });
    const exists = inside && fs.existsSync(iconAbs);
    metaChecks.push({ what: 'icon 文件存在', ok: exists });
    if (exists) {
      const size = fs.statSync(iconAbs).size;
      metaChecks.push({
        what: 'icon ≤ 256 KiB（实测 ' + size + ' 字节）',
        ok: size <= META_ICON_LIMIT,
      });
      metaChecks.push({
        what: 'icon 是 SVG/PNG/JPEG/WebP',
        ok: /\.(svg|png|jpe?g|webp)$/i.test(iconRel),
      });
    }
  }
  // locale 只在目录真的存在时才判：没提供是合规的。
  const localeDir = path.join(pkgDir, 'locale');
  if (fs.existsSync(localeDir)) {
    metaChecks.push({
      what: 'locale/en.json 存在（规范：英文是必需回落）',
      ok: fs.existsSync(path.join(localeDir, 'en.json')),
    });
    const exportsKeys = pkg.exports && typeof pkg.exports === 'object'
      ? Object.keys(pkg.exports) : [];
    metaChecks.push({
      what: 'exports 暴露 `./locale/*.json`（否则 ESM resolver 读不到）',
      ok: exportsKeys.includes('./locale/*.json'),
    });
    const localFiles = fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'));
    let shapeOk = localFiles.length > 0;
    for (const f of localFiles) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
        if (!j.meta || typeof j.meta.title !== 'string' || typeof j.meta.description !== 'string') shapeOk = false;
      } catch { shapeOk = false; }
    }
    metaChecks.push({
      what: '每个 locale/*.json 都是 `{ meta: { title, description } }`（' + localFiles.length + ' 个文件）',
      ok: shapeOk,
    });
  } else {
    metaChecks.push({ what: 'locale/ 未提供（可选通道，合规）', ok: true });
  }
  for (const c of metaChecks) if (!c.ok) problems.push('显示元数据：' + c.what + ' —— 不成立。');
  results.push({ item: 'display-meta', ok: metaChecks.every((c) => c.ok) });

  // ---- 判据 7：@deepseek-ai/dsh* 的 peer 范围必须放行下一代宿主 ----
  const peerChecks = [];
  const peers = pkg.peerDependencies && typeof pkg.peerDependencies === 'object'
    ? pkg.peerDependencies : {};
  const dshPeers = Object.entries(peers).filter(([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'));

  if (dshPeers.length === 0) {
    peerChecks.push({ what: '未声明 @deepseek-ai/dsh* peer（合规：不声明就不参与 host 兼容闸门）', ok: true });
  } else {
    for (const [name, range] of dshPeers) {
      const why = narrowZeroRange(range);
      peerChecks.push({
        what: 'peer `' + name + '` 的范围 `' + range + '` 形状可放行跨 minor 的宿主'
          + (why ? '——' + why : ''),
        ok: why === null,
      });
    }
    // 事实臂：直接跑宿主那道判据。取不到运行时版本时**不猜**，如实报 unavailable。
    const runtimeVersion = readDshRuntimeVersion();
    if (runtimeVersion === null) {
      peerChecks.push({ what: '事实臂：读不到运行中的 dsh 版本 ⇒ 本臂 SKIP（形状臂仍然有效）', ok: true, skipped: true });
    } else {
      const verdict = evaluateAgainstInstalledDsh(runtimeVersion, peers);
      if (verdict.status === 'unavailable') {
        peerChecks.push({ what: '事实臂：' + verdict.detail + ' ⇒ 本臂 SKIP（形状臂仍然有效）', ok: true, skipped: true });
      } else {
        peerChecks.push({
          what: '事实臂：' + verdict.detail,
          ok: verdict.status === 'ok',
        });
      }
    }
  }
  for (const c of peerChecks) if (!c.ok) problems.push('宿主兼容：' + c.what + ' —— 不成立。');
  results.push({ item: 'dsh-peers', ok: peerChecks.every((c) => c.ok) });

  if (json) {
    process.stdout.write(JSON.stringify({
      ok: problems.length === 0,
      repoRoot,
      origin: originUrl,
      literalChecks: [...repoChecks, ...licChecks, ...depChecks, ...docChecks, ...injectChecks, ...metaChecks, ...peerChecks],
      results,
      problems,
    }, null, 2) + '\n');
  } else {
    process.stdout.write('[contract] 仓库：' + repoRoot + '\n');
    process.stdout.write('[contract] origin = ' + (originUrl || '(读不到)') + '\n');
    for (const r of results) {
      process.stdout.write('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.item.padEnd(15)
        + (r.detail ? '  ' + r.detail : '') + '\n');
    }
    process.stdout.write('\n');
  }

  if (problems.length) {
    process.stderr.write('[contract] DSH 插件契约不一致（' + problems.length + ' 项）：\n');
    for (const p of problems) process.stderr.write('  · ' + p + '\n');
    process.stderr.write('\n[contract] 修复方向：改 manifest / LICENSE / 依赖声明让它与事实一致；\n');
    process.stderr.write('[contract] 不要改本脚本去迁就声明——这道闸门的全部价值就在于它不迁就。\n');
    return 1;
  }

  if (!json) {
    process.stdout.write('[contract] ✔ 七条契约与事实一致（仓库指向 / 许可证 / 运行依赖 / 边界声明 / 客户端清单 / 显示元数据 / 宿主兼容）。\n');
    process.stdout.write('[contract] 注意：本闸门只判声明层与事实是否一致，'
      + '**不改变 DSH STORE 的审查结论**（见 doc/permissions-and-boundaries.md §6）。\n');
  }
  return 0;
}

let code = 2;
try {
  code = main();
} catch (e) {
  // 脚本自身出错必须是 2，不能伪装成「契约不一致」（1）：两者的处理方式完全不同。
  process.stderr.write('[contract] 脚本自身失败：' + (e && e.stack ? e.stack : e) + '\n');
  code = 2;
}
process.exit(code);
