# SearXNG 搭建

SearXNG 是"我还想要 Google 的索引"这个需求的答案。searchfuse 自己不去抓 Google、Bing 或百度：那些需要 TLS 指纹伪装和挑战求解器，而 SearXNG 维护的正是这一套。把 searchfuse 指向一个实例，那个实例启用的每个引擎就都通过一个适配器进来。

## 默认已经能用：随包实例

**不配置任何东西，`searxng` 引擎就已经可用。** `searxng.embedded` 默认开启：留空 `engines.searxng.baseURL` 时，searchfuse 在本进程里拉起一个随包的 SearXNG 实例，搜完即走（自动挑空闲端口、生成临时 `settings.yml`、并发健康轮询，闲置十分钟后回收）。代价只是首次冷启动要解包两三秒。

想用自己的实例、或想彻底关掉它：

```bash
searchfuse config set searxng.baseURL http://127.0.0.1:8888   # 用自己的
```

关掉随包实例只能**手改配置文件**（`config set` 的字段白名单里没有它，写了会报
`Unknown engine setting: embedded`）：

```jsonc
{ "searxng": { "embedded": false } }
```

填了 `baseURL` 就以它为准，`embedded` 不再起作用。

## 为什么要自己搭一个

随包实例适合"够用就行"。要自己搭的理由通常是：想让实例常驻、想用它自己的上游引擎组合与代理、或者想让多个工具共用同一个实例。

公开的 SearXNG 实例几乎总是对 `format=json` 返回 403，因为 JSON API 在它的 `settings.yml` 里是关的。所以不要随便填一个公共地址：要么指向你自己搭的实例，要么用随包实例。

## 起一个

```bash
mkdir -p searxng-config
docker run -d --name searxng-local --restart unless-stopped \
  -p 127.0.0.1:8888:8080 \
  -v "E:/path/to/searxng-config:/etc/searxng" \
  -e BASE_URL=http://127.0.0.1:8888/ \
  searxng/searxng:latest
```

Windows 上有三件事会绊人：

1. **路径转换。** Git Bash 会在 Docker 看到之前把 `/etc/searxng` 改写成 `D:/Program Files/Git/etc/searxng`，于是挂载悄悄落到空处，容器跑的是它内置的默认配置。在命令前加 `MSYS_NO_PATHCONV=1`，并用 Windows 风格的源路径。
2. **镜像源。** `docker.1ms.run` 解析到一个本机连不上的 CDN 主机；`docker.m.daocloud.io` 可用。
3. **验证挂载。** `docker exec <name> grep formats /etc/searxng/settings.yml` 必须显示出 `- json`。仓库自带的文件以"Read the documentation before extending the defaults"开头；如果你看到的是这句，说明挂载没挂上。

## settings.yml

```yaml
use_default_settings: true

server:
  secret_key: "change-me"
  bind_address: "0.0.0.0"
  port: 8080
  limiter: false          # 本地单用户实例没有东西需要限流

search:
  formats:
    - html
    - json                # 少了这一条，API 会返回 403

outgoing:
  request_timeout: 20.0   # 走代理时 Brave 实测 10.3 秒；3 秒的默认值会把它掐断
  max_request_timeout: 30.0
  proxies:                # curl_cffi 不认 HTTP_PROXY；这是它自己的开关
    all://:
      - http://host.docker.internal:10801

engines:
  - name: google cse
    disabled: false
```

## 实际能应答的引擎（本机实测）

| 引擎 | 走代理的结果 | 说明 |
|---|---|---|
| `google cse` | 20 条结果 | 可靠的 Google 通路；朴素的 `google` 引擎返回 403 |
| `bing news` | 20 条结果 | 朴素的 `bing` 返回 0 条——它的 HTML 解析器什么也没捞到 |
| `wikipedia` | 20 条结果 | |
| `google` | `access denied` | 反抓取 |
| `duckduckgo` | `CAPTCHA` | |
| `brave` | `too many requests` | |

所以有产出的配置是 `google cse` 加上那些垂类引擎，而不是旗舰引擎。这是 SearXNG 自己的维护状况，不是 searchfuse 能修好的。

## 接进 searchfuse

下面是**用自己的实例**的写法。用随包实例的话，这一段整个可以跳过。

```jsonc
{
  "engines": {
    "searxng": { "baseURL": "http://127.0.0.1:8888", "proxy": "direct" }
  },
  "aggregate": { "mode": "rrf", "deadlineMs": 30000 }
}
```

这里 `proxy: "direct"` 是对的：容器自己通过 `outgoing.proxies` 做代理，所以从 searchfuse 到 `127.0.0.1:8888` 的这一跳不能走系统代理。

`aggregate.deadlineMs` 需要从 8 秒的默认值往上调：一个 SearXNG 实例会向它自己那批引擎扇出，慢的那些要十秒以上。随包实例同样是这个道理，冷启动时尤其明显。

## 实测结果

下面这份是本机在 2026-11 的实测记录，**当时链上有 8 台引擎**（arXiv 尚未移除、
AnySearch 尚未加入）。现在是 10 台，数字会不同，但结论不变：一个 SearXNG
实例能让多个上游引擎的共识浮出来。

```
8 个引擎 → 64 条结果 → 9 条被多于一个引擎共同印证

[exa,firecrawl,keenable,youcom,searxng]  Rust Async Runtimes: Tokio vs async-std
[exa,firecrawl,keenable,youcom,searxng]  The State of Async Runtimes
[hackernews]                             Migrating from Go to Rust
```
