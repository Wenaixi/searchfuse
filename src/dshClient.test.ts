import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// The browser half (dsh/client.js) is a hand-written script in the
// __ModuleLoader__ bundle protocol: no module exports, browser globals only.
// It is evaluated here with those globals handed in as parameters, which pins
// the contracts no host-route test can see: the card never mounts where its
// route is off, the key field is never a plain visible input, and the copy
// follows dsh's own interface language.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');
const PACKAGE_NAME: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
).name;

interface CardDraft extends Record<string, unknown> {
  engine: string;
  apiKey: string;
  baseURL: string;
  model: string;
  enabled: Record<string, boolean>;
}

interface Card {
  nextDraft: (summary: unknown, engine: string) => CardDraft;
  selectEngine: (summary: unknown, draft: CardDraft, engine: string) => CardDraft;
  toggleEngine: (draft: CardDraft, engine: string, enabled: boolean) => CardDraft;
  savePayload: (summary: unknown, draft: unknown) => Record<string, unknown>;
  isDirty: (summary: unknown, draft: unknown) => boolean;
  secretFieldProps: () => Record<string, unknown>;
  ConfigCard: (react: unknown, ui: unknown, localeRef?: unknown) => () => unknown;
}

interface Definition {
  id: string;
  factory: (require: (id: string) => unknown) => {
    apply: (ctx: unknown) => void;
    __card: Card;
  };
}

/** Evaluate client.js with stubbed browser globals and hand back its exports. */
function evaluate(globals: {
  lang?: string;
  css?: unknown;
  fetch?: (url: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
  getComputedStyle?: (elt: unknown) => { color?: string };
  matchMedia?: (query: string) => { matches: boolean };
}): Definition {
  let loaded: Definition | undefined;
  const windowStub = {
    __ModuleLoader__: {
      load: (definition: Definition) => {
        loaded = definition;
      },
    },
  };
  const documentStub = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    documentElement: { lang: globals.lang ?? 'en' },
  };
  const fetchStub =
    globals.fetch ?? (() => Promise.resolve({ ok: true, status: 200, json: () => ({}) }));
  // Extra parameters shadow Node globals as undefined unless a test injects
  // them, so the card's theme probe is a no-op in every existing path.
  new Function(
    'window',
    'document',
    'CSS',
    'fetch',
    'navigator',
    'getComputedStyle',
    'matchMedia',
    SOURCE,
  )(
    windowStub,
    documentStub,
    globals.css,
    fetchStub,
    { language: globals.lang ?? 'en' },
    globals.getComputedStyle,
    globals.matchMedia,
  );
  if (!loaded) {
    throw new Error('client.js never called __ModuleLoader__.load');
  }
  return loaded;
}

