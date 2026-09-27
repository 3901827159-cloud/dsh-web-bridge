// driver-scope.test.mjs — 源码**作用域**护栏：函数体内不得引用别处作用域的变量（2026-09-26）。
//
// ## 这个文件防的是哪一次真缺陷
//
// `lib/browser-driver.js` 的 `runTurn()`（模块级函数）里，续聊重试那一支写了：
//
//     warn(`resume navigation not ready — retrying once (site=${siteId}, ${nav.reason || 'n/a'})`);
//
// 而 `nav` 是**另一个函数** `sendTurn()` 里 `conversationNav()` 的返回值 —— 两者不是
// 同一个作用域，`runTurn` 只收到已经解好的 `navigate` 字符串（'fresh' 或目标 URL）。
// 于是这一行**必然**抛 `ReferenceError: nav is not defined`。
//
// 真机现场（2026-09-26，会话 `session-1e0e9c3f`，模型 `webcode/glm:glm-5.3-flash`）：
//
//     {"type":"assistant/attempt","chunk":{"type":"finish",
//      "reason":{"kind":"error","failure":{"message":"nav is not defined","code":"UNKNOWN"}}}}
//
// 用户看到的是「GLM 这一轮整个没回复」，而不是「重试一次后仍然失败」——
// 归因方向被彻底带偏（前两轮报告把 GLM 不稳归到「网页 UI 漂移 / 选择器 / 解码器」上）。
//
// ## 为什么已有的闸门一条都抓不到它（这才是加这条护栏的理由）
//
//   • `node --check` / `new vm.Script()` 判 **SYNTAX OK** —— 语法合法，作用域非法；
//   • 1064 条单测全绿 —— 没有任何一条走到「第二次导航仍不 ready」这个分支
//     （`attempt=0` 不进这一支；要进必须**第一次就失败**，而那需要真机冷加载）；
//   • `lint-comments` 查注释纪律，与作用域无关。
//
// 本仓库记过**同型**事故：0.19.0 的 `siteSlot` 被 `SiteCatalogBody` 跨组件调用
// （当时也只有作用域走查抓得到）。这一次是同一形状的第二例，所以把它做成常驻判据。
//
// ## 判据
//
//   ① `runTurn` 的函数体里引用的自由标识符，必须全部在「模块级绑定 ∪ `runTurn` 自身绑定
//      ∪ JS 内建全局」里；
//   ② 明确的回归钉：`runTurn` 体内不得出现 `nav`（无论以何种属性访问形式）；
//   ③ 扫描器自检：对合成源码断言它**确实**会报出跨作用域引用、**不会**误报本作用域内的
//      与内建全局的引用 —— 没有自检的话，扫描器一旦退化成「什么都看不见」，① 就变成
//      永远的绿，那比没有护栏更糟。
//
// ## 边界（刻意不做的事）
//
// 不引 parser（本仓库的检查工具一律是可直接 `node` 跑的独立文件，与
// `upload-attachment-structure.test.mjs` / `scripts/lint-comments.mjs` 同一传统）。
// 代价：只做**粗粒度**判定 —— 绑定表按「整个文件出现过的声明」收集，因此**只会漏报、
// 不会误报**（把别处的同名绑定当成可用，是宽松方向）。要抓的真缺陷（引用了文件里
// 根本没有的名字）不受这个宽松性影响：`nav` 在 `runTurn` 之外定义，但**属性访问的基对象**
// 必须是本作用域可见的，而 `runTurn` 的形参里没有它 ⇒ 判据②直接钉死这一例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DRIVER = path.join(import.meta.dirname, '..', 'lib', 'browser-driver.js');
const SRC = fs.readFileSync(DRIVER, 'utf8');

/** 斜杠处在「表达式起始位置」时它是正则字面量，不是除号（与 lint-comments.mjs 同源）。 */
const REGEX_START_AFTER = new Set(['', '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return']);

/** 跳过一段引号字面量，返回其结束后的下标。 */
function skipQuoted(src, i) {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** 跳过一段正则字面量；字符类 `[…]` 内的 `/` 不结束正则。 */
function skipRegex(src, i) {
  i += 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (inClass) { if (c === ']') inClass = false; }
    else if (c === '[') inClass = true;
    else if (c === '/') return i + 1;
    i += 1;
  }
  return i;
}

/**
 * 框出 `function <name>(…)` 的函数体（含两侧花括号），扫过字符串/注释/正则不计配平。
 * 与 `upload-attachment-structure.test.mjs` 的 `functionBodyOf` 同源同形。
 */
