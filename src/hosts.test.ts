import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installClaudeSkill,
  installOmpExtension,
  ompStatus,
  removeOmpExtension,
  setYamlScalar,
  reportClaudeMcp,
  syncClaudeSettings,
  syncOmp,
  syncOmpMcp,
} from './hosts.ts';

/** 造一个临时文件，用完删掉。 */
function tempFile(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchfuse-hosts-'));
  created.push(dir);
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf-8');
  return file;
}

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('setYamlScalar', () => {
  it('给已存在的段插入新键，保留原内容与缩进', () => {
    const src = ['# 我的配置', 'modelRoles:', '  smol: a', '  default: b', 'theme:', '  dark: x'].join('\n');
    const out = setYamlScalar(src, 'modelRoles', 'web', 'web/searxng');
    expect(out).toContain('  web: web/searxng');
    expect(out).toContain('# 我的配置');
    expect(out).toContain('  dark: x');
    // 插在 modelRoles 段内，不是文件末尾。
    const lines = out.split('\n');
    const idx = lines.indexOf('  web: web/searxng');
    expect(lines[idx - 1]).toBe('  default: b');
    expect(lines[idx + 1]).toBe('theme:');
  });

  it('段不存在时整段追加', () => {
    const out = setYamlScalar('theme:\n  dark: x', 'searxng', 'endpoint', 'http://127.0.0.1:7799');
    expect(out).toContain('searxng:');
    expect(out).toContain('  endpoint: http://127.0.0.1:7799');
    // 原有段不动。
    expect(out).toContain('  dark: x');
  });

  it('键已存在时原地替换，不重复插入', () => {
    const src = 'modelRoles:\n  web: web/public\n  smol: a';
    const out = setYamlScalar(src, 'modelRoles', 'web', 'web/searxng');
    expect(out.match(/web:/g)?.length).toBe(1);
    expect(out).toContain('  web: web/searxng');
    expect(out).not.toContain('web/public');
  });

  it('值为 undefined 时删掉那一行', () => {
    const src = 'searxng:\n  endpoint: http://127.0.0.1:7799\n  token: abc\ntheme:\n  dark: x';
    const out = setYamlScalar(src, 'searxng', 'token', undefined);
    expect(out).not.toContain('token:');
    expect(out).toContain('  endpoint: http://127.0.0.1:7799');
    expect(out).toContain('  dark: x');
  });

  it('段内注释不会被当成子键的结束标志', () => {
    const src = 'modelRoles:\n  smol: a\n  # 这一行是注释\n  vision: b\nretry:\n  maxRetries: 3';
    const out = setYamlScalar(src, 'modelRoles', 'web', 'web/searxng');
    expect(out).toContain('  # 这一行是注释');
    expect(out).toContain('  vision: b');
    expect(out).toContain('  web: web/searxng');
    expect(out).toContain('retry:');
  });
});

describe('syncOmp', () => {
  it('enable 时写入三个键并清掉 Basic 凭据', () => {
    const file = tempFile(
      'config.yml',
      ['searxng:', '  basicUsername: me', '  basicPassword: pw', 'theme:', '  dark: x'].join('\n'),
    );
    syncOmp({ endpoint: 'http://127.0.0.1:7799', token: 'tok', webRole: 'web/searxng' }, file);
    const out = fs.readFileSync(file, 'utf-8');
    expect(out).toContain('endpoint: http://127.0.0.1:7799');
    expect(out).toContain('token: tok');
    expect(out).not.toContain('basicUsername:');
    expect(out).not.toContain('basicPassword:');
    expect(out).toContain('web: web/searxng');
    // 无关内容保留。
    expect(out).toContain('  dark: x');
  });

  it('disable 时清掉接入键并把 web 写回公网', () => {
    const file = tempFile(
      'config.yml',
      [
        'searxng:',
        '  endpoint: http://127.0.0.1:7799',
        '  token: tok',
        'modelRoles:',
        '  web: web/searxng',
        '  smol: a',
      ].join('\n'),
    );
    syncOmp(undefined, file);
    const out = fs.readFileSync(file, 'utf-8');
    expect(out).not.toContain('endpoint:');
    expect(out).not.toContain('token:');
    expect(out).toContain('  web: web/public');
    expect(out).toContain('  smol: a');
  });

  it('未改动时不写文件也不留备份', () => {
    const file = tempFile('config.yml', '');
    const first = syncOmp(undefined, file);
    // 空文件 disable：不产生任何 searxng 段，只是追加了 modelRoles.web。
    expect(first.changed).toBe(true);
    const second = syncOmp(undefined, file);
    expect(second.changed).toBe(false);
  });

  it('改动前留下带时间戳的备份', () => {
    const file = tempFile('config.yml', 'searxng:\n  endpoint: http://old\ntheme:\n  dark: x');
    const result = syncOmp({ endpoint: 'http://127.0.0.1:7799', token: 't', webRole: 'web/searxng' }, file);
    expect(result.backup).toBeDefined();
    const backup = JSON.parse(JSON.stringify(result.backup));
    expect(fs.readFileSync(backup, 'utf-8')).toContain('http://old');
  });
});