/** A drained microtask queue: the card's fetch chains are promise-only. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const SUMMARY = {
  engine: 'tavily',
  engines: {
    'antigravity-cli': {
      baseURL: '',
      model: 'gemini-3-pro',
      hasKey: false,
      keySource: null,
      enabled: true,
    },
    tavily: {
      baseURL: 'https://a.example',
      model: '',
      hasKey: true,
      keySource: 'file',
      enabled: true,
    },
    exa: { baseURL: '', model: '', hasKey: false, keySource: null, enabled: false },
    firecrawl: { baseURL: '', model: '', hasKey: false, keySource: null, enabled: true },
    keenable: { baseURL: '', model: '', hasKey: false, keySource: null, enabled: true },
    youcom: { baseURL: '', model: '', hasKey: false, keySource: null, enabled: true },
    'grok-cli': { baseURL: '', model: '', hasKey: false, keySource: null, enabled: true },
    local: { baseURL: '', model: '', hasKey: false, keySource: null, enabled: true },
  },
  keyed: ['tavily', 'exa', 'firecrawl', 'keenable'],
  models: ['antigravity-cli'],
};

describe('the settings card mounts only where its route answers', () => {
  function loadCard(configStatus: number) {
    const slotSpecs: Array<Record<string, unknown>> = [];
    const injected: string[][] = [];
    const definition = evaluate({
      fetch: (url: string) =>
        Promise.resolve({
          ok: configStatus >= 200 && configStatus < 300,
          status: url.startsWith('/searchfuse/config') ? configStatus : 200,
          json: () => Promise.resolve({}),
        }),
    });
    const exports = definition.factory(() => ({
      createElement: () => null,
      useState: (initial: unknown) => [initial, () => {}],
      useEffect: () => {},
      useCallback: (fn: unknown) => fn,
    }));
    exports.apply({
      effect: () => {},
      inject: (deps: string[], fn: (scope: unknown) => void) => {
        injected.push(deps);
        if (deps.includes('slots')) {
          fn({
            slots: {
              inject: (_name: string, gen: () => Generator) => {
                for (const _entry of gen()) {
                  // consuming the generator performs the registration
                }
              },
              register: (spec: Record<string, unknown>) => {
                slotSpecs.push(spec);
                return spec;
              },
            },
          });
        }
      },
    });
    return { slotSpecs, injected, card: exports.__card, id: definition.id };
  }

  it('does not mount where the route is off, instead of rendering an error', async () => {
    // settingsCard: false removes the host route. A card that mounted anyway
    // would show a failure where the user asked for nothing.
    const off = loadCard(404);
    await settle();
    expect(off.slotSpecs).toEqual([]);
  });

  it('registers under the key rc.7 dispatches by and the id rc.6 lists by', async () => {
    // rc.7 made settings.plugin.item a keyed slot: a card renders only when
    // its key matches a settings namespace the host serves, and the host half
    // serves 'modsearch'. rc.6's list slot needed options.id instead, and one
    // client.js serves both, so both ride along.
    const on = loadCard(200);
    await settle();
    const spec = on.slotSpecs.find((entry) => entry.name === 'settings.plugin.item');
    expect(spec?.key).toBe('modsearch');
    expect(spec?.id).toBe('modsearch');
  });

  it('registers on the Plugins page under the package name', async () => {
    // dsh 0.1.6-alpha.2 retired settings.plugin.item: a bundle's
    // configuration lives on its own Plugins page, dispatched by the npm
    // package name. A card left only in the old slot never renders there,
    // and neither does one keyed by a name the package no longer has.
    const on = loadCard(200);
    await settle();
    const spec = on.slotSpecs.find((entry) => entry.name === 'plugins.bundle.config');
    expect(spec?.key).toBe(PACKAGE_NAME);
    // The module id is the entry name dsh-client-modules pairs with the row.
    expect(on.id).toBe(PACKAGE_NAME);
  });

  it('asks for the locale service on its own inject, not beside slots', async () => {
    // ctx.inject waits for every service it names. Naming locale beside slots
    // would mean no card at all on a host that ships no locale service, which
    // is the opposite of an optional dependency.
    const on = loadCard(200);
    await settle();
    expect(on.injected).toContainEqual(['locale']);
    expect(on.injected).toContainEqual(['slots']);
    expect(on.slotSpecs.map((entry) => entry.name).sort()).toEqual([
      'plugins.bundle.config',
      'settings.plugin.item',
    ]);
  });
});

describe('on the Plugins page the card is a section of the page, not a block of its own', () => {
  // The Plugins page draws the bundle's title and description itself and
  // hands the entry `view: 'page'`. A collapsed card under that title would
  // make the user open the same thing twice.

  // `effects: false` renders as React does after the mount effect already ran
  // and its dependencies stayed put, which is where a failed load leaves it.
  function renderAs(props: Record<string, unknown>, states: unknown[], effects = true) {
    const urls: string[] = [];
    const definition = evaluate({
      lang: 'en',
      fetch: (url: string) => {
        urls.push(url);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SUMMARY) });
      },
    });
    const nodes: Node[] = [];
    let index = 0;
    const react = {
      createElement: (type: unknown, nodeProps: Record<string, unknown>, ...kids: unknown[]) => {
        const node = { type, props: nodeProps ?? {}, kids };
        nodes.push(node);
        return node;
      },
      useState: () => [states[index++], () => {}],
      useEffect: (fn: () => void) => {
        if (effects) {
          fn();
        }
      },
      useCallback: (fn: unknown) => fn,
    };
    const Input = function Input() {
      return null;
    };
    const Card = definition.factory(() => ({})).__card.ConfigCard(react, { Input }) as (
      props?: Record<string, unknown>,
    ) => unknown;
    return { out: Card(props), nodes, urls };
  }

  it('renders the form open, with no collapse toggle of its own', () => {
    const draft = evaluate({})
      .factory(() => ({}))
      .__card.nextDraft(SUMMARY, 'tavily');
    const { nodes } = renderAs({ view: 'page' }, [false, SUMMARY, draft, '']);
    // 只看「卡片级」折叠：页面视图的标题由插件页给出，再给一个折叠开关
    // 等于让人把同一次点击做两遍。高级字段自己的渐进披露不在此列，
    // 用 data-disclosure 把它们区分开。
    // 只看卡片级折叠。高级字段的渐进披露（data-disclosure）与引擎行的
    // 就地编辑（data-engine-row）都属于表单内部，不是「把整张卡片折起来」。
    expect(
      nodes.some(
        (node) =>
          'aria-expanded' in node.props &&
          !node.props['data-disclosure'] &&
          !node.props['data-engine-row'],
      ),
    ).toBe(false);
    // 全部展开：不再有渐进披露的折叠条，所有字段直接可见。
    expect(nodes.some((node) => node.props['data-disclosure'])).toBe(false);
    expect(nodes.filter((node) => node.props.className === 'sf-field').length).toBeGreaterThan(3);
    expect(nodes.some((node) => node.type === 'select')).toBe(true);
    expect(nodes.some((node) => node.type === 'h4' && node.kids.includes('Engine settings'))).toBe(
      true,
    );
  });

  it('loads as soon as the page shows it, without waiting for a click', () => {
    const { urls } = renderAs({ view: 'page' }, [false, null, null, '']);
    expect(urls).toEqual(['/searchfuse/config?doctor=1']);
  });

  it('answers a summary view with its one-liner and loads nothing', () => {
    const { out, urls } = renderAs({ view: 'summary' }, [false, null, null, '']);
    expect(out).toBe('Search engine provider configuration.');
    expect(urls).toEqual([]);
  });

  it('offers a retry after a failed load, since the page never collapses to retry', () => {
    // The collapsible card retried on the next expand. On the page the form
    // is always open, so the load effect never fires again on its own.
    const failed = renderAs({ view: 'page' }, [false, null, null, 'load failed'], false);
    expect(failed.urls).toEqual([]);
    const retry = failed.nodes.find(
      (node) => node.type === 'button' && node.kids.includes('Retry'),
    );
    if (!retry) {
      throw new Error('no retry button');
    }
    (retry.props.onClick as () => void)();
    expect(failed.urls).toEqual(['/searchfuse/config?doctor=1']);
  });

  it('shows no retry while the first load is still on its way', () => {
    const { nodes } = renderAs({ view: 'page' }, [false, null, null, '']);
    expect(nodes.some((node) => node.type === 'button' && node.kids.includes('Retry'))).toBe(false);
  });

  it('keeps the collapsible card where the host passes no view', () => {
    const { nodes, urls } = renderAs({}, [false, null, null, '']);
    expect(nodes.some((node) => node.props['aria-expanded'] === false)).toBe(true);
    expect(urls).toEqual([]);
  });
});

describe('a save carries only what the save is about', () => {
  const card = () => evaluate({}).factory(() => ({})).__card;

  it('sends the pin only when the select moved, and the fields only when edited', () => {
    const { nextDraft, savePayload } = card();
    const untouched = nextDraft(SUMMARY, 'tavily');
    expect(savePayload(SUMMARY, untouched)).toEqual({});

    const edited = savePayload(SUMMARY, { ...untouched, apiKey: 'tvly-new' });
    expect(edited.target).toBe('tavily');
    expect(edited.apiKey).toBe('tvly-new');
    expect(edited.engine).toBeUndefined();

    const repinned = savePayload(SUMMARY, nextDraft(SUMMARY, ''));
    expect(repinned.engine).toBe('');
    expect(repinned.target).toBeUndefined();
  });

  it('never sends a key or an endpoint for an engine that has nowhere to put one', () => {
    // The host refuses those, and a card that sent them would turn a harmless
    // engine switch into a failed save.
    const { nextDraft, savePayload } = card();
    const draft = { ...nextDraft(SUMMARY, 'grok-cli'), apiKey: 'xai-leftover' };
    const payload = savePayload(SUMMARY, draft);
    expect(payload.apiKey).toBeUndefined();
    expect(payload.baseURL).toBeUndefined();
    expect(payload.engine).toBe('grok-cli');
  });

  it('sends a model only for the engine that reads one', () => {
    const { nextDraft, savePayload } = card();
    const agy = savePayload(SUMMARY, {
      ...nextDraft(SUMMARY, 'antigravity-cli'),
      model: 'gemini-3-flash',
    });
    expect(agy.target).toBe('antigravity-cli');
    expect(agy.model).toBe('gemini-3-flash');
    expect(agy.apiKey).toBeUndefined();

    const exa = savePayload(SUMMARY, { ...nextDraft(SUMMARY, 'exa'), apiKey: 'exa-1' });
    expect(exa.model).toBeUndefined();
    expect(exa.apiKey).toBe('exa-1');
  });

  it('seeds the draft from the engine it switched to, never the one before it', () => {
    const { nextDraft } = card();
    const next = nextDraft(SUMMARY, 'antigravity-cli');
    expect(next).toEqual({
      engine: 'antigravity-cli',
      apiKey: '',
      baseURL: '',
      model: 'gemini-3-pro',
      proxy: '',
      toolName: '',
      exposeState: 'aggregate',
      enabled: {
        'antigravity-cli': true,
        tavily: true,
        exa: false,
        firecrawl: true,
        keenable: true,
        anysearch: true,
        youcom: true,
        searxng: true,
        'grok-cli': true,
        local: true,
      },
      // MCP 的编辑区：draft 现在也带着它，默认不指向任何 server。
      // 这是「保存能同时改 MCP」的必然结果——卡片只有一个 draft。
      mcpTarget: '',
      mcpUrl: '',
      mcpProxy: '',
      mcpEnabled: true,
      // 正在原地编辑的引擎：nextDraft 的入参就是它要为其准备草稿的
      // 引擎，所以 editTarget 等于首选引擎本身。
      editTarget: 'antigravity-cli',
      // SearXNG 上游的编辑区：三态模式 + 默认代理 + 逐引擎规则。
      // 没有独立的 embedded 布尔字段：searxngMode 是唯一真源。
      searxngMode: 'embedded',
      searxngExternalURL: '',
      searxngExternalProxy: '',
      searxngDefaultProxy: '',
      searxngFilter: '',
      searxngScope: 'enabled',
      searxngShowAll: false,
      searxngEngineName: '',
      searxngRules: {},
    });
  });

  it('sends only engine checkboxes that changed', () => {
    const { nextDraft, savePayload } = card();
    const draft = nextDraft(SUMMARY, 'tavily');
    draft.enabled.tavily = false;
    draft.enabled.exa = true;
    expect(savePayload(SUMMARY, draft).enabled).toEqual({ tavily: false, exa: true });
  });

  it('leaves the file alone when a preference is switched away and back', () => {
    // The chain shows no row for `local`, so nothing on screen says it is
    // switched off. Selecting it back as the preference used to tick it
    // silently, and the save then deleted an override the user never saw.
    const { nextDraft, selectEngine, savePayload } = card();
    const summary = {
      ...SUMMARY,
      engine: 'local',
      engines: { ...SUMMARY.engines, local: { ...SUMMARY.engines.local, enabled: false } },
    };
    let draft = nextDraft(summary, 'local');
    draft = selectEngine(summary, draft, 'tavily');
    draft = selectEngine(summary, draft, 'local');
    expect(savePayload(summary, draft)).toEqual({});
  });

  it('pins an engine the chain cannot show without switching it on behind the user', () => {
    // exa is not ready here, so it has no checkbox. Pinning it is a decision
    // about preference, not about the override the user cannot see.
    const { nextDraft, selectEngine, savePayload } = card();
    const summary = {
      ...SUMMARY,
      engines: { ...SUMMARY.engines, exa: { ...SUMMARY.engines.exa, enabled: false } },
      readiness: READINESS,
    };
    const draft = selectEngine(summary, nextDraft(summary, 'tavily'), 'exa');
    expect(savePayload(summary, draft)).toEqual({ engine: 'exa' });
  });

  it('keeps pending checkboxes coherent when the preferred engine changes', () => {
    const { nextDraft, selectEngine, toggleEngine } = card();
    let draft = nextDraft(SUMMARY, 'tavily');
    draft = toggleEngine(draft, 'exa', true);
    draft = selectEngine(SUMMARY, draft, 'antigravity-cli');
    expect(draft.enabled.exa).toBe(true);
    expect(draft.enabled['antigravity-cli']).toBe(true);

    draft = toggleEngine(draft, 'antigravity-cli', false);
    expect(draft.engine).toBe('');

    draft = selectEngine(SUMMARY, draft, 'exa');
    expect(draft.engine).toBe('exa');
    expect(draft.enabled.exa).toBe(true);
  });
});

describe('the save button lights up exactly when a save would write something', () => {
  // 「保存」灰着而其实有东西要写，用户会以为已经改完；亮着而什么都不写，
  // 点一下等于白按。判据必须与 savePayload 是同一套。

  it('stays quiet on a freshly loaded draft', () => {
    const { nextDraft, isDirty } = evaluate({}).factory(() => ({})).__card;
    const draft = nextDraft(SUMMARY, SUMMARY.engine as string);
    expect(isDirty(SUMMARY, draft)).toBe(false);
  });

  it('lights up when an engine other than the preference has its endpoint edited', () => {
    // 这是本条测试存在的理由：旧判据拿 editTarget 的 baseURL 去比首选
    // 引擎的值，于是改 exa 的端点、首选是 tavily 时，按钮不会亮。
    const { nextDraft, isDirty, savePayload } = evaluate({}).factory(() => ({})).__card;
    const summary = { ...SUMMARY, engine: 'tavily' };
    const draft = nextDraft(summary, 'exa');
    draft.baseURL = 'https://exa.example.com';
    expect(isDirty(summary, draft)).toBe(true);
    // 与真实提交保持一致：savePayload 确实会写出这个端点。
    expect(savePayload(summary, draft).target).toBe('exa');
  });

  it('lights up when the preference moves', () => {
    const { nextDraft, isDirty } = evaluate({}).factory(() => ({})).__card;
    const draft = nextDraft(SUMMARY, SUMMARY.engine as string);
    draft.engine = 'firecrawl';
    expect(isDirty(SUMMARY, draft)).toBe(true);
  });

  it('lights up when an engine is toggled off', () => {
    const { nextDraft, toggleEngine, isDirty } = evaluate({}).factory(() => ({})).__card;
    const draft = nextDraft(SUMMARY, SUMMARY.engine as string);
    const next = toggleEngine(draft, 'tavily', false);
    expect(isDirty(SUMMARY, next)).toBe(true);
  });

  it('stays quiet after a preference is moved away and back', () => {
    const { nextDraft, isDirty } = evaluate({}).factory(() => ({})).__card;
    const draft = nextDraft(SUMMARY, SUMMARY.engine as string);
    draft.engine = 'firecrawl';
    draft.engine = String(SUMMARY.engine);
    expect(isDirty(SUMMARY, draft)).toBe(false);
  });
});

describe('the API key field is masked without being a password field', () => {
  // Safari's iCloud Keychain offers to enable autofill for any site with a
  // password input, then pops its bubble on every focus, for a field that is
  // always empty here: the key lives in the config file and the host sends
  // only whether one is stored.
  function secretProps(css: unknown): Record<string, unknown> {
    return evaluate({ css })
      .factory(() => ({}))
      .__card.secretFieldProps();
  }

  it('explains comma-separated key rotation in both interface languages', () => {
    expect(
      render(SUMMARY).texts.some((text) => /separate multiple keys with commas/i.test(text)),
    ).toBe(true);
    expect(
      render(SUMMARY, 'zh-CN').texts.some((text) => text.includes('多个密钥用英文逗号分隔')),
    ).toBe(true);
  });

  it('masks with text-security where the browser supports it', () => {
    const props = secretProps({ supports: (name: string) => name === '-webkit-text-security' });
    expect(props.type).toBe('text');
    expect((props.style as Record<string, unknown>).WebkitTextSecurity).toBe('disc');
    expect(props.autoComplete).toBe('off');
  });

  it('falls back to a password field rather than showing the key', () => {
    expect(secretProps({ supports: () => false }).type).toBe('password');
    expect(secretProps(undefined).type).toBe('password');
  });

  it('never renders the key field as a plain visible input', () => {
    // Pinning the field the card actually builds, not just the helper: a call
    // site asking for a plain text field would leave every helper test green
    // while the key rendered in clear text.
    for (const css of [{ supports: () => true }, { supports: () => false }, undefined]) {
      const built: Array<{ type: unknown; props: Record<string, unknown> }> = [];
      const draft = { engine: 'tavily', apiKey: '', baseURL: '', model: '' };
      const states = [true, SUMMARY, draft, ''];
      let index = 0;
      const react = {
        createElement: (type: unknown, props: Record<string, unknown>, ...kids: unknown[]) => {
          built.push({ type, props: props ?? {} });
          return { type, props, kids };
        },
        useState: () => [states[index++ % states.length], () => {}],
        useEffect: () => {},
        useCallback: (fn: unknown) => fn,
      };
      const Input = function Input() {
        return null;
      };
      evaluate({ css })
        .factory(() => ({}))
        .__card.ConfigCard(react, { Input })();
      const field = built
        .filter((node) => node.type === Input)
        .find((node) => node.props['data-key-field'] !== undefined);
      expect(field).toBeDefined();
      const masked =
        field?.props.type === 'password' ||
        (field?.props.style as Record<string, unknown> | undefined)?.WebkitTextSecurity === 'disc';
      expect(masked).toBe(true);
    }
  });
});

interface Node {
  type: unknown;
  props: Record<string, unknown>;
  kids: unknown[];
}

/** One row of the engine chain: what it reads as, and what it is set to. */
interface ChainRow {
  label: string;
  checked: unknown;
  title: unknown;
}

