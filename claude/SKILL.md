---
name: searchfuse-mod
description: 用 searchfuse 的聚合搜索替换 Claude Code 原生 WebSearch，并补上 x_search 与 read_page。免 key 开箱即用，多引擎并发后按倒数排名融合。
---

# searchfuse-mod

这个目录同时是一个 Claude Code mod 的载体。mod 本体是
`hooks/register.ts`，它做三件事：

- 在 `tool.call` 上接管内置 `WebSearch`，用 searchfuse 的聚合结果回答；
  任何一步失败都交回宿主原生实现，不让用户因为插件坏了而失去搜索。
- 在 `session.start` 上注册 `x_search` 与 `read_page` 两个工具，
  全名会被宿主补成 `mcp__searchfuse__x_search` / `mcp__searchfuse__read_page`。
- 读 `~/.claude/settings.json` 的 `searchfuseHosts`，拿运行时的
  `runtime.json` 与 `dist/kernel.js` 两条绝对路径（mod 沙箱里 `~` 不展开）。

## 为什么放在这里

`~/.claude/skills/<name>/` 里的目录会作为 `@skills-dir` 插件被自动加载，
每个会话都生效，不需要 `--plugin-dir`。这是 mod 的用户级常驻路径。

**本目录是唯一真源**：`~/.claude/skills/searchfuse-mod/` 里那份由
`searchfuse hosts sync` 从这里复制过去。改代码要改这里，不要改装好的那份，
否则下一次 sync 会把你的改动覆盖掉。

## 依赖

- 引擎产物在同仓库的 `dist/`：`kernel.js`（搜索）与 `main.js`（CLI）。
- 共享配置在 `~/.searchfuse/config.json`，与 dsh、omp 共用同一份。
- 两条绝对路径由 `searchfuse hosts sync` 写进 `settings.json`。
- mod 优先走 `searchfuse serve --daemon` 写在 `~/.searchfuse/runtime.json`
  的 HTTP 服务，服务不在时退回 spawn `kernel.js`。

## 关闭

`searchfuseHosts.claudeCode.enabled = false` 即可。`register.ts` 在每次
`tool.call` 读这个开关，关掉后一律 `next(e)` 交回原生实现，**不需要**
卸载目录；重新开启也只是改回 `true`。

## 排障

`claude plugin validate <这个目录>` 会打印读到的 hook 与 `$` 调用清单。
看不到 `hooks:` 行就说明 `hooks/hooks.json` 的 `modules` 没被识别。

确认真的加载了 mod，看 debug 日志里的这一行：

```
hooks module searchfuse@skills-dir loaded (worker, environment 1, tier user); events: tool.call,session.start
```

日志必须用 `--debug-file <path>` 生成；`--debug=hooks` 的层级不同，会把
这一行滤掉，造成「没加载」的假象。
