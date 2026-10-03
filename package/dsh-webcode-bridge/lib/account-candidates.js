// account-candidates.js — 「账号昵称/头像候选」的**唯一**页面侧扫描实现。
//
// ## 为什么必须有这个模块
//
// 它回答的问题只有一个：**页面上哪些节点可能在承载当前账号的昵称与头像？**
// 这个问题目前有两个消费者，而两处各写一份必然漂移（本仓库对「两处口径漂移」
// 记过多次，见 `doc/long-term-issues.md`）：
//
//   1. `lib/browser-driver.js` 的 `readAccountIdentity({ debug: true })` ——
//      对**桥自己的活页面**（已登录）采一次候选读数，供真机取证选择器；
//   2. `test-mock/probe-account-identity.mjs` —— 在**profile 副本**上做离线取证。
//
// 两处都必须扫同一批子树、用同一种选择器提示、同一种噪声类名过滤。因此实现收在这里，
// 两个消费者都只**引用**它。
//
// ## 硬约束：这是一个「页面侧函数」
//
// 它会经 `page.evaluate` **序列化后在浏览器里单独执行**（`browser-driver` 与探针脚本
// 都如此）。因此：
//   · 函数体**必须自包含**——不得引用模块作用域的任何东西（辅助函数、常量都不行）；
//   · 不得使用 Node 内置模块或 `require`；
//   · 语法必须是浏览器能跑的那一档（本文件的 `catch {}` 无绑定形态在 Chromium 上可行）。
// 违反的典型症状是 `ReferenceError`，而 **Node 侧单测全绿**——因为单测在同一作用域里跑
//（这条教训写在 `wiki/glossary.md` 的「页面侧函数」条与 `think-effort.js` 的文件头）。
//
// ## 它只回传**候选**，不拍板选择器
//
// 本项目纪律：**站点选择器必须来自真机读数**，不许凭印象编。所以这里刻意不返回
// 「最终答案」，而是返回候选 + 可复用选择器提示 + 语义分数，由人（或后续步骤）
// 据此挑出稳定选择器再写进 `providers.js` 的 `accountProbe`。

/** 每类候选最多回传多少条（防止把整页 DOM 灌进 JSON）。 */
export const MAX_CANDIDATES_PER_KIND = 40;

/**
 * 扫描当前页面，回传「昵称候选 / 头像候选 / 登录态线索」。
 *
 * **这是页面侧函数（自包含）**——见文件头的硬约束。它只能经
 * `page.evaluate(ACCOUNT_CANDIDATE_PROBE)` 调用，不要在 Node 里直接调它
 * （那样读不到页面，且会把「序列化后自包含」这条约束掩盖掉）。
 *
 * @returns {{url: string, title: string, loginHints: string[], nameCandidates: object[], avatarCandidates: object[], notes: string[]}}
 *   候选条目形状：`{ selectorHint, tag, className, id, text?, src?, bgUrl?, rect, naturalSize?, isButtonish?, score }`
 */
