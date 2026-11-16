import * as fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDoctorReport, MIN_NODE, runDoctor } from './doctor.ts';
import {
  BARE_ENV,
  cleanupTempDirs,
  envWithBinaries,
  IS_WINDOWS,
  tempConfigPath,
  withSignedInGrok,
  withTempHome,
} from './testing/helpers.ts';

/** The diagnosis for one role, by name. */
function role(report: ReturnType<typeof runDoctor>, name: string) {
  return report.roles.find((r) => r.role === name);
}

/** The diagnosis for one engine within a role. */
function engine(report: ReturnType<typeof runDoctor>, roleName: string, engineName: string) {
  return role(report, roleName)?.candidates.find((c) => c.engine === engineName);
}

describe('doctor: Node version', () => {
  afterEach(() => cleanupTempDirs());

  it('accepts the floor and anything newer', () => {
    const ok = runDoctor({ config: {}, env: BARE_ENV, nodeVersion: MIN_NODE });
    expect(ok.node.ok).toBe(true);
    expect(ok.node.fix).toBeUndefined();
  });

  it('flags an older Node with a fix', () => {
    const old = runDoctor({ config: {}, env: BARE_ENV, nodeVersion: '20.10.0' });
    expect(old.node.ok).toBe(false);
    expect(old.node.fix).toContain(MIN_NODE);
  });
});

describe('doctor: search engines', () => {
  afterEach(() => cleanupTempDirs());

  it('reports agy ready when its binary is on PATH, behind keyless firecrawl', () => {
    const report = runDoctor({ config: {}, env: envWithBinaries('agy') });
    const agy = engine(report, 'search', 'antigravity-cli');
    expect(agy?.ready).toBe(true);
    // Keyless firecrawl leads the default chain, so it resolves first.
    expect(role(report, 'search')?.resolved).toBe('firecrawl');
  });

  it('reports tavily ready from an env key and tags the source', () => {
    const report = runDoctor({
      config: {},
      env: { PATH: '/nonexistent', TAVILY_API_KEY: 'k' } as NodeJS.ProcessEnv,
    });
    const tavily = engine(report, 'search', 'tavily');
    expect(tavily?.ready).toBe(true);
    expect(tavily?.keySource).toBe('env');
  });

  it('reports the number of usable API keys after empty comma items are removed', () => {
    const report = runDoctor({
      config: {},
      env: { PATH: '/nonexistent', TAVILY_API_KEY: 'first, , second,,' } as NodeJS.ProcessEnv,
    });
    const tavily = engine(report, 'search', 'tavily');
    expect(tavily?.ready).toBe(true);
    expect(tavily?.reason).toContain('2 keys');
    expect(tavily?.reason).toContain('from env');
  });

  it('reports exa ready from an env key and tags the source', () => {
    const report = runDoctor({
      config: {},
      env: { PATH: '/nonexistent', EXA_API_KEY: 'k' } as NodeJS.ProcessEnv,
    });
    const exa = engine(report, 'search', 'exa');
    expect(exa?.ready).toBe(true);
    expect(exa?.keySource).toBe('env');
  });

  it('reports firecrawl ready from an env key for both search and fetch', () => {
    const report = runDoctor({
      config: {},
      env: { PATH: '/nonexistent', FIRECRAWL_API_KEY: 'k' } as NodeJS.ProcessEnv,
    });
    expect(engine(report, 'search', 'firecrawl')?.ready).toBe(true);
    expect(engine(report, 'fetch', 'firecrawl')?.ready).toBe(true);
  });

  it('gives a copyable fix for a missing key and missing agy', () => {
    const report = runDoctor({ config: {}, env: BARE_ENV });
    // Keyless firecrawl means search always resolves, even on a bare machine.
    expect(role(report, 'search')?.resolved).toBe('firecrawl');
    const fc = engine(report, 'search', 'firecrawl');
    expect(fc?.ready).toBe(true);
    expect(fc?.reason).toMatch(/keyless/i);
    expect(engine(report, 'search', 'tavily')?.fix).toContain('modsearch config set tavily.apiKey');
    expect(engine(report, 'search', 'exa')?.fix).toContain('modsearch config set exa.apiKey');
    expect(engine(report, 'search', 'antigravity-cli')?.fix).toContain('antigravity.google');
  });

  it('reports youcom ready on a bare machine with its keyless allowance', () => {
    const youcom = engine(runDoctor({ config: {}, env: BARE_ENV }), 'search', 'youcom');
    expect(youcom?.ready).toBe(true);
    expect(youcom?.reason).toMatch(/keyless.*100 searches\/day/);
  });

  it('keeps readiness separate from a user-disabled engine', () => {
    // Every keyless engine is switched off, so no engine can serve a search —
    // while firecrawl still reports ready, which is the distinction under
    // test: "can run here" and "may be used" are separate facts.
    const report = runDoctor({
      config: {
        engines: {
          firecrawl: { enabled: false },
          keenable: { enabled: false },
          youcom: { enabled: false },
          arxiv: { enabled: false },
        },
      },
      env: BARE_ENV,
    });
    const firecrawl = engine(report, 'search', 'firecrawl');
    expect(firecrawl?.ready).toBe(true);
    expect(firecrawl?.enabled).toBe(false);
    expect(role(report, 'search')?.resolved).toBeNull();
    expect(formatDoctorReport(report)).toMatch(/firecrawl.*disabled/i);
  });
});

