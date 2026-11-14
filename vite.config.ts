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
      },
      formats: ['es'],
    },
    rollupOptions: {
      // Externalize deps and every Node built-in (bare and node:-prefixed),
      // so adding a new built-in import can never silently bundle to undefined.
      external: [
        'commander',
        'undici',
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