function functionBodyOf(src, name) {
  const declRe = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = declRe.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let paren = 1;
  let start = -1;
  let depth = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e + 1; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { i = skipQuoted(src, i); prev = c; continue; }
    if (c === '/' && REGEX_START_AFTER.has(prev)) { i = skipRegex(src, i); prev = '/'; continue; }
    if (c === '(') paren += 1;
    else if (c === ')') paren -= 1;
    else if (c === '{' && paren === 0) {
      if (start === -1) { start = i; depth = 1; prev = c; i += 1; continue; }
      depth += 1;
    } else if (c === '}' && paren === 0 && start !== -1) {
      depth -= 1;
      if (depth === 0) return { bodyStart: start, bodyEnd: i, body: src.slice(start, i + 1) };
    }
    if (c.trim() !== '') prev = c;
    i += 1;
  }
  return null;
}

/** 去掉注释与字符串（把模板串 `${}` 保留成代码），供「属性访问基对象」扫描用。 */
function codeOnly(src) {
  let out = '';
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e + 1; out += '\n'; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i); out += '""'; prev = '"'; continue; }
    if (c === '`') {
      // 模板串：只保留 ${…} 里的表达式（那才是代码）
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') { i += 1; break; }
        if (src[i] === '$' && src[i + 1] === '{') {
          let d = 1; i += 2; let buf = '';
          while (i < src.length && d > 0) {
            if (src[i] === '{') d += 1;
            else if (src[i] === '}') { d -= 1; if (d === 0) { i += 1; break; } }
            buf += src[i]; i += 1;
          }
          out += ' (' + codeOnly(buf) + ') ';
          continue;
        }
        i += 1;
      }
      prev = '`';
      continue;
    }
    if (c === '/' && REGEX_START_AFTER.has(prev)) { i = skipRegex(src, i); out += 'RE'; prev = 'E'; continue; }
    out += c;
    if (c.trim() !== '') prev = c;
    i += 1;
  }
  return out;
}

/** JS 内建全局（只列本仓驱动里真会用的那批 + 通用内建）。 */
const BUILTIN_GLOBALS = new Set(`globalThis window self document navigator location history console process
URL URLSearchParams setTimeout clearTimeout setInterval clearInterval setImmediate queueMicrotask Promise
Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp Error TypeError RangeError SyntaxError
ReferenceError Map Set WeakMap WeakSet Proxy Reflect ArrayBuffer Uint8Array Int32Array Float64Array DataView
TextEncoder TextDecoder AbortController AbortSignal structuredClone fetch Request Response Headers FormData
Blob File FileReader atob btoa encodeURIComponent decodeURIComponent parseInt parseFloat isNaN isFinite
arguments undefined NaN Infinity null true false this performance crypto queueMicrotask
`.split(/\s+/).filter(Boolean));

/**
 * 找出「体里被当作属性访问基对象/被调用」的名字，且**不在**给定绑定表与内建里。
 * 只收 `X.` / `X[` / `X(` 三种形态：独立的裸标识符（如 `return x`）噪声太大，
 * 而该缺陷的真实形态正是属性访问（`nav.reason`）。
 */