describe('doctor: fetch and X', () => {
  afterEach(() => cleanupTempDirs());

  it('resolves fetch to keyless Firecrawl by default, with local as the floor', () => {
    const report = runDoctor({ config: {}, env: BARE_ENV });
    const firecrawl = engine(report, 'fetch', 'firecrawl');
    expect(firecrawl?.ready).toBe(true);
    expect(firecrawl?.reason).toMatch(/keyless/i);
    expect(engine(report, 'fetch', 'local')?.ready).toBe(true);
    expect(role(report, 'fetch')?.resolved).toBe('firecrawl');
  });

  it('excludes Firecrawl from fetch after an explicit keylessFetch opt-out', () => {
    const report = runDoctor({
      config: { engines: { firecrawl: { keylessFetch: false } } },
      env: BARE_ENV,
    });
    const firecrawl = engine(report, 'fetch', 'firecrawl');
    expect(firecrawl?.ready).toBe(false);
    expect(firecrawl?.reason).toMatch(/keylessFetch false/i);
    expect(role(report, 'fetch')?.resolved).toBe('local');
  });

  it('keeps keyed Firecrawl fetch ready even when keylessFetch is false', () => {
    const report = runDoctor({
      config: { engines: { firecrawl: { keylessFetch: false, apiKey: 'fc-x' } } },
      env: BARE_ENV,
    });
    expect(engine(report, 'fetch', 'firecrawl')?.ready).toBe(true);
    expect(role(report, 'fetch')?.resolved).toBe('firecrawl');
  });

  it('treats choosing Firecrawl as consent for its keyless fetch path', () => {
    const report = runDoctor({ config: { engine: 'firecrawl' }, env: BARE_ENV });
    expect(engine(report, 'fetch', 'firecrawl')?.ready).toBe(true);
    expect(role(report, 'fetch')?.resolved).toBe('firecrawl');
  });

  it("matches Firecrawl consent with the router's case-insensitive engine lookup", () => {
    const report = runDoctor({ config: { engine: 'Firecrawl' }, env: BARE_ENV });
    expect(engine(report, 'fetch', 'firecrawl')?.ready).toBe(true);
    expect(role(report, 'fetch')?.resolved).toBe('firecrawl');
  });

  it('reports grok not ready when the login file is missing', () => {
    const { restore } = withTempHome();
    try {
      const report = runDoctor({ config: {}, env: envWithBinaries('grok') });
      const grok = engine(report, 'social', 'grok-cli');
      expect(grok?.ready).toBe(false);
      expect(grok?.reason).toContain('login file');
      expect(grok?.reason).toContain('missing');
    } finally {
      restore();
    }
  });

  it('reports grok ready when signed in with the binary present', () => {
    const { env, restore } = withSignedInGrok();
    try {
      const report = runDoctor({ config: {}, env });
      expect(engine(report, 'social', 'grok-cli')?.ready).toBe(true);
      expect(role(report, 'social')?.resolved).toBe('grok-cli');
    } finally {
      restore();
    }
  });
});

describe('doctor: config layer', () => {
  afterEach(() => cleanupTempDirs());

  it('reports the configured engine and its origin', () => {
    const report = runDoctor({ config: { engine: 'tavily' }, env: BARE_ENV });
    expect(report.engineChoice.value).toBe('tavily');
    expect(report.engineChoice.source).toBe('file');
  });

  it('marks an unknown configured engine as a problem', () => {
    const report = runDoctor({ config: { engine: 'bing' }, env: BARE_ENV });
    expect(report.engineChoice.problem).toContain('not a known engine');
  });

  it('reports automatic selection when nothing is configured', () => {
    const report = runDoctor({ config: {}, env: BARE_ENV });
    expect(report.engineChoice.value).toBeNull();
    expect(report.engineChoice.source).toBe('default');
  });

  it('reports the top-level allowPrivateNetwork when set in the file', () => {
    const on = runDoctor({ config: { allowPrivateNetwork: true }, env: BARE_ENV });
    expect(on.allowPrivateNetwork.enabled).toBe(true);
    expect(on.allowPrivateNetwork.source).toBe('file');

    const off = runDoctor({ config: {}, env: BARE_ENV });
    expect(off.allowPrivateNetwork.enabled).toBe(false);
    expect(off.allowPrivateNetwork.source).toBe('default');
  });
});

