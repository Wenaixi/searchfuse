import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dshInstallTargets,
  readPackageName,
  readPackageVersion,
  readStampedVersions,
  repoRoot,
  skillName,
  stampTargets,
} from './stamp.mjs';

describe('launcher version stamping', () => {
  it('keeps launchers and dsh install commands pinned to the package version', () => {
    const version = readPackageVersion();
    const stampedVersions = readStampedVersions();
    expect(stampedVersions.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'INSTALL.md dsh install',
        'INSTALL.md dsh config',
        'README.md dsh install',
        // README 是唯一保留双语的文件，所以两个版本号行都还在。
        'README.zh-CN.md dsh install',
        // 其余文档只剩中文版，主文件名就是它们自己。
        'harness-setup.md dsh install',
        'harness-setup.md dsh update',
        'dsh.md install',
        'dsh.md doctor',
        'dsh.md update',
      ]),
    );
    for (const stamped of stampedVersions) {
      expect(stamped.version, `${stamped.file} is not stamped to ${version}`).toBe(version);
    }
  });

  it('rewrites only the version value and leaves the line shape intact', () => {
    const targets = [
      ...stampTargets('/base', '@scope/pkg'),
      ...dshInstallTargets('/repo', '@scope/pkg'),
    ];
    for (const target of targets) {
      const original = target.format('0.0.0');
      const restamped = original.replace(target.pattern, target.format('9.9.9'));
      expect(restamped).toBe(target.format('9.9.9'));
      expect(restamped).not.toBe(original);
    }
  });

  // Claude Code 的 mod 清单曾经漏在盖章表外：`searchfuse --version` 报 0.1.1
  // 而宿主里显示的仍是 0.1.0。这条钉住它必须在表内，且戳出来是合法 JSON。
  it('stamps the Claude Code plugin manifest too', () => {
    const names = stampTargets('/base', '@scope/pkg').map(({ name }) => name);
    expect(names).toContain('plugin.json');
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'claude', '.claude-plugin', 'plugin.json'), 'utf-8'),
    );
    expect(manifest.version).toBe(readPackageVersion());
  });
});

describe('launcher package and command names', () => {
  // 版本盖章只覆盖 PINNED / $Pinned 这两个常量，包名和命令名一直是手写的。
  // 项目从 modsearch 改名 searchfuse 时，两个启动器里的 @liustack/modsearch
  // 与 modsearch 就漏了：版本测试全绿，而 skill 一装好就会去拉一个不存在的
  // 旧包。这条测试钉住启动器的名字必须与 package.json 一致。
  const read = (file) => readFileSync(join(repoRoot, 'skills', skillName(), 'scripts', file), 'utf-8');

  it('run.sh 的 PKG 与 BIN 跟 package.json 一致', () => {
    const sh = read('run.sh');
    expect(sh.match(/^PKG="([^"]*)"$/m)?.[1]).toBe(readPackageName());
    expect(sh.match(/^BIN="([^"]*)"$/m)?.[1]).toBe(skillName());
  });

  it('run.ps1 的 $Package 与 $Bin 跟 package.json 一致', () => {
    const ps1 = read('run.ps1');
    expect(ps1.match(/^\$Package = '([^']*)'$/m)?.[1]).toBe(readPackageName());
    expect(ps1.match(/^\$Bin = '([^']*)'$/m)?.[1]).toBe(skillName());
  });
});
