// Bind MCP servers to the DSH tool registry.
//
// Kept separate from protocol.ts so the wire format can be tested against a
// local fake with no Cordis in sight, and the binding can be reasoned about
// without the wire details.
//
// Two properties are load-bearing:
//
// 1. A server that cannot be reached must not stop the plugin from starting.
//    Search keeps working with no MCP at all, so a dead server is a missing
//    convenience, not a failed boot.
// 2. Every registration goes through ctx.tools.register, which is already tied
//    to the calling fiber. Nothing here needs to hold its own disposer list:
//    unloading the plugin removes the tools, and unloading a server mid-run
//    removes only that server's tools.
import type { McpConnection, McpServerConfig, McpToolSpec } from './protocol.ts';
import { McpConnection as Connection, isServerNameValid, publicToolName } from './protocol.ts';

/**
 * The output shape the DSH tool runtime accepts.
 *
 * `assertSupportedJsonSchema` only allows a small subset of JSON Schema, and
 * an MCP tool's result is an arbitrary content array. Wrapping it in this
 * record is what makes it registrable; the shape mirrors the host's own MCP
 * client so a tool looks the same whichever side registered it.
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

/** The reports, plus the one operation the caller must wire up. */
export interface McpRegistrationResult {
  reports: McpServerReport[];
  /** Close every session this registration opened. Idempotent. */
  closeAll: () => Promise<void>;
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
      // The key becomes part of the tool name, so an unusable key means
      // unusable tools. Say so instead of registering something half-named.
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
        ctx.tools.register({
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
          // Fanned-out search engines run concurrently; an MCP tool that
          // declares itself unsafe would serialize behind every other call.
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
        report.tools.push(name);
      }
      report.connected = true;
      // The connection stays open: the tools just registered will call it on
      // every use, and tearing the session down here would cost a fresh
      // handshake per tool call. The plugin fiber owns its lifetime — a
      // `ctx.effect` in the caller closes it on unload.
      keepAlive.push(connection);
      connection = undefined;
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      // A server that failed here registered nothing, so nothing needs
      // unwinding; the connection is closed below either way.
    } finally {
      if (connection !== undefined) {
        await connection.close().catch(() => undefined);
      }
    }
    reports.push(report);
  }

  return { reports, closeAll };
}
