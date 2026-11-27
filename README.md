<p align="center">
  <img src="https://raw.githubusercontent.com/Wenaixi/searchfuse/main/assets/banner.jpg" width="100%" alt="SearchFuse" />
</p>

<h1 align="center">SearchFuse</h1>

<p align="center"><b>In the chat app your model can search the web. On the API it cannot. SearchFuse puts the web back: web search, X search, page fetch. Free, no signup, no API key.</b></p>

<p align="center"><b>The strongest free web search plugin for DeepSeek Harness (dsh)</b></p>

<p align="center">Engines: <b>Firecrawl</b> (keyless, default) · <b>Keenable</b> (keyless) · <b>AnySearch</b> (keyless) · <b>You.com</b> (keyless) · <b>SearXNG</b> (bundled) · <b>Tavily</b> · <b>Exa</b> · <b>Antigravity CLI</b> · <b>Grok (X)</b> · <b>local</b>, fused by default</p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="docs/troubleshooting.md">Troubleshooting</a> ·
  <a href="skills/searchfuse/references/configure.md">Configuration</a> ·
  <a href="skills/searchfuse/references/output-schema.md">Output contract</a> ·
  <a href="docs/security.md">Security</a> ·
  <a href="https://github.com/liustack/modlens">ModLens (vision)</a>
</p>

<p align="center">
  <a href="https://x.com/liustack"><img src="https://img.shields.io/badge/follow-%40liustack-black?style=flat-square&logo=x&logoColor=white" alt="Follow @liustack on X"></a>
  <a href="https://www.npmjs.com/package/@wenaixi/searchfuse"><img src="https://img.shields.io/npm/v/@wenaixi/searchfuse?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@wenaixi/searchfuse?style=flat-square" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/Not%20backed%20by-Y%20Combinator-FF6600?style=flat-square&logo=ycombinator&logoColor=white" alt="Not backed by Y Combinator">
  <img src="https://img.shields.io/badge/users-unknown-lightgrey?style=flat-square" alt="Users unknown">
</p>

Models like DeepSeek and GLM have no web access, or a weak one. SearchFuse is a plug-in that greatly strengthens web search, X search, and single-page fetch. It works the moment it lands: the default engine is Firecrawl's keyless tier, [1,000 free credits every month](https://www.firecrawl.dev/blog/firecrawl-keyless-launch), with no account, no API key, and no card.

## Talk to us