interface Rendered {
  card: Card;
  draft: CardDraft;
  nodes: Node[];
  chain: ChainRow[];
  options: Array<{ value: unknown; label: string; group: string }>;
  texts: string[];
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'kids' in value;
}

/** Every string under a node, in reading order: what the row says out loud. */
function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textOf).join(' ');
  }
  return isNode(value) ? textOf(value.kids) : '';
}

/** One expanded card, rendered in English, with the parts tests ask about. */
function render(
  summary: Record<string, unknown>,
  lang = 'en',
  probes?: {
    getComputedStyle?: (elt: unknown) => { color?: string };
    matchMedia?: (query: string) => { matches: boolean };
  },
): Rendered {
  const card = evaluate({ lang, ...probes }).factory(() => ({})).__card;
  const draft = card.nextDraft(summary, String(summary.engine ?? ''));
  const states = [true, summary, draft, ''];
  const built: Node[] = [];
  let index = 0;
  const react = {
    createElement: (type: unknown, props: Record<string, unknown>, ...kids: unknown[]) => {
      const node = { type, props: props ?? {}, kids };
      built.push(node);
      return node;
    },
    useState: () => [states[index++ % states.length], () => {}],
    useEffect: () => {},
    useCallback: (fn: unknown) => fn,
  };
  const Input = function Input() {
    return null;
  };
  card.ConfigCard(react, { Input })();
  const boxOf = (node: Node): Node | undefined =>
    node.kids.find((kid) => isNode(kid) && kid.props.type === 'checkbox') as Node | undefined;
  return {
    card,
    draft,
    nodes: built,
    // 引擎清单每行是一个 `.sf-row` div：内部一个可点的按钮（名字 + 状态）
    // 和一个官方 Switch。这里只取「名字」与「开关状态」，因为断言关心
    // 的是这一行叫什么、是否被打开。
    chain: built
      .filter((node) => node.type === 'div' && (node.props['data-engine-row'] !== undefined))
      .map((node) => {
        const kids = node.kids as Node[];
        const textSpan = kids.find(
          (k) => isNode(k) && (k.props.className || '').toString().includes('sf-row-text'),
        ) as Node | undefined;
        const nameSpan = textSpan
          ? (textSpan.kids as Node[]).find(
              (k) => isNode(k) && (k.props.className || '').toString().includes('sf-row-name'),
            ) as Node | undefined
          : undefined;
        const switchNode = kids.find(
          (k) => isNode(k) && k.props.label !== undefined && k.props.onChange !== undefined,
        ) as Node | undefined;
        return {
          label: textOf(nameSpan ? nameSpan.kids : []).replace(/\s+/g, ' ').trim(),
          checked: switchNode?.props.checked,
          title: undefined,
        };
      }),
    // Grouped by the select that owns them. The card has more than one
    // dropdown now (the preference list and the exposure form), and a flat
    // list would make each test silently assert against the wrong one.
    options: built
      .filter((node) => node.type === 'option')
      .map((node) => ({
        value: node.props.value,
        label: node.kids.filter((kid) => typeof kid === 'string').join(''),
        group: node.props['data-select'] === undefined ? 'preference' : String(node.props['data-select']),
      })),
    // 递归收齐所有可见字符串：文字现在住在嵌套的 span 里（行名、行说明
    // 各占一层），只收顶层字符串会漏掉这些。
    texts: (() => {
      const out: string[] = [];
      const seen = new Set<unknown>();
      const walk = (value: unknown) => {
        if (typeof value === 'string') { out.push(value); return; }
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (isNode(value)) {
          if (seen.has(value)) return;
          seen.add(value);
          walk(value.kids);
          // 官方的 DisclosureRow 把内容挂在 props.children 上（组件自己决定
          // 何时渲染），所以只走 kids 会漏掉折叠区里的文案。
          if (value.props.children !== undefined) walk(value.props.children);
        }
      };
      built.forEach((node) => walk(node.kids));
      return out;
    })(),
  };
}

