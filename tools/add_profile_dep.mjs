/**
 * 把本地插件目录以 `link:` 形式写进 DSH profile 的依赖与 bundle 列表。
 *
 * 等价于 `dsh plugin --profile desktop add file:<dir>` 做的事（插件管理器内部就是
 * 改 package.json 的 dependencies + dsh.profile.bundles，然后在 profile 目录跑 pnpm install）。
 * 用 link: 而不是 file:：不打包、不复制 52MB 素材，源码改了重建 lib/ 立刻生效。
 *
 * 用法：node add_profile_dep.mjs <profileDir> <pluginDir>
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [, , profileArg, pluginArg] = process.argv;
if (!profileArg || !pluginArg) {
  console.error('usage: node add_profile_dep.mjs <profileDir> <pluginDir>');
  process.exit(2);
}

const profileDir = resolve(profileArg);
const pluginDir = resolve(pluginArg);
const pkgPath = join(profileDir, 'package.json');
const lockPath = join(profileDir, 'pnpm-lock.yaml');

if (!existsSync(pkgPath)) {
  console.error(`找不到 ${pkgPath}`);
  process.exit(2);
}
if (!existsSync(join(pluginDir, 'lib', 'index.js'))) {
  console.error(`插件还没构建：缺 ${join(pluginDir, 'lib', 'index.js')}`);
  process.exit(2);
}

// 备份一次（已有备份就不覆盖，保留最早的原件）
for (const file of [pkgPath, lockPath]) {
  if (!existsSync(file)) continue;
  const bak = `${file}.bak-before-pet`;
  if (!existsSync(bak)) copyFileSync(file, bak);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dependencies ??= {};
pkg.dependencies['dsh-pet'] = `link:${pluginDir.replaceAll('\\', '/')}`;
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes('dsh-pet')) pkg.dsh.profile.bundles.push('dsh-pet');
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`[ok] ${pkgPath}\n     dependency dsh-pet -> link:${pluginDir}`);
console.log(`[ok] bundles = ${pkg.dsh.profile.bundles.join(', ')}`);