describe('syncClaudeSettings', () => {
  it('只改 searchfuseHosts 这一个键，其余原样保留', () => {
    const file = tempFile(
      'settings.json',
      JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { x: 1 }, searchfuseHosts: { omp: { enabled: true } } }, null, 2),
    );
    syncClaudeSettings(true, { runtimePath: "/tmp/rt.json", kernelPath: "/tmp/k.js" }, file);
    const out = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(out.searchfuseHosts.claudeCode.enabled).toBe(true);
    // 用户的其他配置一个都没丢。
    expect(out.permissions).toEqual({ allow: ['Bash'] });
    expect(out.hooks).toEqual({ x: 1 });
    expect(out.searchfuseHosts.omp).toEqual({ enabled: true });
  });

  it('已经是目标值时不写也不留备份', () => {
    const file = tempFile('settings.json', JSON.stringify({ searchfuseHosts: { claudeCode: { enabled: true } } }, null, 2));
    const result = syncClaudeSettings(true, { runtimePath: "/tmp/rt.json", kernelPath: "/tmp/k.js" }, file);
    expect(result.changed).toBe(false);
    expect(result.backup).toBeUndefined();
  });

  it('拒绝覆盖无法解析的 settings 文件', () => {
    const file = tempFile('settings.json', '{ this is not json');
    expect(() => syncClaudeSettings(true, { runtimePath: "/tmp/rt.json", kernelPath: "/tmp/k.js" }, file)).toThrow('refusing to overwrite');
  });
});

