// Mod 内核的类型契约。
//
// 与 src/providers/index.ts 的 SearchEngine / EngineRequest 保持形状一致，
// 但只保留 HTTP 引擎需要的那部分：
//
// - 没有 buildInvocation / parseOutput：Mod 沙箱里没有子进程引擎。
// - 没有 Role 的三值（search/fetch/social）：Mod 只做搜索与抓取两件事。
//
// 形状对齐是刻意的：引擎实现从 src/providers/*.ts 拷过来时，函数体不需要改
// 类型标注。

/** 一次搜索或抓取请求。字段与 dsh 侧同名同义。 */
export interface EngineRequest {
  mode: 'search' | 'fetch';
  query?: string;
  url?: string;
  model?: string;
  maxResults?: number;
  extraPrompt?: string;
  workdir?: string;
  timeoutMs: number;
  settings: EngineSettings;
  /** 所有已配置的 API 密钥，保留它们只是为了让提供方错误能脱敏掉每一个同级密钥。 */
  apiKeySecrets?: readonly string[];
  /** 特定于某个引擎的附加数据。 */
  [key: string]: unknown;
}

/** 单个引擎的设置。与 src/config.ts 的 EngineSettings 对齐。 */
export interface EngineSettings {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  proxy?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** 引擎返回的结果。 */
export interface EngineOutput {
  result: unknown;
  meta: {
    conversationId: string | null;
    durationSeconds: number | null;
    usage: unknown | null;
  };
}

/** 用 $.http.fetch 发一次请求。返回形状对齐 dsh 侧各 provider 的用法。 */
export type HttpFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ status: number; ok: boolean; text: string }>;

/** 一个搜索引擎。与 src/providers/index.ts 的 SearchEngine 同构，去掉子进程字段。 */
export interface SearchEngine {
  name: string;
  /** 这个引擎能做搜索、抓取，还是两样都行。 */
  roles: ReadonlyArray<'search' | 'fetch'>;
  /** 其他地方都没指定时使用的模型。没有模型时缺省。 */
  defaultModel?: string;
  /**
   * 这个引擎现在可用吗？
   *
   * 签名与 src/providers/index.ts 保持一致（settings, env, role），
   * 即使 Mod 版只用 settings 前几个字段——引擎实现是拷来的，保持签名
   * 才能一字不改。
   */
  isAvailable: (
    settings: EngineSettings,
    env: Record<string, string | undefined>,
    role: 'search' | 'fetch',
  ) => boolean;
  /** 给人类看的一行：这个引擎要变得可用还缺什么。 */
  requirement: string;
  /** 进程内引擎的入口。 */
  execute?: (request: EngineRequest) => Promise<EngineOutput>;
}
