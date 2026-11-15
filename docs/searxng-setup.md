# SearXNG setup

SearXNG is the answer to "I want Google's index too". modsearch does not scrape
Google, Bing or Baidu itself: those need TLS fingerprint impersonation and
challenge solvers, and SearXNG maintains exactly that. Point modsearch at an
instance and every engine the instance enables arrives through one adapter.

## Why an instance is needed

A public SearXNG instance almost always answers 403 to `format=json`, because
the JSON API is off in its `settings.yml`. There is therefore no default host:
`engines.searxng.baseURL` must be set, and without it the engine reports
"not ready" rather than failing at search time.

## Starting one

```bash
mkdir -p searxng-config
docker run -d --name searxng-local --restart unless-stopped \
  -p 127.0.0.1:8888:8080 \
  -v "E:/path/to/searxng-config:/etc/searxng" \
  -e BASE_URL=http://127.0.0.1:8888/ \
  searxng/searxng:latest
```

Three things trip people up on Windows:

1. **Path conversion.** Git Bash rewrites `/etc/searxng` into
   `D:/Program Files/Git/etc/searxng` before Docker sees it, so the mount
   silently lands nowhere and the container runs on its built-in defaults.
   Prefix the command with `MSYS_NO_PATHCONV=1` and use a Windows-style source.
2. **Image source.** `docker.1ms.run` resolves to a CDN host this machine cannot
   reach; `docker.m.daocloud.io` works.
3. **Verifying the mount.** `docker exec <name> grep formats /etc/searxng/settings.yml`
   must show `- json`. The stock file opens with "Read the documentation before
   extending the defaults"; if that is what you see, the mount missed.

## settings.yml

```yaml
use_default_settings: true

server:
  secret_key: "change-me"
  bind_address: "0.0.0.0"
  port: 8080
  limiter: false          # a local single-user instance has nothing to rate limit

search:
  formats:
    - html
    - json                # without this the API answers 403

outgoing:
  request_timeout: 20.0   # Brave measured 10.3s through a proxy; 3s cuts it off
  max_request_timeout: 30.0
  proxies:                # curl_cffi ignores HTTP_PROXY; this is its own knob
    all://:
      - http://host.docker.internal:10801

engines:
  - name: google cse
    disabled: false
```

## What actually answers, measured here

| Engine | Through the proxy | Note |
|---|---|---|
| `google cse` | 20 results | The reliable Google path; the plain `google` engine returns 403 |
| `bing news` | 20 results | Plain `bing` returns 0 — its HTML parser yields nothing |
| `wikipedia` | 20 results | |
| `google` | `access denied` | Anti-scraping |
| `duckduckgo` | `CAPTCHA` | |
| `brave` | `too many requests` | |

So the productive configuration is `google cse` plus the vertical engines, not
the flagship engines. That is SearXNG's own maintenance situation, not
something modsearch can fix.

## Wiring it into modsearch

```jsonc
{
  "engines": {
    "searxng": { "baseURL": "http://127.0.0.1:8888", "proxy": "direct" }
  },
  "aggregate": { "mode": "rrf", "deadlineMs": 30000 }
}
```

`proxy: "direct"` is right here: the container does its own proxying through
`outgoing.proxies`, so the request from modsearch to `127.0.0.1:8888` must not
take the system proxy.

`aggregate.deadlineMs` needs raising from the 8s default: a SearXNG instance
fans out to its own engines, and the slower ones take 10s or more.

## Measured result

```
8 engines → 64 results → 9 corroborated by more than one engine

[exa,firecrawl,keenable,youcom,searxng]  Rust Async Runtimes: Tokio vs async-std
[exa,firecrawl,keenable,youcom,searxng]  The State of Async Rust: Runtimes
[arxiv]                                  Modular Responsiveness Verification
[hackernews]                             Migrating from Go to Rust
```