describe('doctor: config file', () => {
  afterEach(() => cleanupTempDirs());

  it('reports a missing file as running on defaults', () => {
    const report = runDoctor({ env: BARE_ENV, configPath: tempConfigPath() });
    expect(report.configFile.exists).toBe(false);
  });

  it('reports an existing file with its permission mode', () => {
    const p = tempConfigPath();
    fs.writeFileSync(p, JSON.stringify({ engine: 'tavily' }), { mode: 0o600 });
    if (!IS_WINDOWS) {
      fs.chmodSync(p, 0o600);
    }
    const report = runDoctor({ env: BARE_ENV, configPath: p });
    expect(report.configFile.exists).toBe(true);
    // POSIX permission bits only: Windows reports an ACL-derived mode, not 600.
    if (!IS_WINDOWS) {
      expect(report.configFile.mode).toBe('600');
    }
    expect(report.engineChoice.value).toBe('tavily');
  });

  it.skipIf(IS_WINDOWS)('judges 0600 permissions as ok', () => {
    const p = tempConfigPath();
    fs.writeFileSync(p, JSON.stringify({ engine: 'tavily' }), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    const report = runDoctor({ env: BARE_ENV, configPath: p });
    expect(report.configFile.permissionsOk).toBe(true);
    expect(report.configFile.note).toBeUndefined();
  });

  it.skipIf(IS_WINDOWS)('flags a group- or world-readable config file with the fix', () => {
    const p = tempConfigPath();
    fs.writeFileSync(p, JSON.stringify({ engine: 'tavily' }), { mode: 0o644 });
    fs.chmodSync(p, 0o644);
    const report = runDoctor({ env: BARE_ENV, configPath: p });
    expect(report.configFile.permissionsOk).toBe(false);
    expect(report.configFile.note).toContain('chmod 600');
    expect(formatDoctorReport(report)).toContain('chmod 600');
  });

  it('treats a missing file as fine: defaults leak nothing', () => {
    const report = runDoctor({ env: BARE_ENV, configPath: tempConfigPath() });
    expect(report.configFile.permissionsOk).toBe(true);
  });

  it('names a broken config file instead of aborting the diagnosis', () => {
    const p = tempConfigPath();
    fs.writeFileSync(p, '{broken');
    const report = runDoctor({ env: BARE_ENV, configPath: p });
    expect(report.configFile.problem).toBeTruthy();
    // The rest of the report still populates.
    expect(report.roles).toHaveLength(3);
  });

  it.skipIf(IS_WINDOWS)('still judges permissions when the file does not parse', () => {
    // A broken 0644 file still holds its keys: the chmod verdict must not
    // depend on the JSON parsing.
    const p = tempConfigPath();
    fs.writeFileSync(p, '{broken', { mode: 0o644 });
    fs.chmodSync(p, 0o644);
    const report = runDoctor({ env: BARE_ENV, configPath: p });
    expect(report.configFile.problem).toBeTruthy();
    expect(report.configFile.permissionsOk).toBe(false);
    expect(report.configFile.note).toContain('chmod 600');
  });
});

describe('doctor: rendering', () => {
  afterEach(() => cleanupTempDirs());

  it('renders a readable text report covering every section', () => {
    const text = formatDoctorReport(
      runDoctor({ config: {}, env: BARE_ENV, statePath: tempConfigPath() }),
    );
    expect(text).toContain('Node');
    expect(text).toContain('search (search the web)');
    expect(text).toContain('fetch (fetch a page)');
    expect(text).toContain('social (search X)');
    expect(text).toContain('allowPrivateNetwork');
    expect(text).toContain('Cooldown');
  });
});

describe('doctor: cooldown', () => {
  afterEach(() => cleanupTempDirs());

  const now = new Date('2026-08-06T00:00:00.000Z');

  it('reports the switch off and consults no state when cooldown is disabled', () => {
    const report = runDoctor({
      config: { cooldown: 'off' },
      env: BARE_ENV,
      statePath: tempConfigPath(),
      now,
    });
    expect(report.cooldown.enabled).toBe(false);
    expect(report.cooldown.engines).toEqual([]);
    expect(formatDoctorReport(report)).toContain('switch: off');
  });

  it('lists a cooling engine with its remaining time', () => {
    const p = tempConfigPath();
    const until = new Date(now.getTime() + 90 * 60_000).toISOString();
    fs.writeFileSync(
      p,
      JSON.stringify({
        engineCooldowns: {
          exa: { until, reason: 'out of credits', observedAt: now.toISOString() },
        },
      }),
    );
    const report = runDoctor({ config: {}, env: BARE_ENV, statePath: p, now });
    expect(report.cooldown.enabled).toBe(true);
    expect(report.cooldown.engines).toHaveLength(1);
    expect(report.cooldown.engines[0]).toMatchObject({ engine: 'exa', remaining: '1h 30m' });
    expect(formatDoctorReport(report)).toContain('cooling, 1h 30m left');
  });

  it('reports a per-key cooldown with its engine and human key number', () => {
    const p = tempConfigPath();
    const until = new Date(now.getTime() + 45 * 60_000).toISOString();
    fs.writeFileSync(
      p,
      JSON.stringify({
        engineCooldowns: {
          'exa::key:1': { until, reason: 'out of credits', observedAt: now.toISOString() },
        },
      }),
    );
    const report = runDoctor({ config: {}, env: BARE_ENV, statePath: p, now });
    expect(report.cooldown.engines[0]).toMatchObject({ engine: 'exa', keyIndex: 1 });
    expect(formatDoctorReport(report)).toContain('exa key 2');
  });

  it('omits an already-expired cooldown from the active list', () => {
    const p = tempConfigPath();
    const until = new Date(now.getTime() - 60_000).toISOString();
    fs.writeFileSync(
      p,
      JSON.stringify({
        engineCooldowns: { exa: { until, reason: 'x', observedAt: now.toISOString() } },
      }),
    );
    const report = runDoctor({ config: {}, env: BARE_ENV, statePath: p, now });
    expect(report.cooldown.engines).toEqual([]);
  });
});

describe('doctor: aggregate and MCP sections', () => {
  afterEach(() => cleanupTempDirs());

  it('names why each engine does or does not join the fusion', () => {
    // 四种成因在用户眼里都是「它没被用上」，而修法完全不同：一个要改
    // enabled，一个要改 expose.aggregate，一个要装东西。只列参与者回答不了
    // 这个「为什么」。
    const report = runDoctor({
      config: {
        engines: {
          tavily: { enabled: false },
          exa: { expose: { aggregate: false } },
        },
      },
      env: BARE_ENV,
    });
    const byEngine = (name: string) =>
      report.aggregate.participants.find((p) => p.engine === name)?.reason;
    expect(byEngine('tavily')).toBe('关闭（enabled: false）');
    expect(byEngine('exa')).toBe('不参与融合（expose.aggregate: false）');
    // arxiv 在这台机器上不需要任何东西，所以它是「参与融合」的那一档。
    // 用 searxng 代替会在空环境里落到「本机不可用」，那测的是别的东西。
    expect(byEngine('arxiv')).toBe('参与融合');
    expect(report.aggregate.mode).toBe('rrf');
    expect(formatDoctorReport(report)).toContain('Aggregate');
  });

  it('reports configured MCP servers without claiming a live connection', () => {
    const report = runDoctor({
      config: {
        mcp: {
          grep: { transport: 'streamable-http', url: 'https://mcp.grep.app' },
          'bad.key': { url: 'https://x.example' },
          nokey: { url: 42 },
        },
      },
      env: BARE_ENV,
    });
    expect(report.mcp.servers).toHaveLength(3);
    expect(report.mcp.servers.find((s) => s.key === 'grep')?.url).toBe('https://mcp.grep.app');
    // 键名会成为工具名的一部分，所以不合法的键等于一个永远注册不上的工具。
    expect(report.mcp.servers.find((s) => s.key === 'bad.key')?.problem).toContain(
      'A-Za-z0-9_-',
    );
    expect(report.mcp.servers.find((s) => s.key === 'nokey')?.problem).toBe('缺少 url');
    const text = formatDoctorReport(report);
    expect(text).toContain('MCP');
    // 报告是静态的，不能让人误以为它验证过连接。
    expect(text).toContain('live connection results appear in the plugin log');
  });

  it('says so plainly when no MCP server is configured', () => {
    const report = runDoctor({ config: {}, env: BARE_ENV });
    expect(report.mcp.servers).toEqual([]);
    expect(formatDoctorReport(report)).toContain('no servers configured');
  });
});