describe('omp 扩展的装卸', () => {
  /**
   * 把家目录指到临时目录：两个函数都按 `os.homedir()` 拼路径，
   * Windows 上读 `USERPROFILE`，所以改这一个就够了。
   */
  function withTempHome(): () => void {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'searchfuse-home-'));
    created.push(home);
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = home;
    return () => {
      if (previous === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previous;
      }
    };
  }

  it('装上之后能被卸载掉，返回 true', () => {
    const restore = withTempHome();
    try {
      const target = installOmpExtension('const K = "__SEARCHFUSE_KERNEL_PATH__";', 'C:/x/kernel.js');
      expect(fs.existsSync(target)).toBe(true);
      expect(removeOmpExtension()).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      restore();
    }
  });

  it('本来就没装时返回 false，不抛异常', () => {
    const restore = withTempHome();
    try {
      // 关键：关闭一个「没装过」的宿主不该让 hosts sync 崩掉。
      expect(removeOmpExtension()).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('Claude Code mod 的常驻安装', () => {
  /**
   * 建一个假的 `claude/` 源目录。只放两个文件，够验证「复制哪些、
   * 缺了怎么办」，不依赖仓库里的真实内容。
   */
  function fakeSource(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchfuse-src-'));
    created.push(dir);
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# skill\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"modules":["./register.ts"]}\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'hooks', 'register.ts'), 'export function register() {}\n', 'utf-8');
    return dir;
  }

  function fakeTarget(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchfuse-dst-'));
    created.push(dir);
    return dir;
  }

  it('把源目录里的 mod 文件复制到目标目录', () => {
    const source = fakeSource();
    const target = fakeTarget();
    const result = installClaudeSkill(source, target);
    expect(result.changed).toBe(true);
    expect(result.installed).toContain(path.join('hooks', 'register.ts'));
    const copied = fs.readFileSync(path.join(target, 'hooks', 'register.ts'), 'utf-8');
    expect(copied).toBe('export function register() {}\n');
  });

  it('第二次同步 content 相同，返回 changed=false（幂等）', () => {
    const source = fakeSource();
    const target = fakeTarget();
    installClaudeSkill(source, target);
    const second = installClaudeSkill(source, target);
    expect(second.changed).toBe(false);
    expect(second.installed).toEqual([]);
  });

  it('源文件缺失时跳过那一个，不抛异常', () => {
    // 只留 SKILL.md，其余全删：发布包里 claude/ 未必齐全，
    // 缺一个文件不该让整条 sync 崩掉。
    const source = fakeSource();
    fs.rmSync(path.join(source, 'hooks'), { recursive: true, force: true });
    const target = fakeTarget();
    const result = installClaudeSkill(source, target);
    expect(result.installed).toEqual(['SKILL.md']);
    expect(fs.existsSync(path.join(target, 'hooks', 'register.ts'))).toBe(false);
  });
});

describe('syncOmpMcp', () => {
  it('只补 omp 里缺的 server，不覆盖已有的', () => {
    const file = tempFile(
      'mcp.json',
      JSON.stringify({
        mcpServers: { context7: { type: 'http', url: 'https://user-set-url' } },
        disabledServers: ['jshook'],
      }),
    );
    const result = syncOmpMcp({ mcp: { context7: { transport: 'streamable-http', url: 'https://ours' }, grep: { transport: 'streamable-http', url: 'https://mcp.grep.app' } } }, file);

    expect(result.added).toEqual(['grep']);
    const out = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // 用户自己的 context7 原样保留，没被我们的值覆盖。
    expect(out.mcpServers.context7.url).toBe('https://user-set-url');
    expect(out.mcpServers.grep).toEqual({ type: 'http', url: 'https://mcp.grep.app' });
    // disabledServers 不动。
    expect(out.disabledServers).toEqual(['jshook']);
  });

  it('没有要补的就不写文件', () => {
    const file = tempFile('mcp.json', JSON.stringify({ mcpServers: { grep: { type: 'http', url: 'https://x' } } }));
    const result = syncOmpMcp({ mcp: { grep: { transport: 'streamable-http', url: 'https://mcp.grep.app' } } }, file);
    expect(result.added).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it('把 stdio 与 http 两种 transport 都翻译对', () => {
    const file = tempFile('mcp.json', '{}');
    syncOmpMcp(
      {
        mcp: {
          a: { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
          b: { transport: 'streamable-http', url: 'https://b.example' },
        },
      },
      file,
    );
    const out = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(out.mcpServers.a).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
    expect(out.mcpServers.b).toEqual({ type: 'http', url: 'https://b.example' });
  });
});

describe('reportClaudeMcp', () => {
  it('列出 Claude Code 已装的 server，只读不写', () => {
    const file = tempFile('.claude.json', JSON.stringify({ mcpServers: { exa: {}, context7: {} } }));
    const before = fs.readFileSync(file, 'utf-8');
    const names = reportClaudeMcp(file);
    expect(names).toEqual(['exa', 'context7']);
    // 只读：文件没被改。
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('没有 mcpServers 时返回空数组', () => {
    const file = tempFile('.claude.json', '{}');
    expect(reportClaudeMcp(file)).toEqual([]);
  });
});

describe('ompStatus', () => {
  // 这条守着一个真实踩过的坑：安装时模板里的占位符会被替换成真实路径，
  // 所以「已安装文件」永远不等于「模板原文」。拿模板原文去比，就等于把
  // 每一次正确的安装都报成陈旧——卡片会永久显示「需要更新」，
  // 而这个提示永远消不掉。
  it('模板占位符被渲染后不再判陈旧', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchfuse-omp-'));
    created.push(dir);
    const kernelPath = 'E:\\\\newCC\\\\aaa-dsh-go\\\\searchfuse\\\\dist\\\\kernel.js';
    const template = "const KERNEL_PATH = '__SEARCHFUSE_KERNEL_PATH__';\\n";
    // 用与生产代码相同的渲染方式写出「已安装」的样子，确保比对口径一致。
    const escaped = JSON.stringify(kernelPath).slice(1, -1);
    fs.writeFileSync(
      path.join(dir, 'searchfuse.ts'),
      template.replaceAll('__SEARCHFUSE_KERNEL_PATH__', escaped),
      'utf-8',
    );
    const status = ompStatus(template, dir, kernelPath);
    expect(status.installed).toBe(true);
    expect(status.stale).toEqual([]);
  });

  it('内容与当前模板确实不同时仍然报陈旧', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchfuse-omp-'));
    created.push(dir);
    fs.writeFileSync(path.join(dir, 'searchfuse.ts'), 'old implementation\\n', 'utf-8');
    const status = ompStatus("const x = '__SEARCHFUSE_KERNEL_PATH__';\\n", dir, '/tmp/kernel.js');
    expect(status.stale).toEqual(['searchfuse.ts']);
  });

  it('文件不存在时报缺失而不是陈旧', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchfuse-omp-'));
    created.push(dir);
    const status = ompStatus('template', dir, '/tmp/kernel.js');
    expect(status.installed).toBe(false);
    expect(status.missing).toEqual(['searchfuse.ts']);
    expect(status.stale).toEqual([]);
  });
});