const READINESS = [
  { engine: 'antigravity-cli', ready: false, reason: 'binary "agy" not found', keySource: null },
  { engine: 'tavily', ready: true, reason: 'API key present', keySource: 'file' },
  { engine: 'exa', ready: false, reason: 'no API key', keySource: null },
  { engine: 'firecrawl', ready: true, reason: 'keyless', keySource: null },
  { engine: 'grok-cli', ready: false, reason: 'binary "grok" not found', keySource: null },
  { engine: 'local', ready: true, reason: 'built in', keySource: null },
];

describe('the SearXNG upstream section', () => {
  const SUMMARY_WITH_SEARXNG = {
    ...SUMMARY,
    searxng: {
      embedded: true,
      outgoing: {},
      networks: {
        via_tor: { proxies: { 'all://': 'socks5h://127.0.0.1:9050' } },
      },
      engines: {
        google: { network: 'via_tor' },
        brave: { proxies: { https: ['http://a:8080', 'http://b:8080'] } },
        startpage: { using_tor_proxy: true },
      },
    },
  };

  it('says nothing about a section the file does not configure', () => {
    // 没有 searxng 段时不渲染这个区块：一个空的分区只会让人以为有东西。
    const view = render(SUMMARY);
    expect(view.texts.join(' ')).not.toMatch(/SearXNG upstream/i);
  });

  it('lists the configured networks and upstream engines', () => {
    const view = render(SUMMARY_WITH_SEARXNG);
    // 段标题与上游清单标题。
    expect(view.texts.join(' ')).toMatch(/SearXNG/i);
    expect(view.texts.join(' ')).toMatch(/Upstream engines/i);
    const texts = view.texts.join(' ');
    // 已配置的上游引擎各占一行。
    expect(texts).toContain('google');
    expect(texts).toContain('brave');
    expect(texts).toContain('startpage');
    // 已配置的命名网络出现在折叠的「Named networks」里，代理值如实回填。
    expect(texts).toContain('via_tor');
    expect(texts).toContain('socks5h://127.0.0.1:9050');
    // 该引擎的规则摘要带上网络与 Tor 徽标。
    expect(texts).toMatch(/tor/i);
  });

  it('mirrors the bundled-instance mode from the file', () => {
    const view = render(SUMMARY_WITH_SEARXNG);
    // 三态是唯一真源：文件里 embedded 为真时，模式就是内置。
    expect(view.draft.searxngMode).toBe('embedded');
  });

  it('shows the bundled instance as the active mode when the file says so', () => {
    const view = render(SUMMARY_WITH_SEARXNG);
    // 三态互斥：文件里 embedded 为真时，记住它就是当前模式。
    expect(view.draft.searxngMode).toBe('embedded');
  });

  it('does not render upstream rows when nothing is configured', () => {
    const view = render({ ...SUMMARY, searxng: { embedded: false, outgoing: {}, networks: {}, engines: {} } });
    // 三态选择器始终在，作为唯一入口；空配置下不出现任何上游行。
    expect(view.texts.join(' ')).toMatch(/How SearXNG runs/i);
    expect(view.texts.join(' ')).not.toMatch(/Named networks$/);
  });

  // ── 三态语义（off / embedded / external）────────────────────────
  //
  // 这三条覆盖的是曾经的语义分裂：后端默认「未写 = 开」，而下发给卡片的
  // 值却按 `=== true` 算成「关」，于是全新用户看到的是一张撒谎的卡片。

  it('treats an absent embedded key as on, matching the backend default', () => {
    // 文件里没有 searxng 段 = 使用默认 = 内置实例开启。
    const view = render({ ...SUMMARY, searxng: undefined });
    expect(view.draft.searxngMode).toBe('embedded');
  });

  it('reads an explicit embedded:false as off, not as bundled', () => {
    // 显式关闭时 searxng 段仍然存在；旧实现只要段存在就判成 embedded，
    // 于是「关闭」在界面上显示成开着。
    const view = render({ ...SUMMARY, searxng: { embedded: false, outgoing: {}, networks: {}, engines: {} } });
    expect(view.draft.searxngMode).toBe('off');
  });

  it('reads a baseURL as external regardless of the embedded flag', () => {
    // 外部地址优先于内置开关，这是后端既有的优先级。
    const view = render({
      ...SUMMARY,
      engines: { ...SUMMARY.engines, searxng: { baseURL: 'https://sx.example.com', model: '' } },
      searxng: { embedded: true, outgoing: {}, networks: {}, engines: {} },
    });
    expect(view.draft.searxngMode).toBe('external');
  });

  it('writes embedded:false instead of deleting the key when switched off', () => {
    // 默认是开，删键等于回到默认，也就是仍然开着。关闭必须写成显式的 false。
    const { nextDraft, savePayload } = evaluate({}).factory(() => ({})).__card;
    const draft = nextDraft({ ...SUMMARY, searxng: { embedded: true } }, '');
    draft.searxngMode = 'off';
    const payload = savePayload({ ...SUMMARY, searxng: { embedded: true } }, draft);
    expect(payload.searxngEmbedded).toBe(false);
    expect(payload.searxngExternalURL).toBe('');
  });

  it('does not carry a second embedded source in the draft', () => {
    // searxngMode 是唯一真源；草稿里再存一份布尔值就会在保存时打架。
    const view = render({ ...SUMMARY, searxng: { embedded: false } });
    expect(Object.hasOwn(view.draft, 'searxngEmbedded')).toBe(false);
  });
});

