// account-cache.js — 账号身份缓存（昵称 / 头像）的**唯一读写入口**（0.19.46）。
//
// ## 为什么必须独立成一个模块
//
// 这份缓存在三个地方要用，而且**必须同一口径**：
//   · 驱动的 `readAccountIdentity()`（读到就落盘）；
//   · 模型列表的显示名（用户要求：`deepseek-rsyhn`、`deepseek-177…`，见 §5）；
//   · 控制面 `/__webcode/status` 的每个账户行（右栏与设置页据此显示真实用户名+头像）。
//
// 三处各写一份「读哪个文件、什么算有效、坏了怎么办」必然漂移——本项目对
// 「两处口径漂移」记过多次（`doc/long-term-issues.md` 多条的同一族）。
// 因此路径与判据都收在这里，调用方只做 IO 时机。
//
// ## 为什么落盘（用户原话 2026-09-28）
//
//   > 1.请你查看现在右侧tab获取的deepseek账户名和图像不会缓存？每次新开？
//
// 旧实现里 `accountIdentity` **只是驱动闭包里的一个 let**：桥一重启 / 懒驱动一回收，
// 名字与头像就归零，面板回落到 `displayName`（用户看到的「图像 + Deepseek网页版」）。
// 而 `loggedIn` 早就落盘了（`webcode-login-state.json`），身份是**同一类装饰性读数**
// 却漏了同一层——教训同源：**任何要在重启后仍显示的状态，都必须落盘。**
//
// 本文件是**纯判据 + 一处路径构造**：不抓 DOM、不碰驱动、不起浏览器。
// 这样「什么算有效的缓存」可以被离线单测逐条钉住（见 test/account-identity-cache.test.mjs）。

import fs from 'node:fs';
import path from 'node:path';

/** 身份缓存文件名。**它是契约的一部分**：改名会让既有缓存静默失效。 */
export const ACCOUNT_IDENTITY_FILE = 'webcode-account-identity.json';

/** 昵称最长保留多少个字符（超出截断，防止把一整段网页文本当成昵称存下来）。 */
const MAX_NAME_CHARS = 64;

/**
 * 昵称 → 可安全用作**模型显示名片段**的形态。
 *
 * 用户要求模型行显示成 `deepseek-rsyhn` 这种形状（原话见 §5），因此昵称会进
 * 模型 id 旁边的显示名。这里只做**展示层**的清洗，不改模型 id 本身：
 *   · 去首尾空白、压缩内部空白；
 *   · 空白与分隔符统一成 `-`（`RSYHN Zhang` → `RSYHN-Zhang`）；
 *   · 丢掉会破坏展示的字符（`/`、`:`、`#` 等在本项目里有结构含义）。
 * 读不出（空串/纯符号）时返回 null，调用方回落——**绝不编一个名字**。
 *
 * @param {unknown} raw 原始昵称
 * @returns {string|null}
 */
export function nameSlugForDisplay(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // 只保留字母/数字/中日韩文与常见连接符；其余（含 / : # @ 引号）一律去掉。
  const cleaned = s.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_NAME_CHARS);
}

/**
 * 判定一份缓存对象是否**可用**。
 *
 * 判据刻意收窄：**必须至少有一个真值字段**（昵称或头像 URL），否则当没有缓存。
 * 理由：一个空壳缓存（`{}` / `{capturedAt:…}`）既显示不了任何东西，又会把
 * `basis` 谎报成 'cache'，让读者以为「读到过、只是没值」——那比没有缓存更难查。
 *
 * @param {unknown} obj 已解析的 JSON
 * @returns {{name: string|null, avatarUrl: string|null, capturedAt: string|null, basis: string}|null}
 */
export function normalizeIdentityCache(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : null;
  // 头像只接受可加载的来源（http(s) / data:image）；其它（相对路径、脚本 URL）当没有，
  // 与驱动侧 readAccountIdentity 的过滤逐字同口径。
  const rawAvatar = typeof obj.avatarUrl === 'string' ? obj.avatarUrl.trim() : '';
  const avatarUrl = /^(https?:|data:image\/)/i.test(rawAvatar) ? rawAvatar.slice(0, 2048) : null;
  if (!name && !avatarUrl) return null;
  return {
    name,
    avatarUrl,
    capturedAt: typeof obj.capturedAt === 'string' ? obj.capturedAt : null,
    basis: typeof obj.basis === 'string' && obj.basis ? obj.basis : 'cache',
  };
}

/** 某槽的身份缓存路径（与登录态/发送状态/设置三个文件同处）。 */
export function identityCachePathFor(profileDir) {
  return path.join(String(profileDir), ACCOUNT_IDENTITY_FILE);
}

/**
 * 读一份身份缓存；**任何异常都返回 null**（读不到就是没有，不抛）。
 *
 * @param {string} profileDir 该槽的 profile 目录
 * @returns {{name: string|null, avatarUrl: string|null, capturedAt: string|null, basis: string}|null}
 */
export function readIdentityCache(profileDir) {
  try {
    return normalizeIdentityCache(JSON.parse(fs.readFileSync(identityCachePathFor(profileDir), 'utf8')));
  } catch { return null; }
}

/**
 * 写一份身份缓存。**失败不抛**（装饰性读数，绝不能影响登录/轮次本身）。
 *
 * mode 0o600 与 consent / settings / send-state / login-state 四个文件一致。
 * 注意：Windows 上 Node 的 mode 不生效（权限由 ACL 决定），写它是为了跨平台
 * 正确性与意图表达——不要据此认为凭据文件已被额外加固（见 doc/security-review.md 6.3）。
 *
 * @param {string} profileDir 该槽的 profile 目录
 * @param {{name: string|null, avatarUrl: string|null, capturedAt?: string|null, basis?: string}} identity
 * @returns {boolean} 是否写成功（调用方据此决定要不要 warn）
 */
export function writeIdentityCache(profileDir, identity) {
  try {
    fs.mkdirSync(String(profileDir), { recursive: true });
    fs.writeFileSync(identityCachePathFor(profileDir), JSON.stringify(identity), { mode: 0o600 });
    return true;
  } catch { return false; }
}
