import { builtinModules } from 'module';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts', 'scripts/changelog.mjs'],
      // Test scaffolding and the CLI entry are not unit-tested targets.
      exclude: ['**/*.test.*', 'src/testing/**', 'src/fixtures/**', 'src/main.ts'],
    },
    // 这几类文件跑的是真实子进程、真实计时或模块级缓存，按 CPU 核数无上限并发
    // 一起上会把彼此的计时顶过默认的 5 秒，报出来的是 STACK_TRACE_ERROR，
    // 看不出根因。它们各自单独跑都是绿的。并发上限压到 CPU 的一半，让这类
    // 文件有 CPU 可用，又不至于把整套测试拖成串行。
    maxWorkers: '50%',
    // 默认 5 秒对一个要 import 整条 CLI 或起子进程的用例不够。
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  build: {
    lib: {
      // Two entries: the CLI, and the MCP client the dsh plugin loads at run
      // time. The plugin half is hand-written JavaScript that cannot import
      // TypeScript, so the protocol implementation ships as its own built
      // module rather than being duplicated by hand.
      entry: {
        main: resolve(__dirname, 'src/main.ts'),
        'mcp-protocol': resolve(__dirname, 'src/mcp/protocol.ts'),
        'mcp-registry': resolve(__dirname, 'src/mcp/registry.ts'),
        // dsh/index.js 是手写 JavaScript，够不到 TypeScript 源码。配置的
        // 白名单键清单必须能从这里读，否则两个写入方（CLI 的白名单重建、
        // 卡片的整份回写）会各说各话。
        'config-schema': resolve(__dirname, 'src/config-schema.ts'),
        // 三宿主共同的子进程入口：dsh 与 Claude Code 都 spawn 它。
        kernel: resolve(__dirname, 'src/kernel.ts'),
        // 服务生命周期的唯一判据。单独成为一个 entry 是为了让验收脚本
        // 能直接 import 它（`import('./dist/serve-ensure.js')`），
        // 而不必绕经 CLI 的 commander 参数解析。
        'serve-ensure': resolve(__dirname, 'src/serveEnsure.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      // Externalize deps and every Node built-in (bare and node:-prefixed),
      // so adding a new built-in import can never silently bundle to undefined.
      external: [
        'commander',
        'undici',
        // 按平台分发的原生包：它用 optionalDependencies 只装本机那一个，
        // 其余平台的导入必然解析失败。打包它既没有意义，也会让构建在没有
        // 别的平台包时直接炸掉。
        '@searxng-js/searxng',
        '@searxng-js/linux-x64',
        '@searxng-js/win32-x64',
        '@searxng-js/darwin-arm64',
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
    },
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
  },
});