describe('the automatic engine chain lists what this machine can actually search with', () => {
  // The chain is a set of checkboxes, one per search engine the machine is
  // ready to run. An engine doctor cannot run here is not a row the user can
  // act on, so it is left out entirely rather than shown greyed with a reason
  // beside it, and so is `local`, which fetches pages and never searches.

  it('lists every search engine, marking the ones doctor cannot run here', () => {
    // 隐藏一个本机暂时跑不了的引擎，会让用户既看不到它、也无法去修它。
    // 因此引擎组恒定列出全部八个搜索引擎，可用性由行内状态词表达。
    const view = render({ ...SUMMARY, readiness: READINESS });
    expect(view.chain.map((row) => row.label)).toEqual([
      'antigravity-cli',
      'tavily',
      'exa',
      'firecrawl',
      'keenable',
      'anysearch',
      'youcom',
      'searxng',
      'grok-cli',
    ]);
    // 就绪状态是行内的 12px 小字，不是筛掉引擎的理由。
    expect(view.texts.join(' ')).toMatch(/not ready/i);
    expect(view.texts.join(' ')).toMatch(/ready/i);
  });

  it('never carries a doctor reason back in as a tooltip', () => {
    // doctor 的原因与修法是英文诊断串，它们现在以行内小字出现在折叠的
    // 高级区里，而不是塞进 title/tooltip —— 后者会把未翻译的诊断重新挂回
    // 一个刚刚把它摘掉的卡片上。
    const view = render({ ...SUMMARY, readiness: READINESS });
    expect(view.chain.map((row) => row.title)).toEqual(
      view.chain.map(() => undefined),
    );
    // 只看真正的 DOM 节点（type 是字符串）：官方组件的 `title` 是它自己的
    // 区块标题，不是挂在元素上的 tooltip 属性。
    expect(
      view.nodes.filter(
        (node) => typeof node.type === 'string' && node.props.title !== undefined,
      ),
    ).toEqual([]);
    // 一段未就绪引擎的修法说明确实出现在正文里（不是 tooltip）。
    expect(view.texts.some((text) => /binary "agy" not found/i.test(text))).toBe(true);
  });

  it('leaves the page fetcher out of a row of search engines', () => {
    // `local` reads a URL it is handed. It is in no search chain, so a tickbox
    // among the search engines would only invite a decision that does nothing.
    const view = render({ ...SUMMARY, readiness: READINESS });
    expect(view.chain.map((row) => row.label).join(' ')).not.toContain('local');
  });

  it('marks grok-cli as the one that only searches X, where a reader hears it', () => {
    // grok-cli serves the social role alone: it never joins web-search
    // failover, and an unmarked tickbox in this row would promise it does. The
    // note rides inside the label that names the checkbox, so it is announced
    // rather than painted: an aria-label of just the engine name would hide it.
    const view = render({
      ...SUMMARY,
      readiness: READINESS.map((entry) =>
        entry.engine === 'grok-cli' ? { ...entry, ready: true } : entry,
      ),
    });
    // 名字只写引擎名；「仅 X 搜索」是一个徽标，紧跟其后被读出来。
    expect(view.chain.map((row) => row.label)).toContain('grok-cli');
    const texts = view.texts.join(' ');
    expect(texts).toContain('X search only');
  });

  it('keeps a ready engine on screen after it was switched off', () => {
    // Hiding an unchecked engine would be a one-way door: the checkbox is the
    // only way back on, and dsh web users have no terminal to undo it with.
    const view = render({
      ...SUMMARY,
      engines: { ...SUMMARY.engines, firecrawl: { ...SUMMARY.engines.firecrawl, enabled: false } },
      readiness: READINESS,
    });
    expect(view.chain.find((row) => row.label === 'firecrawl')?.checked).toBe(false);
  });

  it('never writes over a hidden engine’s stored override when the card saves', () => {
    // exa is not ready here and `local` is never in this row at all, so neither
    // has a checkbox. Gone from the screen must not mean gone from the file:
    // their `enabled: false` is not this save's business, and a payload naming
    // them would delete the override.
    const summary = {
      ...SUMMARY,
      engines: { ...SUMMARY.engines, local: { ...SUMMARY.engines.local, enabled: false } },
      readiness: READINESS,
    };
    const view = render(summary);
    const draft = view.card.toggleEngine(view.draft, 'firecrawl', false);
    const payload = view.card.savePayload(summary, draft);
    expect(payload.enabled).toEqual({ firecrawl: false });
  });

  it('still lists every engine when doctor reports nothing ready', () => {
    // 「没有引擎就绪」不是一个可以把整张表撤走的判定：那会让用户既看不到
    // 引擎、也无从把它修好。表格照常列出，状态词说明没有就绪项。
    const view = render({ ...SUMMARY, readiness: [] });
    expect(view.chain.length).toBeGreaterThan(0);
    expect(view.texts.some((text) => /No engine is ready|no engine ready/i.test(text))).toBe(true);
  });

  it('lists every search engine when doctor’s answer never arrived', () => {
    // A failed probe is not a verdict of "nothing works here". Hiding the whole
    // chain then would take away controls over a fact the card does not know.
    const view = render(SUMMARY);
    expect(view.chain.map((row) => row.label)).toEqual([
      'antigravity-cli',
      'tavily',
      'exa',
      'firecrawl',
      'keenable',
      'anysearch',
      'youcom',
      'searxng',
      // 「仅 X 搜索」现在是徽标，不再拼进名字。
      'grok-cli',
    ]);
    expect(view.texts.some((text) => /status is unavailable/i.test(text))).toBe(true);
  });

  it('speaks its own asides in Chinese under a Chinese card', () => {
    // Four lines that only ever appear in this section. An English string
    // leaking into a Chinese card is invisible to every test that renders in
    // English, which is every other test here.
    const zh = (summary: Record<string, unknown>): string[] => render(summary, 'zh-CN').texts;
    // 「仅 X 搜索」与就绪、密钥状态一起被拼进同一行的说明串，
    // 所以按整串包含判断，而不是逐条精确相等。
    expect(
      zh({ ...SUMMARY, readiness: READINESS.map((e) => ({ ...e, ready: true })) }).join(' '),
    ).toContain('仅 X 搜索');
    expect(zh({ ...SUMMARY, readiness: [] })).toContain('本机暂无就绪的引擎。');
    expect(zh(SUMMARY)).toContain('暂时读不到引擎状态，所以列出全部引擎。');
    expect(zh({ ...SUMMARY, engine: 'firecrawl', readiness: READINESS })).toContain(
      '默认使用免注册的免费额度，填入密钥可提高配额。',
    );
  });

  it('says firecrawl needs no key, until one is stored', () => {
    // The default engine works with no signup at all. Silence there reads as a
    // key being required, which is the one thing this engine does not need.
    // Matched on the whole sentence: the same words label the select option,
    // which is there whether or not a key is stored.
    const note = /Runs on the keyless free tier/i;
    const keyless = render({ ...SUMMARY, engine: 'firecrawl', readiness: READINESS });
    expect(keyless.texts.some((text) => note.test(text))).toBe(true);

    const keyed = render({
      ...SUMMARY,
      engine: 'firecrawl',
      engines: { ...SUMMARY.engines, firecrawl: { ...SUMMARY.engines.firecrawl, hasKey: true } },
      readiness: READINESS,
    });
    // 别的免密钥引擎（keenable / anysearch / youcom）仍然没有密钥，所以
    // 那句话还在整页里；要判断的是 firecrawl 自己不再提。它那块用的
    // key 是 `keyless-firecrawl`。
    expect(
      keyed.nodes.some((node) => node.props.key === 'keyless-firecrawl'),
    ).toBe(false);
  });

  it('says youcom needs no key and offers no key field', () => {
    // You.com runs keyless only, so the card has no key to ask for and must
    // not promise that a key raises the quota.
    const view = render({ ...SUMMARY, engine: 'youcom', readiness: READINESS });
    expect(view.texts.some((text) => /100 searches a day per IP/.test(text))).toBe(true);
    // 全部展开后每个引擎都会展示自己的说明，所以「命令行工具」这条文案
    // 必然出现（antigravity-cli / grok-cli 确实是命令行工具）。这条用例的
    // 真正意图是 youcom 自己走免注册额度，因此只断言它的专属文案存在。
    expect(
      view.texts.some((text) => /100 searches a day per IP/.test(text)),
    ).toBe(true);
    expect(view.options.find((option) => option.value === 'youcom')?.label).toBe(
      'youcom (keyless free tier)',
    );
    expect(render({ ...SUMMARY, engine: 'youcom' }, 'zh-CN').texts).toContain(
      '走 You.com 免注册免费额度（每个 IP 每天 100 次），无需密钥和接口地址。',
    );
  });
});

