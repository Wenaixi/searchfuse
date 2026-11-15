---
summary: 'Testing Guide: Vitest usage, co-located layout, conventions'
read_when:
  - Running tests
  - Writing tests
  - Troubleshooting test failures
---

# Testing Guide

## Layout

Tests are co-located with sources: every module gets an adjacent `*.test.ts` (for example `src/search.ts` and `src/search.test.ts`, `src/providers/tavily.ts` and `src/providers/tavily.test.ts`). There is no separate `test/` directory. Vite's lib build only follows the import graph from `src/main.ts`, so test files never enter `dist/`.

## Commands

```bash
pnpm test                                   # run everything
pnpm exec vitest run src/xSource.test.ts    # run a single file
pnpm typecheck                              # tsc --noEmit, run before tests
```

## Conventions

- No network in unit tests. The HTTP engines (Tavily, Exa, Firecrawl, Keenable, You.com) are exercised by stubbing the global `fetch`, a page fetch runs against the loopback server from `startLocalPage`, and the `agy`/`grok` subprocess engines are replaced with fake CLIs that echo canned envelopes.
- To fake the home directory or PATH (grok availability checks), use `withTempHome` / `envWithBinaries` from `src/testing/helpers.ts`. They restore what they change. `withTempHome` redirects both `HOME` and `USERPROFILE`, because `os.homedir()` follows `HOME` on POSIX and `USERPROFILE` on Windows.
- Engines with subprocess transports test `buildInvocation` / `parseOutput` as pure functions, which run on every platform. The end-to-end route-and-fallback tests spawn a fake CLI through `runSearch`, and a fake CLI is a POSIX shell script, so those suites are gated on `SPAWNS_FAKE_CLI` and skipped on Windows.

## Platform coverage

`macos-latest`, `ubuntu-latest`, and `windows-latest` all run `pnpm typecheck && pnpm test && pnpm build` on Node 22 and 24. A few Unix-only suites are guarded so the Windows job stays honest rather than red:

- **Spawned fake CLIs** (`SPAWNS_FAKE_CLI`). modsearch runs engines with `spawn(bin, args)` and no shell, a deliberate security choice. On Windows only a real `.exe` is a runnable image by path: Node refuses to spawn a `.cmd`/`.bat` without `shell: true` (CVE-2024-27980), and a POSIX shell script is not executable there. A cross-platform fake would need a real `.exe` the tests cannot produce, so the suites that spawn `agy`/`grok` fakes run on Unix only. The in-process HTTP engines and all pure routing, config, and parsing logic still run on Windows.
- **SIGTERM/SIGKILL escalation** (`src/subprocess.test.ts`). Unix signal semantics: on Windows `child.kill` always calls `TerminateProcess`, so there is no ignorable SIGTERM to escalate from.
- **POSIX permission bits** (`expectPosixMode`). Windows models file access through ACLs, not rwx bits, so `stat.mode` never reflects a `chmod`. The assertion is a no-op there.
- **Hidden child consoles** (`src/spawnContract.test.ts`). The core and separately shipped dsh plugin each start children through one wrapper that writes `windowsHide: true` after caller options. The contract test also scans shipped source and fails if any other file reaches `child_process`, so a future provider cannot quietly bring the black console flash back to GUI hosts.

- Real `agy` / `grok` calls are end-to-end verification, not unit tests. They consume real quota, so keep them out of `pnpm test`.

## Proving a test can fail

A green test proves nothing until you have seen it red. Two cheap habits catch the common cases:

- **Mutate the implementation, not the test.** Break the exact line the test is meant to cover, run it, and confirm it fails. A test that stays green under the mutation is decorative. Revert the mutation afterwards and re-run to confirm green.
- **Assert on a quantity the wrong implementation cannot accidentally produce.** For cancellation, asserting "throws" is weak: a timeout throws too. Assert the elapsed time instead — with a 5 s timeout and a 50 ms abort, finishing under 2 s can only come from the abort. For cache and reload logic, assert the call count, not the return value.

A test double that is less capable than the real system silently skips whole paths. The `house()` stage in `src/dshPlugin.test.ts` returns a disposer from `tools.register` for exactly this reason: without it, the "dispose the old generation, then register the new one" path never runs, and hot-reload tests would pass against an implementation that never disposes anything. When a double cannot model a behaviour the production code depends on, extend the double rather than weakening the assertion.

## Hot reload

The plugin owns `~/.modsearch/config.json`, outside the host's profile, so the host's reload signal never fires for it. `watchModsearchConfigFile` polls its mtime every few seconds and both MCP tools and engine tools hang off that single watcher — one timer, because two watchers on one file let the two halves disagree briefly after a save.

Each reloader keeps its own signature and skips work when it is unchanged. The engine-tool signature covers only what decides *whether a tool exists*: raw name, engine, enabled, and custom tool name. API keys, proxies and base URLs are deliberately outside it, so rotating a key does not make tools flicker out of the list the user is looking at.

Tests drive this with `vi.useFakeTimers()` and `advanceTimersByTimeAsync`, which requires that the poll interval stay a plain `setInterval` rather than an `await new Promise(setTimeout)`.
