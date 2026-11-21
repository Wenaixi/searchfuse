// 配置的白名单键清单，供两个写入方共用。
//
// 为什么单独一个模块：写这份配置的地方有两处，而且它们语义相反——
//
// - `src/config.ts` 的 `setConfigValue` 走**白名单重建**：只搬运已知键，
//   其余一律丢弃。新增一个顶层段却忘了加进清单，它会在下一次
//   `searchfuse config set` 之后静默消失，不报错。
// - `dsh/index.js` 的设置卡片走**整份回写**（`JSON.stringify(config)`），
//   未知键会被保留。
//
// 两个方向相反的写入方共用一份清单，才不会出现「保存卡片后键还在、
// 跑一次 CLI 就没了」这种非对称腐蚀。
//
// `dsh/index.js` 是手写 JavaScript，够不到 TypeScript 源码，所以这份清单
// 必须有编译产物（`dist/config-schema.js`），由 dsh 侧 import。

/**
 * 配置里所有合法的顶层键。
 *
 * 加新顶层段时必须同步这里的清单，否则它会在 `config set` 之后被抹掉。
 * 这是本文件存在的唯一理由。
 */
export const KNOWN_TOP_LEVEL_KEYS = [
  'engine',
  'engines',
  'aggregate',
  'mcp',
  'cooldown',
  'allowPrivateNetwork',
  // 三宿主改造新增的两段。加在这里，`config set` 才不会把它们丢掉。
  'hosts',
  'serve',
  // 随包 SearXNG 的抓取配置（代理、命名网络、逐引擎规则）。
  'searxng',
] as const;

export type KnownTopLevelKey = (typeof KNOWN_TOP_LEVEL_KEYS)[number];

/** 这个键是不是已知的顶层键。用于写入前的白名单判定。 */
export function isKnownTopLevelKey(key: string): key is KnownTopLevelKey {
  return (KNOWN_TOP_LEVEL_KEYS as readonly string[]).includes(key);
}

/**
 * 按已知键清单重建配置对象，保留未知键。
 *
 * 与 `src/config.ts` 的 `migrateLegacyConfig` 不同：那个负责**迁移**旧形状
 * （`providers` / `provider` / `search` 等），这个只负责**保住**新顶层段。
 * 两者串行使用，顺序是「先迁移、再保键」。
 *
 * 为什么需要「保未知键」而不是纯白名单：用户可能手工在配置文件里写了
 * 扩展字段，卡片保存时不该把它们抹掉。真正要防的是**已知键被漏搬**，
 * 所以清单是硬约束，未知键则是宽容的。
 */
export function preserveTopLevelKeys<T extends Record<string, unknown>>(raw: T) {
  const out: Record<string, unknown> = {};
  for (const key of KNOWN_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(raw, key)) {
      out[key] = raw[key];
    }
  }
  // 未知键也保住：手工写的扩展字段不该在保存时消失。
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(out, key)) {
      out[key] = raw[key];
    }
  }
  return out;
}