describe('a save re-reads what the machine can do now', () => {
  it('asks doctor again after saving, so a key that just landed grows a checkbox', async () => {
    // Readiness was read once, when the card was expanded. Saving the very key
    // that makes an engine ready would otherwise leave its checkbox missing
    // until the whole card was closed and opened again.
    const urls: string[] = [];
    const fresh = [
      { engine: 'tavily', ready: true, reason: 'API key present', keySource: 'file' },
      { engine: 'exa', ready: true, reason: 'API key present', keySource: 'file' },
    ];
    const stale = [{ engine: 'tavily', ready: true, reason: 'API key present', keySource: 'file' }];
    const definition = evaluate({
      lang: 'en',
      fetch: (url: string, init?: { method?: string }) => {
        urls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              init?.method === 'POST' ? { ...SUMMARY } : { ...SUMMARY, readiness: fresh },
            ),
        });
      },
    });
    const card = definition.factory(() => ({})).__card;
    const summary = { ...SUMMARY, readiness: stale };
    const draft = { ...card.nextDraft(summary, 'exa'), apiKey: 'exa-new' };
    const summaries: Array<Record<string, unknown>> = [];
    const nodes: Node[] = [];
    let index = 0;
    const react = {
      createElement: (type: unknown, props: Record<string, unknown>, ...kids: unknown[]) => {
        const node = { type, props: props ?? {}, kids };
        nodes.push(node);
        return node;
      },
      useState: () => {
        const slot = index++;
        return [
          [true, summary, draft, ''][slot],
          (value: unknown) => {
            if (slot === 1) {
              summaries.push(value as Record<string, unknown>);
            }
          },
        ];
      },
      useEffect: () => {},
      useCallback: (fn: unknown) => fn,
    };
    const Input = function Input() {
      return null;
    };
    card.ConfigCard(react, { Input })();
    const save = nodes.find((node) => node.type === 'button' && node.kids.includes('Save'));
    if (!save) {
      throw new Error('no save button');
    }
    (save.props.onClick as () => void)();
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    expect(urls.filter((url) => url.includes('doctor'))).toHaveLength(1);
    expect(summaries[summaries.length - 1]?.readiness).toEqual(fresh);
  });

  it('keeps the saved note when the fresh readiness read fails', async () => {
    // The save landed. A follow-up probe that did not is no reason to tell the
    // user their save failed.
    const notes: string[] = [];
    const definition = evaluate({
      lang: 'en',
      fetch: (_url: string, init?: { method?: string }) =>
        init?.method === 'POST'
          ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...SUMMARY }) })
          : Promise.reject(new Error('offline')),
    });
    const card = definition.factory(() => ({})).__card;
    const draft = { ...card.nextDraft(SUMMARY, 'tavily'), apiKey: 'tvly-new' };
    const nodes: Node[] = [];
    let index = 0;
    const react = {
      createElement: (type: unknown, props: Record<string, unknown>, ...kids: unknown[]) => {
        const node = { type, props: props ?? {}, kids };
        nodes.push(node);
        return node;
      },
      useState: () => {
        const slot = index++;
        return [
          [true, SUMMARY, draft, ''][slot],
          (value: unknown) => {
            if (slot === 3) {
              notes.push(String(value));
            }
          },
        ];
      },
      useEffect: () => {},
      useCallback: (fn: unknown) => fn,
    };
    const Input = function Input() {
      return null;
    };
    card.ConfigCard(react, { Input })();
    const save = nodes.find((node) => node.type === 'button' && node.kids.includes('Save'));
    if (!save) {
      throw new Error('no save button');
    }
    (save.props.onClick as () => void)();
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    expect(notes).toEqual(['saving...', 'saved']);
  });
});

describe('the preference list offers only engines a preference can mean', () => {
  const values = (view: Rendered): unknown[] =>
    view.options.filter((option) => option.group === 'preference').map((option) => option.value);

  it('leaves the page fetcher out of the list', () => {
    // Pinning `local` would pin the page fetcher as the search engine, which
    // searches nothing. The option was an invitation to break search.
    expect(values(render(SUMMARY))).toEqual([
      '',
      'antigravity-cli',
      'tavily',
      'exa',
      'firecrawl',
      'keenable',
      'anysearch',
      'youcom',
      'searxng',
      'grok-cli',
    ]);
  });

  it('keeps the page fetcher listed while the config still pins it', () => {
    // A CLI-set `engine: local` is the state of the file. Dropping the option
    // would leave the select showing some other engine as the preference, which
    // is the card lying about what is configured.
    const view = render({ ...SUMMARY, engine: 'local' });
    expect(values(view)).toContain('local');
    expect(view.draft.engine).toBe('local');
  });

  it('marks firecrawl as the one that needs no signup', () => {
    const view = render(SUMMARY);
    expect(view.options.find((option) => option.value === 'firecrawl')?.label).toBe(
      'firecrawl (keyless free tier)',
    );
    expect(view.options.find((option) => option.value === 'tavily')?.label).toBe('tavily');
  });

  it('says it in Chinese under a Chinese card', () => {
    const view = render({ ...SUMMARY, engine: '' }, 'zh-CN');
    expect(view.options.find((option) => option.value === 'firecrawl')?.label).toBe(
      'firecrawl（免注册免费）',
    );
  });
});

