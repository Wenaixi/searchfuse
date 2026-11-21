// 校验 docs/parity-matrix.md 的每一格不是假绿。
//
// 背景：spec 的 S6 验收最初写成「矩阵无空单元格」，但「非空字符串」可以被
// 一个不存在的测试名满足。这个脚本把它变成真的检查：
// - `<file>::<testName>`：文件必须存在，且该测试名必须出现在文件里
// - `N/A: <reason>`：理由必须在白名单里
// - `TODO(S<n>)`：允许，但 S6 完成后（--final）一律失败
//
// 用法：
//   node scripts/parity-check.mjs            # 允许 TODO
//   node scripts/parity-check.mjs --final    # 禁止 TODO（CI 主分支用）

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX = join(ROOT, 'docs', 'parity-matrix.md');

/** 宿主不支持的三种理由，与 spec §十 的白名单一致。 */
const NA_REASONS = [
  '宿主无此 API',
  '宿主强制命名空间不同',
  '宿主无对应 UI',
];

/** 矩阵里不算「能力单元格」的列。 */
const HOST_COLUMNS = ['dsh', 'Claude Code', 'omp'];

const final = process.argv.includes('--final');
const problems = [];

if (!existsSync(MATRIX)) {
  console.error(`parity-check: 找不到 ${MATRIX}`);
  process.exit(1);
}

const lines = readFileSync(MATRIX, 'utf8').split(/\r?\n/);

// 只解析「能力矩阵」那一节的表格，其余节（已知语义损失等）不参与断言。
let inCapabilityTable = false;
let headerSeen = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();

  if (trimmed.startsWith('## 矩阵')) {
    inCapabilityTable = true;
    headerSeen = false;
    continue;
  }
  if (inCapabilityTable && trimmed.startsWith('## ')) {
    break;
  }
  if (!inCapabilityTable || !trimmed.startsWith('|')) continue;

  const cells = splitRow(trimmed);
  // 第一行是表头，第二行是分隔符。
  if (!headerSeen) {
    headerSeen = true;
    continue;
  }
  if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;

  const [capability, ...hosts] = cells;
  if (hosts.length !== HOST_COLUMNS.length) {
    problems.push(`${i + 1} 行：列数不是 ${HOST_COLUMNS.length + 1}（${trimmed}）`);
    continue;
  }

  for (let h = 0; h < HOST_COLUMNS.length; h++) {
    const host = HOST_COLUMNS[h];
    const cell = hosts[h];
    const label = `「${capability}」× ${host}`;

    if (cell === '') {
      problems.push(`${i + 1} 行：${label} 是空单元格`);
      continue;
    }
    if (cell.startsWith('TODO(')) {
      if (final) problems.push(`${i + 1} 行：${label} 仍是 ${cell}（--final 不允许）`);
      continue;
    }
    if (cell.startsWith('N/A')) {
      const reason = cell.slice(cell.indexOf(':') + 1).trim();
      if (!NA_REASONS.some((r) => reason.startsWith(r))) {
        problems.push(`${i + 1} 行：${label} 的 N/A 理由不在白名单「${reason}」`);
      }
      continue;
    }

    const sep = cell.lastIndexOf('::');
    if (sep === -1) {
      problems.push(`${i + 1} 行：${label} 不是 <file>::<testName>、N/A 或 TODO（${cell}）`);
      continue;
    }
    const file = cell.slice(0, sep).trim();
    const testName = cell.slice(sep + 2).trim();
    const full = join(ROOT, file);
    if (!existsSync(full)) {
      problems.push(`${i + 1} 行：${label} 指向的文件不存在（${file}）`);
      continue;
    }
    if (!readFileSync(full, 'utf8').includes(testName)) {
      problems.push(`${i + 1} 行：${label} 的测试名不在 ${file}（${testName}）`);
    }
  }
}

/** 拆一行表格，去掉首尾的管道与空白。 */
function splitRow(trimmed) {
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  // 单元格里不会出现未转义的 |，所以直接切。
  return body.split('|').map((c) => c.trim());
}

if (problems.length > 0) {
  console.error(`parity-check: ${problems.length} 处不合格\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const total = lines.filter((l) => l.trim().startsWith('|') && !l.includes(':---')).length;
console.log(`parity-check: 通过（${final ? 'final 模式，无 TODO' : '允许 TODO'}）`);
