#!/usr/bin/env node
/**
 * repair-profile-link.mjs — 修复 DSH profile 里 dsh-sync-hub 的依赖协议，
 * 让『应用市场安装其它插件』不再报 [ERR_PNPM_EPERM] rename。
 *
 * 背景（2026-11-07 实测）：
 *   1) profile/package.json 里 dsh-sync-hub 写成 file: 目录依赖，pnpm 每次装任何
 *      插件都会重新导入这个包，用 rename 覆盖 node_modules 下已有的目录链接；
 *      Windows 不允许 rename 覆盖目录链接（即便没有进程占用）→ 每个插件都装不上。
 *   2) node_modules/.modules.yaml 里 injectedDeps 还记着项目搬家前的旧路径，
 *      pnpm 每次 install 都要"修复"这个不一致 → 反复重新导入 → 触发上面的 rename。
 *   3) pnpm 会比对 .modules.yaml 记录的 storeDir / virtualStoreDir 与当前生效值；
 *      不一致就判定 modules 目录不兼容并想整体重建（无 TTY 时报
 *      ERR_PNPM_ABORTED_REMULES_DIR_NO_TTY）。所以 install 必须显式带上
 *      --store-dir=<.modules.yaml 记录的 storeDir>，virtualStoreDir 也要指向当前 profile。
 *
 * 本脚本做四件事（默认演练，加 --apply 才动手）：
 *   A. 备份 package.json / pnpm-lock.yaml / node_modules/.modules.yaml
 *   B. package.json: dependencies.dsh-sync-hub 改成 link:<本仓库绝对路径>
 *   C. pnpm-lock.yaml: importers 里同步改成 link:，删掉 packages/snapshots 里的旧条目，
 *      并删掉 package.json 里已经不存在的依赖（否则 --frozen-lockfile 直接报错）
 *   D. node_modules/.modules.yaml: 清掉指向旧路径的 injectedDeps / hoistedLocations 记录，
 *      并把 virtualStoreDir 对齐到当前 profile
 *   最后跑 pnpm install --frozen-lockfile --store-dir=<记录的 store>（冻结模式：不重新解析版本，
 *   不会偷偷升级任何插件）。
 *
 * 用法：
 *   node scripts/repair-profile-link.mjs            # 演练：只打印将要做的改动
 *   node scripts/repair-profile-link.mjs --apply    # 实际执行（先自动备份）
 *   node scripts/repair-profile-link.mjs --apply --profile desktop
 */
import { readFile, writeFile, mkdir, copyFile, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '..');            // 本仓库 = 插件源码 = 链接目标
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const profileIdx = args.indexOf('--profile');
const profileName = profileIdx >= 0 ? args[profileIdx + 1] : 'desktop';

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const idx = args.indexOf('--dsh-home');
  if (idx >= 0 && args[idx + 1]) return resolve(args[idx + 1]);
  return join(homedir(), '.dsh');
}
const home = dshHome();
const profileDir = join(home, 'profiles', profileName);
const pkgPath = join(profileDir, 'package.json');
const lockPath = join(profileDir, 'pnpm-lock.yaml');
const modulesPath = join(profileDir, 'node_modules', '.modules.yaml');
const linkTarget = join(profileDir, 'node_modules', 'dsh-sync-hub');
const linkSpec = 'link:' + workspace.replace(/\\/g, '/');
const wantVirtualStore = join(profileDir, 'node_modules', '.pnpm');

function findPnpm() {
  for (const base of [home, join(homedir(), '.dsh')]) {
    const nodeBin = join(base, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
    const pnpmBin = join(base, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
    if (existsSync(nodeBin) && existsSync(pnpmBin)) return { node: nodeBin, pnpm: pnpmBin };
  }
  return null;
}

/** 顶层段落（packages / snapshots / importers）的行范围 */
function sectionRange(lines, topKey) {
  const start = lines.findIndex((l) => l.startsWith(topKey + ':'));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[a-zA-Z]/.test(lines[i]) && lines[i].trim()) { end = i; break; }
  }
  return { start, end };
}