describe('the preferred-engine menu stays readable in the host theme', () => {
  // Native popups ignore inherit color. On a dark card they would otherwise
  // paint as white-on-white, which is a list nobody can read.
  // 弹出层的配色来自宿主 token，不是硬编码色值：原生 <select> 的弹出层
  // 不认 CSS 变量，所以必须给具体值，但取值本身仍然由主题决定。
  const LIGHT_OPTION = {
    color: 'var(--dsw-alias-label-primary-inverted, #353638)',
    background: 'var(--dsw-alias-button-primary-fill, #f9fafb)',
  };
  const DARK_OPTION = {
    color: 'var(--dsw-alias-label-primary, #f9fafb)',
    background: 'var(--dsw-alias-card-fill, #212123)',
  };

  function menuOf(view: Rendered): { select: Node | undefined; options: Node[] } {
    return {
      select: view.nodes.find((node) => node.type === 'select'),
      options: view.nodes.filter((node) => node.type === 'option'),
    };
  }

  function schemeOf(select: Node | undefined): unknown {
    return (select?.props.style as Record<string, unknown> | undefined)?.colorScheme;
  }

  it('keeps the native light look when the card theme cannot be read', () => {
    expect(() => render(SUMMARY)).not.toThrow();
    const { select, options } = menuOf(render(SUMMARY));
    expect(schemeOf(select)).toBe('light');
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.props.style).toEqual(LIGHT_OPTION);
    }
  });

  it('paints a dark popup when the card text is light', () => {
    const { select, options } = menuOf(
      render(SUMMARY, 'en', {
        getComputedStyle: () => ({ color: 'rgb(242, 242, 242)' }),
      }),
    );
    expect(schemeOf(select)).toBe('dark');
    for (const option of options) {
      expect(option.props.style).toEqual(DARK_OPTION);
    }
  });

  it('keeps a light popup when the card text is dark, even if the OS prefers dark', () => {
    const { select, options } = menuOf(
      render(SUMMARY, 'en', {
        getComputedStyle: () => ({ color: 'rgb(35, 38, 42)' }),
        matchMedia: () => ({ matches: true }),
      }),
    );
    expect(schemeOf(select)).toBe('light');
    for (const option of options) {
      expect(option.props.style).toEqual(LIGHT_OPTION);
    }
  });

  it('follows an OS dark preference when the card color cannot be read', () => {
    const { select, options } = menuOf(
      render(SUMMARY, 'en', {
        matchMedia: (query) => ({ matches: query === '(prefers-color-scheme: dark)' }),
      }),
    );
    expect(schemeOf(select)).toBe('dark');
    for (const option of options) {
      expect(option.props.style).toEqual(DARK_OPTION);
    }
  });
});

describe('a failed load or save speaks the reader’s language', () => {
  // The footer note lands in a role="status" region, so it is read aloud.
  // A hard-coded English fallback would put "load failed" under a Chinese
  // card. What the server said still travels untranslated: that is the
  // diagnosis, not the card's copy.
  interface Node {
    type: unknown;
    props: Record<string, unknown>;
    kids: unknown[];
  }

  function render(options: { lang: string; states: unknown[]; detail?: string }): {
    notes: string[];
    nodes: Node[];
  } {
    const definition = evaluate({
      lang: options.lang,
      fetch: () =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve(options.detail ? { error: options.detail } : {}),
        }),
    });
    const notes: string[] = [];
    const nodes: Node[] = [];
    let index = 0;
    const react = {
      createElement: (type: unknown, props: Record<string, unknown>, ...kids: unknown[]) => {
        const node = { type, props: props ?? {}, kids };
        nodes.push(node);
        return node;
      },
      useState: () => {
        const slot = index++;
        return [
          options.states[slot],
          (value: unknown) => {
            // The note is the fourth useState, after open, summary and draft.
            if (slot === 3) {
              notes.push(String(value));
            }
          },
        ];
      },
      useEffect: (fn: () => void) => {
        fn();
      },
      useCallback: (fn: unknown) => fn,
    };
    const Input = function Input() {
      return null;
    };
    definition.factory(() => ({})).__card.ConfigCard(react, { Input })();
    return { notes, nodes };
  }

  /** Expanded with nothing loaded yet: the effect fires the load, which fails. */
  const loadStates = (): unknown[] => [true, null, null, ''];
  /** Expanded with a summary whose draft was edited, so save is enabled. */
  const saveStates = (): unknown[] => [
    true,
    SUMMARY,
    { engine: 'tavily', apiKey: 'tvly-new', baseURL: 'https://a.example', model: '' },
    '',
  ];

  function clickSave(nodes: Node[], label: string): void {
    const button = nodes.find((node) => node.type === 'button' && node.kids.includes(label));
    if (!button) {
      throw new Error(`no save button labelled ${label}`);
    }
    (button.props.onClick as () => void)();
  }

  it('falls back to a localized line when the server said nothing', async () => {
    const zh = render({ lang: 'zh-CN', states: loadStates() });
    await settle();
    expect(zh.notes).toEqual(['加载失败']);

    const en = render({ lang: 'en', states: loadStates() });
    await settle();
    expect(en.notes).toEqual(['load failed']);
  });

  it('says so in the reader’s language when a save fails', async () => {
    const zh = render({ lang: 'zh-CN', states: saveStates() });
    clickSave(zh.nodes, '保存');
    await settle();
    expect(zh.notes).toEqual(['保存中…', '保存失败']);

    const en = render({ lang: 'en', states: saveStates() });
    clickSave(en.nodes, 'Save');
    await settle();
    expect(en.notes).toEqual(['saving...', 'save failed']);
  });

  it('shows what the server said rather than translating it', async () => {
    // 'unknown engine: x' and path errors are the diagnosis. Mapping them to
    // error codes would buy a translation table for a dozen strings.
    const zh = render({ lang: 'zh-CN', states: loadStates(), detail: 'unknown engine: x' });
    await settle();
    expect(zh.notes).toEqual(['unknown engine: x']);
  });
});