export function ACCOUNT_CANDIDATE_PROBE() {
  const notes = [];
  const MAX = 40;
  const SEM_RE = /user|avatar|nick|name|account|profile|头像|昵称/gi;
  // 「不是昵称」的按钮/入口文案（与 browser-driver 的 NOT_A_NAME_RE 同口径，另补侧栏常见项）。
  const NOT_NAME = new Set(['登录', '登陆', '注册', '设置', '通知', '帮助', '退出', '登录/注册', '登录注册',
    'sign in', 'sign up', 'log in', 'login', 'logout', 'settings', 'account', 'help', 'notifications']);

  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.05;
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  // SVG 元素的 className 是 SVGAnimatedString，不能直接当字符串用。
  const clsOf = (el) => String(typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '');
  const idOf = (el) => (el.id ? String(el.id) : '');

  /** 噪声类名：哈希 / CSS-in-JS / CSS Modules 生成的一族——它们随构建变，不能进选择器。 */
  const isNoisyCls = (c) => {
    if (!c || c.length > 40) return true;
    if (!/^[A-Za-z_-]/.test(c)) return true;                     // 数字/符号开头
    if (/^css-[a-z0-9]+$/i.test(c)) return true;                 // emotion / vanilla-extract
    if (/^sc-[a-z0-9]+$/i.test(c)) return true;                  // styled-components
    if (/^[a-z]+_[a-z0-9]{5,}$/i.test(c)) return true;           // CSS Modules
    if (/[0-9a-f]{6,}/i.test(c) && !/[aeiou]{2}/i.test(c)) return true; // 长十六进制串
    if (/[0-9]{3,}/.test(c)) return true;                        // 3 位以上连号数字
    return false;
  };

  /** 可复用选择器提示：优先 `#id`，其次 `tag.class1.class2`（最多 3 个类）。 */
  const selectorHint = (el) => {
    const id = idOf(el);
    if (id) return /^[A-Za-z_][\w-]*$/.test(id) ? '#' + id : '[id="' + id.replace(/"/g, '\\"') + '"]';
    const tag = el.tagName.toLowerCase();
    const classes = clsOf(el).split(/\s+/).filter(Boolean).filter((c) => !isNoisyCls(c)).slice(0, 3);
    return classes.length ? tag + '.' + classes.join('.') : tag;
  };

  const semHits = (s) => (String(s || '').match(SEM_RE) || []).length;
  const attrsOf = (el) => ({
    alt: el.getAttribute('alt') || null,
    ariaLabel: el.getAttribute('aria-label') || null,
    title: el.getAttribute('title') || null,
    testid: el.getAttribute('data-testid') || null,
  });
  /** 语义分数：class/id/alt/aria-label/title/data-testid 命中语义词者靠前。 */
  const scoreOf = (el, text, src) => {
    const attrs = [el.getAttribute('alt'), el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid')]
      .filter(Boolean).join(' ');
    let s = semHits(idOf(el)) * 8 + semHits(clsOf(el)) * 4 + semHits(attrs) * 6;
    if (src) s += semHits(src) * 5;
    if (text && text.length <= 20) s += 1;   // 短文本更像昵称
    return s;
  };

  // ---- 1) 昵称候选：语义子树（header/nav/侧栏/用户/账号/头像）里的叶子元素 --------------
  const SCOPE = 'header, nav, aside, [class*="sidebar"], [class*="Sidebar"], [class*="header"], [class*="Header"], '
    + '[class*="user"], [class*="User"], [class*="account"], [class*="Account"], [class*="avatar"], [class*="Avatar"]';
  let roots = [];
  try { roots = [...document.querySelectorAll(SCOPE)].filter(vis); } catch (e) { notes.push('子树选择器失败: ' + e.message); }
  const nameCandidates = [];
  const seen = new Set();
  let visited = 0;
  for (const root of roots) {
    for (const el of root.querySelectorAll('*')) {
      if (visited++ > 20000) break;
      if (el.children.length !== 0 || seen.has(el)) continue;   // 只看叶子
      seen.add(el);
      let text = '';
      try { text = String(el.textContent || '').trim().replace(/\s+/g, ' '); } catch { continue; }
      if (!text || text.length > 40) continue;
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      if (NOT_NAME.has(text.toLowerCase())) continue;
      if (!vis(el)) continue;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      nameCandidates.push({
        selectorHint: selectorHint(el), tag, className: clsOf(el).slice(0, 200), id: idOf(el) || null,
        text, rect: rectOf(el), role: role || null, ...attrsOf(el),
        isButtonish: tag === 'button' || tag === 'a' || role === 'button' || /btn|button/i.test(clsOf(el)),
        score: scoreOf(el, text, null),
      });
    }
  }
  if (!roots.length) notes.push('未匹配到任何语义子树根，昵称候选可能偏少');

  // ---- 2) 头像候选：可见 img（边长 ≥16）+ background-image 含 url( 的节点 ---------------
  const avatarCandidates = [];
  for (const el of document.querySelectorAll('img')) {
    const r = rectOf(el);
    if (r.w < 16 || r.h < 16 || !vis(el)) continue;
    const src = el.currentSrc || el.src || el.getAttribute('src') || null;
    avatarCandidates.push({
      selectorHint: selectorHint(el), tag: 'img', className: clsOf(el).slice(0, 200), id: idOf(el) || null,
      src: src ? String(src).slice(0, 500) : null, bgUrl: null, rect: r,
      naturalSize: { w: el.naturalWidth, h: el.naturalHeight }, ...attrsOf(el),
      score: scoreOf(el, '', src ? String(src) : ''),
    });
  }
  for (const el of document.querySelectorAll('div, span, a, button, i, section')) {
    let bg = '';
    try { bg = getComputedStyle(el).backgroundImage || ''; } catch { continue; }
    const m = bg.match(/url\(["']?([^"')]+)/);
    if (!m) continue;
    const r = rectOf(el);
    if (r.w < 16 || r.h < 16 || !vis(el)) continue;
    avatarCandidates.push({
      selectorHint: selectorHint(el), tag: el.tagName.toLowerCase(), className: clsOf(el).slice(0, 200),
      id: idOf(el) || null, src: null, bgUrl: m[1].slice(0, 500), rect: r, naturalSize: null,
      ...attrsOf(el), score: scoreOf(el, '', m[1]),
    });
  }

  // ---- 3) 登录态线索：可见、文本含「登录 / Sign in / Log in」的叶子节点 ------------------
  const loginHints = [];
  for (const el of document.querySelectorAll('a, button, [role="button"], [role="link"], [class*="login"], [class*="Login"], p, span, div')) {
    if (el.children.length) continue;   // 只看叶子，避免祖先把整页文本吞进来
    const text = String(el.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text || text.length > 30) continue;
    if (!/(登录|登陆|sign\s*in|log\s*in|login)/i.test(text)) continue;
    // 「退出登录 / 注销 / Sign out」是**已登录**页面的特征，含「登录」二字但不是登录入口——
    // 不排掉它会把已登录页面误判成游客态（方向反了，比漏报更糟）。
    if (/退出|注销|sign\s*out|log\s*out/i.test(text)) continue;
    if (!vis(el)) continue;
    loginHints.push(text);
  }

  const byScore = (a, b) => b.score - a.score;
  nameCandidates.sort(byScore);
  avatarCandidates.sort(byScore);

  return {
    url: location.href,
    title: document.title,
    loginHints: [...new Set(loginHints)].slice(0, 20),
    nameCandidates: nameCandidates.slice(0, MAX),
    avatarCandidates: avatarCandidates.slice(0, MAX),
    notes: notes.concat(
      nameCandidates.length ? [] : ['nameCandidates 为空：探测范围可能不够，需要扩大子树范围'],
      avatarCandidates.length ? [] : ['avatarCandidates 为空：探测范围可能不够'],
    ),
  };
}
