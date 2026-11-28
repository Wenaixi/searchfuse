---
name: Bug report
about: A command failed, or an engine returned something wrong
title: ""
labels: bug
assignees: ""
---

<!--
Run `searchfuse doctor` first: it reports Node version, each engine's readiness
with the reason, where every config value came from, and which engines are
cooling. Most error messages already name their own fix.
-->

## What happened

A clear description of the problem.

## The exact command

Paste the command you ran, verbatim (redact any API keys):

```bash
searchfuse ...
```

## The complete error or output

Paste the full stderr/stdout, not a paraphrase. Include the `Known engines:`
line the CLI prints, and `results[].engine` from the JSON when a run succeeded
but answered wrong.

```
(full output here)
```

## Environment

- `searchfuse --version`:
- Node version (`node --version`):
- OS (macOS / Linux + version):
- Which engine you expected (agy / firecrawl / keenable / youcom / tavily / exa / grok-cli / local):

## Anything else

Config (with keys masked, from `searchfuse config show`), whether a VPN or proxy
is active, or anything else that might matter.

---

Not sure it is a bug? Open an issue here and describe the situation: it gets read
even when the cause is unclear.
