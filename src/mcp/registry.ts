// 把 MCP 服务端绑定到 DSH 的工具注册表。
//
// 与 protocol.ts 分开，是为了让线格式可以在不含任何 Cordis 痕迹的本地
// 假服务端上测试，而绑定逻辑也能在不牵扯线格式细节的情况下推敲。
//
// 有两条承重性质：
//
// 1. 连不上的服务端绝不能阻止插件启动。没有 MCP，搜索照样工作，所以一个
//    死掉的服务端只是少了一项便利，不是启动失败。
// 2. 每次注册都走 ctx.tools.register，它本来就绑在调用方的 fiber 上，
//    所以卸载插件就会移除这些工具，本模块无需自己维护一份清单。但清理
//    句柄仍然会被收集并返回，因为插件要监视配置文件、在服务端设置于运行中
//    变更时替换它的工具：整条 fiber 级的拆除对这种粒度来说太粗了。
import type { McpServerConfig, McpToolSpec } from './protocol.ts';
import { McpConnection as Connection, isServerNameValid, publicToolName } from './protocol.ts';

/**
 * DSH 工具运行时接受的输出形状。
 *
 * `assertSupportedJsonSchema` 只允许 JSON Schema 的一小部分子集，而 MCP
 * 工具的结果是任意的内容数组。把它包进这个记录里才使它可注册；这个形状
 * 照抄宿主自己的 MCP 客户端，好让同一种工具无论由哪一侧注册看起来都一样。
 */
export const MCP_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
  },
  required: ['content'],
  additionalProperties: false,
} as const;

/** Flatten the text blocks of an MCP result into the text a model reads. */
export function extractText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }
  return content
    .map((block) => {
      if (typeof block === 'string') {
        return block;
      }
      const record = block as { type?: unknown; text?: unknown };
      if (record.type === 'text' && typeof record.text === 'string') {
        return record.text;
      }
      return '';
    })
    .filter((line) => line !== '')
    .join('\n\n');
}

export interface McpRegistration {
  /** The tool name the model sees. */
  name: string;
  /** The server's own spelling, used for the actual call. */
  rawName: string;
  serverKey: string;
}

/** What one server contributed, for the diagnostics surface. */
export interface McpServerReport {
  serverKey: string;
  url: string;
  connected: boolean;
  tools: string[];
  /** Why the server contributed nothing, when it did not. */
  error?: string;
}

export interface RegisterMcpOptions {
  /** Server key to config. Keys must already be known-good. */
  servers: Record<string, McpServerConfig>;
  /** Per-server tool allow-list. Absent means every advertised tool. */
  allowTools?: Record<string, string[]>;
  /** Override the derived tool name, keyed by `<serverKey>/<rawName>`. */
  toolNames?: Record<string, string>;
  /** Names already taken by built-in tools; a collision is refused. */
  reservedNames?: readonly string[];
  logger?: (message: string) => void;
}

/** The reports, plus the two operations the caller must wire up. */
export interface McpRegistrationResult {
  reports: McpServerReport[];
  /** Close every session this registration opened. Idempotent. */
  closeAll: () => Promise<void>;
  /**
   * Remove every tool this registration added. Separate from `closeAll` so
   * a config change can drop the tools, then register again, without the
   * caller reaching into host internals.
   */
  disposeTools: () => void;
}

/**
 * Register every enabled server's tools on the context.
 *
 * Returns one report per server so the plugin can tell the user what happened
 * without a failed start. Numbers and wording are deliberately per-server:
 * "context7 needs a key" and "grep is not reachable" are different repairs.
 */
export async function registerMcpServers(
  ctx: { tools: { register: (definition: unknown) => unknown } },
  options: RegisterMcpOptions,
): Promise<McpRegistrationResult> {
  const reserved = new Set(options.reservedNames ?? []);
  const claimed = new Set<string>(reserved);
  const reports: McpServerReport[] = [];
  /** Connections kept open for the registered tools, closed by the caller. */
  const keepAlive: Connection[] = [];
  /** Undo functions for the tools registered this pass. */
  const disposeTools_ = [] as Array<() => void>;
  let closed = false;
  const closeAll = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await Promise.all(keepAlive.map((c) => c.close().catch(() => undefined)));
  };

  for (const [serverKey, server] of Object.entries(options.servers)) {
    if (server.enabled === false) {
      continue;
    }
    const report: McpServerReport = {
      serverKey,
      url: server.url,
      connected: false,
      tools: [],
    };

    if (!isServerNameValid(serverKey)) {
      // 这个键会成为工具名的一部分，所以不可用的键等于不可用的工具。
      // 明说出来，而不是注册一堆半成品的名字。
      report.error = `server key "${serverKey}" must match [A-Za-z0-9_-]{1,32}`;
      reports.push(report);
      continue;
    }

    let connection: Connection | undefined;
    try {
      connection = new Connection(server);
      const advertised = await connection.listTools();
      const allowed = options.allowTools?.[serverKey];
      const eligible = advertised.filter(
        (tool: McpToolSpec) => allowed === undefined || allowed.includes(tool.name),
      );

      for (const tool of eligible) {
        const overrideKey = `${serverKey}/${tool.name}`;
        const name = options.toolNames?.[overrideKey] ?? publicToolName(serverKey, tool.name);
        if (claimed.has(name)) {
          report.error = `tool name "${name}" is already taken; skipped`;
          continue;
        }
        claimed.add(name);
        const toolConnection = connection;
        const registered = ctx.tools.register({
          name,
          description:
            tool.description ?? `Tool ${tool.name} provided by the MCP server "${serverKey}".`,
          parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<
            string,
            unknown
          >,
          output: {
            schema: MCP_OUTPUT_SCHEMA,
            render: (_args: unknown, value: unknown) => [
              {
                type: 'text',
                text:
                  extractText((value as { content?: unknown } | undefined)?.content) ||
                  '(no content)',
              },
            ],
          },
          // 扇出的搜索引擎是并发跑的；一个声明自己不安全的 MCP 工具
          // 会排在其他所有调用后面串行执行。
          isConcurrencySafe: () => true,
          async execute(args: unknown, exec: { signal?: AbortSignal }) {
            if (exec?.signal?.aborted) {
              throw new Error(`MCP call ${tool.name} was cancelled before it started.`);
            }
            return toolConnection.callTool(
              tool.name,
              (args ?? {}) as Record<string, unknown>,
            );
          },
        });
        if (typeof registered === 'function') {
          disposeTools_.push(registered as () => void);
        }
        report.tools.push(name);
      }
      report.connected = true;
      // 连接会保持打开：刚注册的工具每次使用都会调用它，在这里拆除会话
      // 会让每次工具调用都付出一次重新握手的代价。生命周期由插件的 fiber
      // 负责——调用方的一个 `ctx.effect` 会在卸载时关闭它。
      keepAlive.push(connection);
      connection = undefined;
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      // 走到这里的失败服务端什么都没注册，所以没有需要回滚的东西；
      // 无论哪种情况，下面都会把连接关掉。
    } finally {
      if (connection !== undefined) {
        await connection.close().catch(() => undefined);
      }
    }
    reports.push(report);
  }

  const disposeTools = (): void => {
    for (const undo of disposeTools_) {
      try {
        undo();
      } catch {
        // 已经消失的工具不值得当成错误上报。
      }
    }
    disposeTools_.length = 0;
  };
  return { reports, closeAll, disposeTools };
}