/** 把一段行解析成 { name, start, end } 块列表（块 = 名字行 + 其后更深缩进的行） */
function blocks(lines, from, to, indent) {
  const out = [];
  const pad = ' '.repeat(indent);
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (!line.startsWith(pad) || line.trim() === '' || line.slice(indent).startsWith(' ')) continue;
    const name = line.slice(indent).split(':')[0].trim().replace(/^['"]|['"]$/g, '');
    let end = i + 1;
    while (end < to && (lines[end].trim() === '' || lines[end].startsWith(' '.repeat(indent + 2)))) end++;
    out.push({ name, start: i, end });
    i = end - 1;
  }
  return out;
}

/** 根 importer 的 dependencies 块范围 */
function rootImporterDeps(lines) {
  const imp = sectionRange(lines, 'importers');
  if (!imp) return null;
  const rootStart = lines.findIndex((l, i) => i >= imp.start && l.trim() === '.:');
  if (rootStart < 0) return null;
  let rootEnd = imp.end;
  for (let i = rootStart + 1; i < imp.end; i++) {
    if (/^  [a-zA-Z]/.test(lines[i]) && lines[i].trim() !== '.:') { rootEnd = i; break; }
  }
  const depsStart = lines.findIndex((l, i) => i > rootStart && i < rootEnd && /^    dependencies:/.test(l));
  if (depsStart < 0) return null;
  return { depsStart, rootEnd, list: blocks(lines, depsStart + 1, rootEnd, 6) };
}

async function main() {
  console.log('DSH_HOME       :', home);
  console.log('profile        :', profileDir);
  console.log('工作区(链接目标):', workspace);
  console.log('模式           :', apply ? '实际执行 (--apply)' : '演练（不会写任何文件）');
  console.log('');
  if (!existsSync(pkgPath)) { console.error('✗ 找不到 profile package.json：' + pkgPath); process.exit(1); }

  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const deps = pkg.dependencies || {};
  const current = deps['dsh-sync-hub'];
  if (!current) { console.error('✗ profile 的 dependencies 里没有 dsh-sync-hub，无需修复。'); process.exit(0); }

  const lockRaw = existsSync(lockPath) ? await readFile(lockPath, 'utf8') : '';
  const lockLines = lockRaw.split(/\r?\n/);
  const modulesRaw = existsSync(modulesPath) ? await readFile(modulesPath, 'utf8') : '{}';
  let modules = {};
  try { modules = JSON.parse(modulesRaw); } catch { modules = {}; }
  const storeDir = modules.storeDir || '';

  const cur = await lstat(linkTarget).catch(() => null);
  console.log('当前依赖写法   :', current);
  console.log('目标写法       :', linkSpec);
  console.log('记录的 storeDir:', storeDir || '(取不到)');
  console.log('virtualStoreDir:', modules.virtualStoreDir || '(无)', '→ 期望', wantVirtualStore);
  console.log('当前安装形态   :', cur ? (cur.isSymbolicLink() ? '链接 → ' + await realpath(linkTarget).catch(() => '?') : '真实目录') : '缺失');
  console.log('陈旧 injectedDeps:', JSON.stringify(modules.injectedDeps || {}));

  const root = lockLines.length ? rootImporterDeps(lockLines) : null;
  const orphanNames = root ? root.list.filter((b) => !(b.name in deps)).map((b) => b.name) : [];
  console.log('');
  console.log('将要做的改动：');
  console.log('  1) package.json: dependencies.dsh-sync-hub →', linkSpec, current === linkSpec ? '(已是目标值)' : '');
  console.log('  2) pnpm-lock.yaml: importers 同步改成 link:；删除 packages/snapshots 里的旧 dsh-sync-hub 条目');
  console.log('  3) pnpm-lock.yaml: 删除 package.json 里已不存在的依赖条目 →', orphanNames.join(', ') || '(无)');
  console.log('  4) node_modules/.modules.yaml: 清理 stale injectedDeps / hoistedLocations；对齐 virtualStoreDir');
  console.log('  5) pnpm install --frozen-lockfile --store-dir=' + (storeDir || '<默认>'));

  if (!apply) { console.log('\n演练结束。加 --apply 执行（会自动备份）。'); return; }

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const backup = join(home, 'plugin-backups', stamp);
  await mkdir(backup, { recursive: true });
  for (const f of [pkgPath, lockPath, modulesPath]) {
    if (existsSync(f)) await copyFile(f, join(backup, f.split(/[\\/]/).pop()));
  }
  console.log('\n已备份到:', backup);

  // B. package.json
  pkg.dependencies['dsh-sync-hub'] = linkSpec;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('✓ package.json 已更新');

  // C. pnpm-lock.yaml —— 先算出所有编辑，再按下标从后往前应用，避免行号错位
  if (lockLines.length && root) {
    const edits = [];   // { start, end, lines }
    const target = root.list.find((b) => b.name === 'dsh-sync-hub');
    if (target) {
      const body = lockLines.slice(target.start, target.end)
        .map((l) => l.replace(/^(\s*)(specifier|version):.*$/, '$1$2: ' + linkSpec));
      edits.push({ start: target.start, end: target.end, lines: body });
    }
    for (const b of root.list) {
      if (b.name in deps) continue;
      edits.push({ start: b.start, end: b.end, lines: [] });
      // 顺带清掉 packages / snapshots 里的同名条目（仅当没有别处引用时）
      const ver = (lockLines.slice(b.start, b.end).find((l) => /^\s+version:/.test(l)) || '').trim().replace(/^version:\s*/, '');
      if (!ver) continue;
      const needle = b.name + '@' + ver;
      const refs = lockLines.filter((l) => l.includes(needle)).length;
      if (refs > 3) { console.log('  ! ' + needle + ' 还有别处引用（' + refs + ' 处），保留 packages/snapshots 条目'); continue; }
      for (const top of ['packages', 'snapshots']) {
        const sec = sectionRange(lockLines, top);
        if (!sec) continue;
        for (const pb of blocks(lockLines, sec.start + 1, sec.end, 2)) {
          if (pb.name !== needle) continue;
          edits.push({ start: pb.start, end: pb.end, lines: [] });
        }
      }
    }
    for (const top of ['packages', 'snapshots']) {
      const sec = sectionRange(lockLines, top);
      if (!sec) continue;
      for (const pb of blocks(lockLines, sec.start + 1, sec.end, 2)) {
        if (!/^dsh-sync-hub@/i.test(pb.name)) continue;
        edits.push({ start: pb.start, end: pb.end, lines: [] });
      }
    }
    edits.sort((a, b) => b.start - a.start);
    const out = lockLines.slice();
    for (const e of edits) out.splice(e.start, e.end - e.start, ...e.lines);
    await writeFile(lockPath, out.join('\n'), 'utf8');
    console.log('✓ pnpm-lock.yaml 已更新（' + edits.length + ' 处编辑）');
  }

  // D. .modules.yaml
  if (modulesRaw !== '{}') {
    const m = JSON.parse(modulesRaw);
    m.injectedDeps = Object.fromEntries(Object.entries(m.injectedDeps || {})
      .filter(([k]) => !/dsh-sync-hub/i.test(k) && !/VibeCoding/i.test(k)));
    m.hoistedLocations = Object.fromEntries(Object.entries(m.hoistedLocations || {})
      .filter(([k]) => !/^dsh-sync-hub@/i.test(k)));
    if (m.virtualStoreDir && m.virtualStoreDir !== wantVirtualStore) {
      console.log('  · virtualStoreDir:', m.virtualStoreDir, '→', wantVirtualStore);
      m.virtualStoreDir = wantVirtualStore;
    }
    await writeFile(modulesPath, JSON.stringify(m, null, 2), 'utf8');
    console.log('✓ node_modules/.modules.yaml 已清理');
  }

  // E. pnpm install（冻结模式 + 与 .modules.yaml 一致的 store 目录）
  const tools = findPnpm();
  if (!tools) { console.error('✗ 找不到 pnpm 可执行文件，未执行 install。'); process.exit(1); }
  const installArgs = [tools.pnpm, 'install', '--frozen-lockfile', '--reporter', 'append-only'];
  if (storeDir) installArgs.push('--store-dir=' + storeDir);
  console.log('运行 pnpm install --frozen-lockfile' + (storeDir ? ' --store-dir=' + storeDir : '') + ' …');
  try {
    const outText = execFileSync(tools.node, installArgs, {
      cwd: profileDir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(outText.trim().split(/\r?\n/).slice(-8).join('\n'));
  } catch (e) {
    console.error('✗ pnpm install 失败：');
    console.error(String(e.stdout || '') + String(e.stderr || ''));
    process.exit(1);
  }

  const after = await lstat(linkTarget).catch(() => null);
  console.log('\n安装后形态     :', after ? (after.isSymbolicLink() ? '链接 → ' + await realpath(linkTarget).catch(() => '?') : '真实目录') : '缺失');
  console.log('完成。现在可以在应用市场里安装其它插件了。');
}

main().catch((e) => { console.error(e); process.exit(1); });