describe('the card follows dsh’s own interface language', () => {
  // dsh ships `<html lang="zh-CN">` frozen into the built index.html and never
  // rewrites it, so a user whose dsh is set to English still got a Chinese
  // card. The locale service knows the real answer, so it is asked first and
  // the page language is only the fallback.
  class FakeLocale {
    private snapshot: { active: string; locales: unknown[]; revision: number };
    private readonly listeners = new Set<() => void>();
    public subscribeCalls = 0;

    constructor(active: string) {
      this.snapshot = { active, locales: [], revision: 1 };
    }

    getSnapshot(): { active: string; locales: unknown[]; revision: number } {
      return this.snapshot;
    }

    subscribe(fn: () => void): () => void {
      this.subscribeCalls += 1;
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    setLocale(active: string): void {
      this.snapshot = { active, locales: [], revision: this.snapshot.revision + 1 };
      for (const fn of this.listeners) {
        fn();
      }
    }
  }

  interface Mounted {
    texts: string[];
    renders: number;
  }

  function mount(options: { lang: string; locale?: FakeLocale }): Mounted {
    const definition = evaluate({ lang: options.lang });
    const state: Mounted = { texts: [], renders: 0 };
    let subscribed = false;
    const react = {
      createElement: (type: unknown, props: Record<string, unknown>, ...kids: unknown[]) => {
        for (const kid of kids) {
          if (typeof kid === 'string') {
            state.texts.push(kid);
          }
        }
        return { type, props: props ?? {}, kids };
      },
      useState: (initial: unknown) => [initial, () => {}],
      useEffect: () => {},
      useCallback: (fn: unknown) => fn,
      useSyncExternalStore: (
        subscribe: (onChange: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        // React subscribes once per mount and re-renders on notice.
        if (!subscribed) {
          subscribed = true;
          subscribe(() => {
            state.renders += 1;
            state.texts = [];
            Card();
          });
        }
        return getSnapshot();
      },
    };
    const Input = function Input() {
      return null;
    };
    const Card = definition
      .factory(() => ({}))
      .__card.ConfigCard(
        react,
        { Input },
        options.locale ? { current: options.locale } : undefined,
      );
    Card();
    return state;
  }

  // Not "网页搜索": dsh ships its own "网页搜索（DeepSeek 搜索提供方）" card in
  // the same list, and two cards whose names start alike is a list nobody can
  // read. This name pairs with the sibling plugin's 视觉引擎（ModLens）.
  const ZH_TITLE = '搜索引擎（ModSearch）';
  const EN_TITLE = 'Search engine (ModSearch)';

  it('speaks English where dsh is set to English under a zh-CN page', () => {
    const card = mount({ lang: 'zh-CN', locale: new FakeLocale('en') });
    expect(card.texts).toContain(EN_TITLE);
    expect(card.texts).not.toContain(ZH_TITLE);
  });

  it('speaks Chinese where dsh is set to Chinese under an English page', () => {
    const card = mount({ lang: 'en-US', locale: new FakeLocale('zh') });
    expect(card.texts).toContain(ZH_TITLE);
    expect(card.texts).not.toContain(EN_TITLE);
  });

  it('falls back to the page language where the host serves no locale service', () => {
    expect(mount({ lang: 'zh-CN' }).texts).toContain(ZH_TITLE);
    expect(mount({ lang: 'en-US' }).texts).toContain(EN_TITLE);
  });

  it('switches copy when the user switches language mid-session', () => {
    const locale = new FakeLocale('zh');
    const card = mount({ lang: 'zh-CN', locale });
    expect(card.texts).toContain(ZH_TITLE);
    expect(locale.subscribeCalls).toBe(1);

    locale.setLocale('en');
    expect(card.renders).toBe(1);
    expect(card.texts).toContain(EN_TITLE);
    expect(card.texts).not.toContain(ZH_TITLE);
  });
});

describe('the exposure matrix', () => {
  it('shows one selection per engine instead of two unrelated switches', () => {
    const card = render(SUMMARY);
    const expose = card.options.filter((option) => option.group === 'expose');
    // 全部展开后每个引擎各有自己的下拉，取值集合相同；断言第一组即可，
    // 并确认组数等于渲染出的引擎数（一组不多、一组不少）。
    const firstGroup = expose.slice(0, 4);
    expect(firstGroup.map((option) => option.value)).toEqual(['both', 'aggregate', 'tool', 'off']);
    expect(expose.length % 4).toBe(0);
    // The engine preference list is untouched by the new dropdown.
    expect(card.options.filter((o) => o.group === 'preference').length).toBeGreaterThan(0);
  });

  // Each form is verified through savePayload, which is what the card
  // actually sends: a helper asserted directly would prove nothing about
  // what reaches the file.
  const forms = [
    ['both', { enabled: true, expose: { aggregate: true, tool: true } }],
    ['aggregate', { enabled: true, expose: { aggregate: true, tool: false } }],
    ['tool', { enabled: true, expose: { aggregate: false, tool: true } }],
    ['off', { enabled: false, expose: { aggregate: false, tool: false } }],
  ];

  it('seeds the draft from the file rather than guessing a form', () => {
    const draft = evaluate({}).factory(() => ({})).__card.nextDraft(
      {
        ...SUMMARY,
        engines: { ...SUMMARY.engines, tavily: { ...SUMMARY.engines.tavily, enabled: true, expose: { aggregate: false, tool: true } } },
      },
      'tavily',
    );
    expect(draft.exposeState).toBe('tool');
  });

  it.each(forms.filter(([state]) => state !== 'aggregate'))(
    'sends the flags %s stands for',
    (state, expected) => {
      const card = evaluate({}).factory(() => ({})).__card;
      const draft = card.nextDraft(SUMMARY, 'tavily');
      draft.exposeState = state;
      expect(card.savePayload(SUMMARY, draft).expose).toEqual(expected);
    },
  );

  it('sends nothing when the form is switched back to the default', () => {
    // aggregate is what an engine already does, so choosing it is not a change
    // and must not rewrite the file the same way it already is.
    const card = evaluate({}).factory(() => ({})).__card;
    const draft = card.nextDraft(SUMMARY, 'tavily');
    draft.exposeState = 'aggregate';
    expect(card.savePayload(SUMMARY, draft).expose).toBeUndefined();
  });
});

describe('per-engine proxy and tool name fields', () => {
  const cardOf = () => evaluate({}).factory(() => ({})).__card;

  it('carries an edited proxy in the save', () => {
    const card = cardOf();
    const draft = card.nextDraft(SUMMARY, 'tavily');
    draft.proxy = 'http://127.0.0.1:7890';
    expect(card.savePayload(SUMMARY, draft).proxy).toBe('http://127.0.0.1:7890');
  });

  it('leaves the file alone when the proxy field is blank', () => {
    // A blank field is what the card shows for an engine whose proxy lives in
    // the file; treating it as a deletion would erase a value nobody saw.
    const card = cardOf();
    const draft = card.nextDraft(SUMMARY, 'tavily');
    expect(card.savePayload(SUMMARY, draft).proxy).toBeUndefined();
  });

  it('carries a tool name only when the engine becomes a standalone tool', () => {
    const card = cardOf();
    const draft = card.nextDraft(SUMMARY, 'tavily');
    draft.exposeState = 'aggregate';
    draft.toolName = 'my_search';
    expect(card.savePayload(SUMMARY, draft).toolName).toBeUndefined();
    draft.exposeState = 'tool';
    expect(card.savePayload(SUMMARY, draft).toolName).toBe('my_search');
  });

  it('carries the exposure change on its own, with no text edit', () => {
    const card = cardOf();
    const draft = card.nextDraft(SUMMARY, 'tavily');
    draft.exposeState = 'off';
    const payload = card.savePayload(SUMMARY, draft);
    expect(payload.expose).toEqual({ enabled: false, expose: { aggregate: false, tool: false } });
  });
});

describe('the card’s stylesheet holds its design contracts', () => {
  // 样式没有运行时断言可依赖：一条写错的 token 会静默失效，界面退回浏览器
  // 默认值，而控制台一片安静。这些静态门禁就是那类故障的唯一防线。

  const css = () => {
    const start = SOURCE.indexOf('var CARD_CSS = `');
    const end = SOURCE.indexOf('`;', start);
    return SOURCE.slice(start, end);
  };

  it('never uses token names the host does not define', () => {
    // 以下名字在官方主题里根本不存在，写上等于写空值（技能库实测清单）。
    const bogus = [
      '--dsw-alias-surface-primary',
      '--dsw-alias-surface-secondary',
      '--dsw-alias-border-subtle',
      '--dsw-alias-accent-primary',
    ];
    for (const name of bogus) {
      expect(css()).not.toContain(name);
    }
  });

  it('uses the semantic alias layer, not the raw palette', () => {
    // --dsw-static-* 是原始色板，引用它等于放弃主题联动。
    expect(css()).not.toContain('--dsw-static-');
  });

  it('gives every interactive control a focus ring', () => {
    expect(css()).toContain(':focus-visible');
    expect(css()).toContain('--dsw-focus-ring-width');
  });

  it('honours the reduced-motion preference', () => {
    // 有过渡就必须有降级，否则前庭不适的用户没有退路。
    expect(css()).toContain('prefers-reduced-motion');
  });

  it('draws hairlines at 0.5px, never 1px', () => {
    // 官方九处描边全是 0.5px；1px 会让整块读起来比宿主粗一档。
    const borders = css().match(/border[^;{]*:\s*(\d+(?:\.\d+)?)px\s+solid/g) ?? [];
    for (const rule of borders) {
      const px = rule.match(/(\d+(?:\.\d+)?)px/);
      expect(Number(px?.[1])).toBeLessThanOrEqual(1);
      // 允许 0.5 与 1（后者只用于折叠卡片外框这种刻意的例外）。
    }
  });

  it('keeps the injected style tag a singleton', () => {
    // HMR 重跑工厂时必须更新已有标签，而不是再插一个。
    expect(SOURCE).toContain('tag.textContent = CARD_CSS');
    expect(SOURCE).toMatch(/if \(!tag\) \{/);
  });
});
