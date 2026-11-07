#!/usr/bin/env node
/**
 * repair-profile-link.mjs — 修复 DSH profile 里 dsh-sync-hub 的依赖协议，
 * 让『应用市场安装其它插件』不再报 [ERR_PNPM_EPERM] rename。
 *
 * 背景（实测）：profile 的 package.json 里 dsh-sync-hub 写成 file: 目录依赖，
 * pnpm 每次装任何插件都会重新导入这个包，用 rename 覆盖 node_modules 下已有的
 * 目录链接；Windows 不允许 rename 覆盖目录链接（即使没有进程占用），于是每个
 * 插件都装不上。改成 link: 协议后 pnpm 只维护链接，不再重新导入。
 *
 * 用法：
 *   node scripts/repair-profile-link.mjs            # 演练：只打印将要做的改动
 *   node scripts/repair-profile-link.mjs --apply    # 实际执行（先自动备份）
 *   node scripts/repair-profile-link.mjs --apply --profile desktop
 *
 * 说明：会写 profile 的 package.json / pnpm-lock.yaml / node_modules/.modules.yaml，
 * 执行前自动备份到 <DSH_HOME>/plugin-backups/<时间戳>/ 。
 */
import { readFile, writeFile, mkdir, copyFile, stat, lstat, readdir, realpath } from 'node:fs/promises';
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
const profileDir = join(dshHome(), 'profiles', profileName);
const pkgPath = join(profileDir, 'package.json');
const lockPath = join(profileDir, 'pnpm-lock.yaml');
const modulesPath = join(profileDir, 'node_modules', '.modules.yaml');
const linkTarget = join(profileDir, 'node_modules', 'dsh-sync-hub');

function findPnpm() {
  const runtimes = join(dshHome(), 'dsh-runtimes');
  const nodeBin = join(runtimes, 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
  const pnpmBin = join(runtimes, 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
  if (existsSync(nodeBin) && existsSync(pnpmBin)) return { node: nodeBin, pnpm: pnpmBin };
  return null;
}

async function main() {
  console.log('DSH_HOME      :', dshHome());
  console.log('profile       :', profileDir);
  console.log('工作区(链接目标):', workspace);
  console.log('模式          :', apply ? '实际执行 (--apply)' : '演练（不会写任何文件）');
  console.log('');
  if (!existsSync(pkgPath)) { console.error('✗ 找不到 profile package.json：' + pkgPath); process.exit(1); }

  const raw = await readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  const current = (pkg.dependencies || {})['dsh-sync-hub'];
  if (!current) { console.error('✗ profile 的 dependencies 里没有 dsh-sync-hub，无需修复。'); process.exit(0); }
  console.log('当前依赖写法 :', current);
  const desired = 'link:' + workspace.replace(/\\/g, '/');
  console.log('目标写法     :', desired);
  if (current === desired) { console.log('✓ 已经是目标写法，无需改动。'); }
  else {
    console.log('  改动 1: profile/package.json 的 dependencies.dsh-sync-hub');
    console.log('  改动 2: 让 pnpm 重建 pnpm-lock.yaml 与 node_modules/.modules.yaml（由 pnpm install 完成）');
    console.log('  改动 3: node_modules\\dsh-sync-hub 保持为指向工作区的链接（pnpm 会按 link: 协议重建）');
  }
  const cur = await lstat(linkTarget).catch(() => null);
  console.log('当前安装形态 :', cur ? (cur.isSymbolicLink() ? '链接 → ' + await realpath(linkTarget).catch(() => '?') : '真实目录') : '缺失');
  if (!apply) { console.log('\n演练结束。加 --apply 执行（会自动备份）。'); return; }

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const backup = join(dshHome(), 'plugin-backups', stamp);
  await mkdir(backup, { recursive: true });
  for (const f of [pkgPath, lockPath, modulesPath]) {
    if (existsSync(f)) await copyFile(f, join(backup, f.split(/[\\/]/).pop()));
  }
  console.log('\n已备份到:', backup);

  pkg.dependencies['dsh-sync-hub'] = desired;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('✓ 已写入 package.json');

  const tools = findPnpm();
  if (!tools) { console.error('✗ 找不到 pnpm 可执行文件，未执行 install。'); process.exit(1); }
  console.log('运行 pnpm install（profile 目录）...');
  try {
    const out = execFileSync(tools.node, [tools.pnpm, 'install', '--reporter', 'append-only'], {
      cwd: profileDir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(out.trim().split(/\r?\n/).slice(-8).join('\n'));
  } catch (e) {
    console.error('✗ pnpm install 失败：');
    console.error(String(e.stdout || '') + String(e.stderr || ''));
    process.exit(1);
  }
  const after = await lstat(linkTarget).catch(() => null);
  console.log('\n安装后形态 :', after ? (after.isSymbolicLink() ? '链接 → ' + await realpath(linkTarget).catch(() => '?') : '真实目录') : '缺失');
  console.log('完成。现在可以在应用市场里安装其它插件了。');
}

main().catch((e) => { console.error(e); process.exit(1); });