function freeBaseRefs(code, bound) {
  const found = new Map();
  const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*[.[(]/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[1];
    if (BUILTIN_GLOBALS.has(name)) continue;
    if (bound.has(name)) continue;
    // 关键字后面紧跟 `(` 的形态（if/for/while/switch/catch/return/typeof…）不是标识符引用。
    // `async` 也在其中：`async (` 出现在箭头函数/IIFE 前面（`async () => {…}`），
    // 它是修饰符而不是被引用的变量。
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new', 'delete', 'in', 'of', 'do', 'else', 'function', 'case', 'async', 'yield', 'void', 'throw', 'class', 'extends', 'static', 'import', 'export', 'default'].includes(name)) continue;
    if (!found.has(name)) found.set(name, m.index);
    re.lastIndex = m.index + m[0].length; // 防止同一处重复计数
  }
  return found;
}

const RUN_TURN = functionBodyOf(SRC, 'runTurn');

/**
 * 用于**绑定表**收集的源码：模板串里的字面文本被抹掉，只保留 `${…}` 里的表达式。
 *
 * ## 为什么必须有这一层（0.19.33 真缺陷暴露出的建模失真）
 *
 * 判据②原先直接在 `SRC`（原始源码）上跑正则收集绑定。而本文件里有大量
 * **注入模板串**（`DOM_CAPTURE` / `captureInit()` 的返回值 / 各站点脚本），它们
 * 是喂给 `page.evaluate` 在**浏览器**里执行的代码，与 Node 模块作用域毫无关系——
 * 可它们的内容照样会被 `const\s+(\w+)` 这类正则匹配到。
 *
 * 后果是一次真实的漏报：`DOM_CAPTURE` 里有
 *
 *     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
 *
 * 于是 `sleep` 被当成了「模块级绑定」，而 `runTurn` 里那句
 * `await sleep(1500)`（Node 侧，必然抛 `ReferenceError: sleep is not defined`）
 * 因此**被判为合法**。这正是本文件头注里写明的「只会漏报、不会误报」那个宽松
 * 方向的一次真实兑现——而漏报的代价与没有护栏完全相同。
 *
 * 抹掉模板串字面文本之后，绑定表只收**真正的 Node 侧声明**，判据②对这类缺陷
 * 才真正有效。`${…}` 里的表达式仍是代码（`codeOnly` 会保留），因此真正的模块级
 * 表达式不会被误删。
 */
const BINDING_SRC = codeOnly(SRC);

// ── 自检：扫描器必须真的看得见跨作用域引用、且不误报 ────────────────────────────

test('⓪ 扫描器自检：跨作用域引用必须报出，本作用域内与内建全局不得误报', () => {
  const sample = [
    'const outerVar = 1;',
    'async function target(a, { b = 2 } = {}) {',
    '  const localX = a + b;',
    '  if (console) { console.log(localX); }',
    '  await Promise.resolve(localX);',
    '  return outerVar + elsewhere.limit;',   // elsewhere 是跨作用域引用 ⇒ 应报
    '}',
  ].join('\n');

  const body = functionBodyOf(sample, 'target');
  assert.ok(body, '扫描器自检失败：连合成的 target 都框不出来（那 ① 就是永远假绿）');

  // 宽松绑定表：整个文件出现过的声明（与正式判据同一口径）
  const bound = new Set(['outerVar', 'target', 'a', 'b', 'localX']);
  const free = freeBaseRefs(codeOnly(body.body), bound);

  assert.ok(free.has('elsewhere'),
    '扫描器自检失败：合成的跨作用域引用 `elsewhere.limit` 没被报出来 ⇒ 判据①是装饰品');
  assert.ok(!free.has('localX'), '扫描器自检失败：本作用域内的 localX 被误报');
  assert.ok(!free.has('outerVar'), '扫描器自检失败：模块级 outerVar 被误报');
  assert.ok(!free.has('console'), '扫描器自检失败：内建 console 被误报');
  assert.ok(!free.has('Promise'), '扫描器自检失败：内建 Promise 被误报');
  assert.ok(!free.has('if'), '扫描器自检失败：关键字 if 被当成标识符');

  // 自检之二：字符串与注释里的同名文本不得计入
  const noisy = [
    'function t2() {',
    "  const s = 'other.limit';",
    '  // another.limit',
    '  /* third.limit */',
    '  return 1;',
    '}',
  ].join('\n');
  const b2 = functionBodyOf(noisy, 't2');
  const f2 = freeBaseRefs(codeOnly(b2.body), new Set(['t2', 's']));
  assert.equal(f2.size, 0,
    `扫描器自检失败：字符串/注释里的属性访问被算进来了（${[...f2.keys()].join(',')}）⇒ 会产生假红`);
});

// ── 判据 ①/②：runTurn 不得引用别处作用域的变量 ────────────────────────────────

test('① runTurn 函数体必须存在（护栏的前提）', () => {
  assert.ok(RUN_TURN, '扫描器找不到 runTurn 的函数体——护栏失效，必须修扫描器而不是放宽判据');
});

test('② runTurn 体内不得出现跨作用域的自由标识符（0.15.2–0.19.26 的 `nav` 缺陷回归）', () => {
  // 宽松绑定表：整个文件里出现过的**所有**声明位置 —— 只会漏报，不会误报。
  // 这里刻意**不**把 `runTurn` 之外的函数内局部变量算进去是做不到的（粗粒度），
  // 所以判据的实际力量来自「`nav` 这种名字在 runTurn 里根本没有，而它在文件里
  // 是另一个函数的 const」这一事实：粗粒度表会把 `nav` 当"绑定过"而放过它。
  // ⇒ 因此这里改用**精确**判据：runTurn 的形参表 + 模块级绑定 + 文件级函数声明。
  const bound = new Set();
  // 形参（含解构与默认值）
  const sig = /(?:async\s+)?function\s+runTurn\s*\(([\s\S]*?)\)\s*\{/.exec(SRC);
  assert.ok(sig, 'runTurn 的签名没解析出来——护栏失效');
  for (const piece of sig[1].replace(/[{}\[\]]/g, ' ').split(',')) {
    const p = piece.trim();
    if (!p) continue;
    const name = (p.includes(':') ? p.split(':')[0] : p).split('=')[0].trim().replace(/^\.\.\./, '');
    if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
  }
  // 模块级绑定：顶格（行首无缩进）的 const/let/var/function/class/import
  // ⚠ 跑在 **BINDING_SRC**（模板串字面文本已抹除）上，不是原始 SRC：
  // 在 SRC 上跑会把注入模板串里的 `const sleep = …` 收成模块级绑定，
  // 于是 Node 侧那句 `await sleep(1500)` 被判为合法（0.19.33 的真实漏报）。
  for (const m of BINDING_SRC.matchAll(/^(?:import\s+([\s\S]*?)\s+from|(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:export\s+)?const\s+([A-Za-z_$][\w$]*)|(?:export\s+)?let\s+([A-Za-z_$][\w$]*)|(?:export\s+)?class\s+([A-Za-z_$][\w$]*))/gm)) {
    if (m[2]) bound.add(m[2]);
    if (m[3]) bound.add(m[3]);
    if (m[4]) bound.add(m[4]);
    if (m[5]) bound.add(m[5]);
    if (m[1]) {
      for (const piece of m[1].replace(/[{}\[\]]/g, ' ').split(',')) {
        const name = piece.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
      }
    }
  }
  // 内层函数声明与块内 const（粗粒度补一批：把文件里任何 `function X(` / `const X =` 都算上，
  // 仍然只影响"误报"方向 ⇒ 保守）。**同样跑在 BINDING_SRC 上**——模板串里的
  // 同名声明一旦被收进来，判据就对这个名字失效（0.19.33 的 `sleep` 就是这样漏的）。
  for (const m of BINDING_SRC.matchAll(/(?:function\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of BINDING_SRC.matchAll(/function\s+\w+\s*\(([\s\S]*?)\)\s*\{/g)) {
    for (const piece of m[1].replace(/[{}\[\]]/g, ' ').split(',')) {
      const name = piece.trim().split(':')[0].split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
    }
  }

  const free = freeBaseRefs(codeOnly(RUN_TURN.body), bound);
  const list = [...free.keys()];
  assert.deepEqual(
    list, [],
    `runTurn 体内出现跨作用域的自由标识符：${list.join(', ')}\n`
    + '这些名字在本作用域没有绑定，运行到那一行必然抛 ReferenceError。\n'
    + '（这正是 0.15.2–0.19.26 的 `nav is not defined` 缺陷：`nav` 属于 sendTurn 的作用域。）',
  );
});

test('③ 回归钉：runTurn 体内不得出现 nav（缺陷的逐字形态）', () => {
  // 判据②是通用判据，可能会因绑定表变宽而漏掉 `nav`（例如将来真有人在同一文件里
  // 给别的函数加了 `const nav`）。这一条把缺陷的**逐字形态**单独钉住：
  // 只要 `nav` 以属性访问/调用形式出现在 runTurn 里，立刻变红。
  const code = codeOnly(RUN_TURN.body);
  assert.ok(
    !/(?<![.\w$])nav\s*[.[(]/.test(code),
    'runTurn 体内出现了 `nav` 引用：`nav` 是 sendTurn 里 conversationNav() 的返回值，'
    + 'runTurn 只收到已解好的 `navigate` 字符串。这一行必然抛 ReferenceError: nav is not defined '
    + '（真机 2026-09-26 GLM 会话 session-1e0e9c3f 逐字现场）。'
    + '要报诊断信息请用本作用域真实持有的 `target`。',
  );
});

test('④ 注释里对该缺陷的说明必须在位（避免下次有人「顺手清理」成旧写法）', () => {
  // 判据是「注释解释了**为什么不能**引用 nav」——不是「注释里有 nav 这个词」。
  assert.match(
    SRC,
    /不能\*\*引用\s*`nav`|不能\s*\*\*引用\s*`nav`/,
    'runTurn 重试分支上方那段「为什么不能引用 nav」的说明被删了。'
    + '本仓库的纪律是把「为什么不这么写」留在代码里（见 doc/comment-style.md），'
    + '删掉它，下一个人会把 `nav.reason` 当成一个显然的补充再加回去。',
  );
});

// ── 同族第二例：注入模板串里的名字不得当成 Node 侧绑定（0.19.33）───────────────

test('⑤ 回归钉：runTurn 体内不得引用 sleep（模板串作用域的逐字形态）', () => {
  // `sleep` 只在本文件的 `DOM_CAPTURE` **注入模板串**里定义（那是给 page.evaluate
  // 在浏览器里跑的代码）。Node 侧引用它必然抛 `ReferenceError: sleep is not defined`。
  //
  // 真机现场与 `nav` 那一例**触发条件完全相同**：`attempt=0` 不进重试支，
  // 只有第一次导航就没 ready 才踏进来（页面冷加载慢的常见现场），于是被
  // `runTurn` 的 catch 当成普通失败 —— 用户看到的是「GLM 这一轮整个没回复」。
  //
  // 为什么这条钉必须存在：判据②是通用判据，而它此前对 `sleep` **恰好是瞎的**
  //（绑定表在原始源码上收集，模板串里的 `const sleep = …` 被当成了真绑定）。
  // 通用判据的建模失真修好之后（见 BINDING_SRC 注释），这条逐字钉仍然要留下 ——
  // 它不依赖扫描器是否足够聪明，只回答「runTurn 里有没有引用这个浏览器侧的名字」。
  const code = codeOnly(RUN_TURN.body);
  assert.ok(
    !/(?<![.\w$])sleep\s*[.[(]/.test(code),
    'runTurn 体内出现了 `sleep` 引用：`sleep` 只存在于 DOM_CAPTURE 注入模板串里，'
    + 'Node 模块作用域没有这个绑定。这一行必然抛 ReferenceError: sleep is not defined。'
    + 'Node 侧的等待原语是本文件模块级的 `delay(ms)`。',
  );
});

test('⑥ 扫描器自检：模板串里的声明**不得**进入绑定表（0.19.33 漏报的根因）', () => {
  // 没有这条自检，「把绑定表换回原始 SRC」这个动作不会有任何红灯 —— 而那正是
  // `sleep` 漏报的原因，也意味着下一次同型缺陷照样漏。
  //
  // ⚠ 差异在**绑定表怎么建**，不在函数体怎么扫：`codeOnly` 两边都会抹掉模板串
  // 的字面文本，所以 `freeBaseRefs` 看到的代码永远是一样的。让 `sleep` 逃掉的是
  // 「建绑定表时**没有**抹模板串」这一步（`const sleep = …` 被收成了模块级绑定）。
  const sample = [
    'const MODULE_LEVEL = 1;',
    'function inject() {',
    '  return `',
    '    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
    '    await sleep(1000);',
    '  `;',
    '}',
    'async function target() {',
    '  await sleep(1500);',   // 模板串里声明过，但 Node 侧没有 ⇒ 必须报
    '  return MODULE_LEVEL;',
    '}',
  ].join('\n');

  /** 与判据②逐字同源的绑定表构造：给定源码，收出模块级与内层声明。 */
  const collectBindings = (src) => {
    const bound = new Set(['target']);
    for (const m of src.matchAll(/^(?:import\s+([\s\S]*?)\s+from|(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:export\s+)?const\s+([A-Za-z_$][\w$]*)|(?:export\s+)?let\s+([A-Za-z_$][\w$]*)|(?:export\s+)?class\s+([A-Za-z_$][\w$]*))/gm)) {
      for (const g of [m[2], m[3], m[4], m[5]]) if (g) bound.add(g);
    }
    for (const m of src.matchAll(/(?:function\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
    return bound;
  };

  const body = functionBodyOf(sample, 'target');
  assert.ok(body, '扫描器自检失败：合成的 target 框不出来');
  const code = codeOnly(body.body);

  // ① 建模失真（旧写法）：绑定表建在原始源码上 ⇒ `sleep` 被当成已绑定 ⇒ 漏报。
  //    这条断言把「失真长什么样」钉住：它一旦不再复现，下面那条自检就保护不了任何东西。
  const naive = freeBaseRefs(code, collectBindings(sample));
  assert.ok(!naive.has('sleep'),
    '扫描器自检失败：合成用例没能复现 0.19.33 的漏报条件（`sleep` 在原始源码上建表后 '
    + '竟然仍被报出）——这条自检已失效，必须重做而不是放宽');

  // ② 本文件的修法：绑定表建在抹掉模板串字面文本的源码上 ⇒ `sleep` 不再被当成绑定
  //    ⇒ 判据②真的能抓住它。
  const fixed = freeBaseRefs(code, collectBindings(codeOnly(sample)));
  assert.ok(fixed.has('sleep'),
    '扫描器自检失败：抹掉模板串后 `sleep` 仍未被报出 —— 判据②对这类缺陷依然是瞎的');
  assert.ok(!fixed.has('MODULE_LEVEL'), '扫描器自检失败：真正的模块级绑定被误报');
});
