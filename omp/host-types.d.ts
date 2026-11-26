// omp 宿主类型的最小声明。
//
// `@oh-my-pi/pi-coding-agent` 由 omp 运行时提供，本地不安装（也装不上：
// 它跟宿主版本绑死）。没有这份声明，`tsc --noEmit` 一碰到 extension.ts 就
// TS2307，于是整个仓库的类型门禁没法把这一层纳进来。
//
// 只声明这个扩展真正用到的成员。多写一个就等于替宿主承诺了一件没验证过的事；
// 少写一个会在编译期当场报错，比运行时才发现好。

declare module '@oh-my-pi/pi-coding-agent' {
  /** zod 风格的最小形状：只覆盖 `.object()` / `.string().describe()`。 */
  interface ZodLike {
    describe(text: string): ZodLike;
  }

  interface ZodObjectLike {
    [key: string]: unknown;
  }

  interface ZodApi {
    object(shape: Record<string, ZodLike>): ZodObjectLike;
    string(): ZodLike;
  }

  interface ToolSpec {
    name: string;
    label: string;
    description: string;
    parameters: ZodObjectLike;
    loadMode?: 'essential' | 'deferred';
    approval?: 'read' | 'write';
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
  }

  interface ExtensionAPI {
    zod: ZodApi;
    registerTool(spec: ToolSpec): unknown;
  }
}
