// verify-glm-mutation.mjs — 反向验证：把两处修复各自变异掉，新护栏必须变红。
//
// 纪律依据（本仓库反复记过）：「空转的闸门比没有闸门更坏」——变异工具必须
// **回报它真的改到了**（MUTATED ok），否则两次「全绿」都是假读数。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SRC = 'lib/agent-preset.js';
const TEST = 'test/glm-hybrid-call.test.mjs';
const original = fs.readFileSync(SRC, 'utf8');

const MUTANTS = [
  {
    name: '变异 A：混合形状的围栏收尾判据被移除（closesHybridCallFence 恒 false）',
    from: '  if (closesHybridCallFence(src, fenceStart)) return null;',
    to: '  if (false && closesHybridCallFence(src, fenceStart)) return null;',
  },
  {
    name: '变异 B：裸名分支的终止符判据被移除（只认 </tool_call>）',
    from: "    const closedByFence = /^[ \\t]*\\r?\\n?[ \\t]*```/.test(bareTail);",
    to: '    const closedByFence = false;',
  },
  {
    name: '变异 C：完整信封不再交给 takeObj（退回「整段当 arguments」）',
    from: "        takeObj(hit.raw);",
    to: "        // takeObj(hit.raw);  // MUTATED",
  },
];

function runTest() {
  try {
    execFileSync('node', ['--test', TEST], { stdio: 'pipe', encoding: 'utf8' });
    return { failed: 0, out: '' };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const m = out.match(/# fail (\d+)/) || out.match(/fail (\d+)/);
    return { failed: m ? Number(m[1]) : -1, out };
  }
}

console.log('===== 反向验证（变异测试）=====\n');
let allGood = true;
try {
  for (const mu of MUTANTS) {
    if (!original.includes(mu.from)) {
      console.log(`✖ ${mu.name}\n   变异锚点未找到——变异**没有生效**，本次读数无效`);
      allGood = false;
      continue;
    }
    fs.writeFileSync(SRC, original.replace(mu.from, mu.to));
    const applied = fs.readFileSync(SRC, 'utf8') !== original;
    console.log(`${applied ? 'MUTATED ok' : 'MUTATED FAILED'} — ${mu.name}`);
    if (!applied) { allGood = false; continue; }
    const r = runTest();
    console.log(`  新护栏读数: fail=${r.failed}  ${r.failed > 0 ? '✔ 如期变红' : '✖ 仍然全绿（护栏是空转的）'}`);
    if (r.failed <= 0) allGood = false;
    console.log('');
  }
} finally {
  fs.writeFileSync(SRC, original);
  console.log('已还原 lib/agent-preset.js');
  // 还原后必须回到全绿，否则说明还原没做干净。
  const back = runTest();
  console.log(`还原后读数: fail=${back.failed} ${back.failed === 0 ? '✔ 全绿' : '✖ 还原不干净'}`);
  if (back.failed !== 0) allGood = false;
}
console.log(`\n判定: ${allGood ? 'PASS — 三处变异各自都能让护栏变红，闸门不是空转' : 'FAIL — 见上'}`);
process.exitCode = allGood ? 0 : 1;