Hit a problem? [Open an issue](https://github.com/Wenaixi/searchfuse/issues/new/choose). Everything else is welcome on X: **[@liustack](https://x.com/liustack)**. What you built with it, which harness you are on, what should come next. New releases land there first. A community space is on the way.

## Features

- **The strongest free web search plugin for DeepSeek Harness (dsh):** one command installs it, `npx -y @deepseek-ai/dsh plugin --profile web add @wenaixi/searchfuse@0.1.1`. In the desktop app's Add plugin dialog, enter `@wenaixi/searchfuse`, not the GitHub URL. Details in [harness setup](docs/harness-setup.md#deepseek-harness-dsh).
- **Free out of the box, no signup.** Search and page fetch run on Firecrawl Keyless by default: [1,000 free credits/month](https://www.firecrawl.dev/blog/firecrawl-keyless-launch), no account, no API key, no card. Every fallback channel is free too: Keenable, AnySearch, and You.com each add a keyless pool, the bundled SearXNG instance needs no key at all, Antigravity CLI needs only a browser sign-in, and Tavily, Exa, and a free Firecrawl key each add their own monthly quota with no card required.
- **Fused search, not failover.** By default `web_search` asks every reachable engine at once and merges their ranked lists with reciprocal rank fusion, so an answer reflects several indexes and a page two engines agree on outranks one only a single engine liked. Set `aggregate.mode: chain` in `~/.searchfuse/config.json` for the old sequential behaviour.
- **Automatic failover.** When a channel fails or exhausts its quota, the next one takes over. Under fusion, one engine erroring costs only its own contribution; the rest of the answer stands and the failure is named in `uncertainty`.
- **Per-engine key rotation.** Give Tavily, Exa, Firecrawl, Keenable, or AnySearch multiple comma-separated keys. Authentication, rate-limit, and quota failures rotate to the next key before the engine chain falls back.
- **Every engine on its own leash.** Each engine can join the fused answer, become a standalone tool the model calls by name, do both, or be switched off — independently. Each can also take its own proxy, so one engine leaves the machine's proxy while the rest keep using it.
- **MCP servers become tools.** Point the plugin at any Streamable HTTP MCP server and its tools appear as `mcp__<server>__<tool>`, no separate plugin to install. Connections are made concurrently and a server that cannot be reached costs only its own tools.
- **Searches X (Twitter).** With Grok Build installed, SearchFuse queries the corpus that web indexes cannot reach.
- **Install once, use everywhere.** Works in Claude Code, Codex, Pi, and OpenCode.

## See it work

All four screenshots are unedited runs, the first two from the Codex desktop app and the last two from dsh web, driving DeepSeek models with no web access of their own.

Give it a blog link and ask what the post says. Twenty-five seconds later: a structured summary of the whole post, with no browser involved.

![Text-only DeepSeek summarising a blog link through SearchFuse](https://raw.githubusercontent.com/Wenaixi/searchfuse/main/assets/demo-codex-fetch.png)

Give it no target at all, just "anything interesting in AI today?". Thirty-six seconds later: six sourced stories, with a closing note on which details came from aggregation and deserve a second look. The note comes from the `uncertainty` field.

![An open-ended question comes back as six sourced stories with a stated confidence caveat](https://raw.githubusercontent.com/Wenaixi/searchfuse/main/assets/demo-codex-search.png)

Ask dsh web for today's top AI stories. dsh's native search tool row runs straight on the searchfuse engine chain, and eighteen seconds later three stories come back, each with a source link.

![dsh web's native search running on the searchfuse engine chain, returning three sourced stories](https://raw.githubusercontent.com/Wenaixi/searchfuse/main/assets/demo-dsh-web-search.png)

Ask which Node.js line is still in maintenance. `read_page` reads the release page and the release schedule in turn, and sixty seconds later the verdict arrives with a version status table and sources at the end.

![read_page reading two pages and returning the Node.js maintenance verdict](https://raw.githubusercontent.com/Wenaixi/searchfuse/main/assets/demo-dsh-web-fetch.png)

## Supported engines

Firecrawl, Keenable, AnySearch, You.com, and the bundled SearXNG work with zero setup. Every other engine is one command away. Keys live in `~/.searchfuse/config.json` (0600, masked when shown):

| Engine | Does | Free tier | Turn it on |
| :-- | :-- | :-- | :-- |
| Firecrawl (default) | web search + page fetch | keyless: 1,000 free credits/month, no signup. A free key adds your own 1,000/month | nothing, it works as installed |
| Keenable | web search | keyless: 1,000 requests/hour per IP (shared by everyone on that IP), no signup. A free key gives 100,000 requests/month of your own | nothing, it works as installed |
| AnySearch | web search | keyless: anonymous quota, rate-limited per IP. A free key lifts the rate limit; a rejected key falls back to the anonymous tier automatically | nothing, it works as installed |
| You.com | web search | keyless: 100 searches/day per IP (shared by everyone on that IP), no signup | nothing, it works as installed |
| SearXNG | web search (its own 70+ upstream engines behind one adapter) | free, bundled instance by default | nothing, it works as installed. Point it at your own instance with `searchfuse config set searxng.baseURL <url>` |
| Tavily | web search | 1,000 credits/month, no card | `searchfuse config set tavily.apiKey <key>` |
| Exa | web search | $10/month recurring credit (~1,400 searches), no card | `searchfuse config set exa.apiKey <key>` |
| Antigravity CLI | web search + page fetch | free, browser sign-in | off by default: install `agy`, sign in, then `searchfuse config set engines.antigravity-cli.enabled true` |
| Grok Build | X (Twitter) search | rides SuperGrok or X Premium | install `grok` and sign in |
| local | page fetch | built in, nothing to install | nothing |

Keys can also come from the environment (`TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `KEENABLE_API_KEY`, `ANYSEARCH_API_KEY`). One engine can take multiple keys as a comma-separated value such as `key-one,key-two`, in either the config file or its environment variable. Multiple engines configured means they run together and their results are fused. Every engine participates by default except `antigravity-cli`, which stays off until you turn it on with `searchfuse config set engines.antigravity-cli.enabled true` because it is too slow for a fusion budget. Exclude any engine with `searchfuse config set <engine>.enabled false`. Using a Tavily-, Exa-, Firecrawl-, Keenable-, or AnySearch-compatible third-party or self-hosted endpoint? Point the engine at it: `searchfuse config set tavily.baseURL <url>`. Official endpoints stay built into the code and are never written as default config. Every knob, engine by engine, is in the [configuration guide](skills/searchfuse/references/configure.md).

## Installation

**Step 1, hand it to your AI.** Search and page fetch work as soon as the skill lands, on Firecrawl's free keyless quota, so installation is one message:

> Install and configure the searchfuse skill following INSTALL.md at https://github.com/Wenaixi/searchfuse, then run the health check and tell me the result.

On DeepSeek Harness (dsh), send the same message. INSTALL.md recognizes dsh and switches to the native plugin instead of the skill, so dsh's own `web_search` runs on searchfuse. In the browser UI your AI installs it. The desktop app only takes plugins from its own window, so there your AI asks you to open **Plugins**, click **Add plugin**, and enter `@wenaixi/searchfuse`.

Prefer a direct command? Install the same skill through [skills.sh](https://skills.sh/):

```bash
npx skills add Wenaixi/searchfuse
```

**Step 2 (optional), add more free engines.** Antigravity CLI writes better synthesized answers. A free Tavily, Exa, or Firecrawl key adds a personal quota on top of the keyless one. None requires a card. agy's browser sign-in is the only step that needs your hands:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy                                                           # sign in, then exit
```

Picked a key instead? Send one line to your AI: "set my tavily key to tvly-...".

dsh users have a path that never touches the command line. Open **Plugins** in the dsh sidebar and pick `@wenaixi/searchfuse`: pick the preferred engine, fill in an API key or a self-hosted endpoint, tick which engines join failover, hit save and it takes effect. On dsh releases before 0.1.6-alpha.2 the same card lives under Settings → Plugins → Plugin config.

![The SearchFuse page in the dsh Plugins panel, shown in Chinese: pick the preferred engine, fill in an API key and endpoint, tick the engines that join failover](https://raw.githubusercontent.com/Wenaixi/searchfuse/main/assets/demo-dsh-settings-card.jpg)

## Usage

Once installed, you do not need to remember any commands. Just chat. Ask anything that needs checking, or paste a URL, and the skill triggers on its own: it picks an engine, runs the search or fetch, and the answer comes back with sources.

## Documentation

| Doc | Read it when |
| :-- | :-- |
| [INSTALL.md](INSTALL.md) | Installing the skill step by step (written for an agent) |
| [CLI manual](skills/searchfuse/references/cli.md) | The CLI the skill drives: flags, config, doctor |
| [Troubleshooting](docs/troubleshooting.md) | A command failed and the message needs decoding |
| [Configuration](skills/searchfuse/references/configure.md) | Setting a key, switching engines, fixing config |
| [Output contract](skills/searchfuse/references/output-schema.md) | Parsing the JSON or building on it |
| [SearXNG setup](docs/searxng-setup.md) | Running your own instance to reach Google's index |
| [dsh plugin](docs/dsh.md) | Installing, configuring, verifying, and updating the native dsh bundle |
| [Harness setup](docs/harness-setup.md) | Wiring it into Codex, Claude Code, OpenCode, or Pi |
| [Security](docs/security.md) | SSRF guards, DNS-rebinding protection, untrusted input |
| [Testing](docs/testing.md) | Running the suite or writing a test that can fail |
| [CHANGELOG](CHANGELOG.md) | Finding what changed in a version |

Proxy fake-IP mode (Clash, Clash Verge Rev, mihomo, Surge) works out of the box. DNS answers in `198.18.0.0/15` are treated as fake-IP placeholders with no switch needed. Literal URLs such as `http://198.18.0.5/` stay blocked when `allowPrivateNetwork` is off. For other reserved ranges used by VPNs or hosts-file accelerators such as Steam++ / Watt Toolkit, see [Blocked private network target](docs/troubleshooting.md#blocked-private-network-target).

## Contributing

This repo does not accept pull requests. The project is maintained by the author alone. Every line is reviewed in person, and that review is the premise of its reliability. Two effective ways to contribute:

- **[Open an issue](https://github.com/Wenaixi/searchfuse/issues).** Bugs, suggestions, confusing errors, unclear docs. Issues are read and shape what gets built next.
- **Fork it.** Under MIT your copy is fully yours to modify and publish.

## Shameless plug

Follow the WeChat official account **liustack** (Chinese-language): AI tools, practice, and ideas, posted as they land. Scan the code, or search WeChat for "liustack":

<p align="center">
  <img src="https://raw.githubusercontent.com/Wenaixi/searchfuse/main/assets/wechat-qrcode.png" width="420" alt="WeChat official account liustack" />
</p>

If it helps, star [SearchFuse](https://github.com/Wenaixi/searchfuse). Stars are how the next developer finds it.

## Star History

<a href="https://www.star-history.com/?repos=Wenaixi%2Fsearchfuse&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Wenaixi/searchfuse&type=date&theme=dark&legend=top-left&sealed_token=ymc92zQxHuDgpexZjaqDbEhMCuCjGHskpQGkzkwwrU0FksWoq5MasrMA64y9G2CxNV9O3EFeRjKneWSDYmHH4HWjpUiaAme0haCp-1Y72cRmHDv8coW35A" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Wenaixi/searchfuse&type=date&legend=top-left&sealed_token=ymc92zQxHuDgpexZjaqDbEhMCuCjGHskpQGkzkwwrU0FksWoq5MasrMA64y9G2CxNV9O3EFeRjKneWSDYmHH4HWjpUiaAme0haCp-1Y72cRmHDv8coW35A" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Wenaixi/searchfuse&type=date&legend=top-left&sealed_token=ymc92zQxHuDgpexZjaqDbEhMCuCjGHskpQGkzkwwrU0FksWoq5MasrMA64y9G2CxNV9O3EFeRjKneWSDYmHH4HWjpUiaAme0haCp-1Y72cRmHDv8coW35A" />
 </picture>
</a>

## Disclaimer

SearchFuse is MIT-licensed, so use is not restricted. The author gives no warranty and no endorsement for any particular use, commercial or otherwise. The upstream engines it drives (Antigravity CLI, Tavily, Exa, Firecrawl, Keenable, You.com, Grok Build) each carry their own terms and quotas, and complying with them is the user's responsibility.

## License

MIT
