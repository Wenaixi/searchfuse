# 三宿主功能对等矩阵

> 状态：待实现（本文件由 CI 断言，未实现的格子标记 `TODO(<阶段>)`）
> 关联 spec：`docs/superpowers/specs/2026-11-21-searchfuse-tri-host-design.md` §十 S6
> 日期：2026-11-21

## 判定规则

每格只能是以下三种之一：

| 写法 | 含义 | CI 检查 |
|---|---|---|
| `<测试文件>::<测试名>` | 有等价实现，且有测试 | 文件必须存在，且该测试名必须出现在文件里 |
| `N/A: <理由>` | 宿主不支持 | 理由必须是 §十 白名单里的一条 |
| `TODO(S<n>)` | 尚未实现 | 阶段 S6 完成前允许，之后视为失败 |

**CI 断言**：不允许空单元格；不允许 `TODO(...)` 在 S6 完成后的主分支上。

不支持理由白名单（只有这三种）：

1. `宿主无此 API`
2. `宿主强制命名空间不同`
3. `宿主无对应 UI`

## 矩阵

| 能力 | dsh | Claude Code | omp |
|---|---|---|---|
| 搜索（聚合） | TODO(S3) | TODO(S4) | TODO(S5) |
| 搜索（单引擎强制） | TODO(S3) | TODO(S4) | TODO(S5) |
| 引擎开关（`engines.*.enabled`） | TODO(S2) | TODO(S2) | TODO(S2) |
| 聚合模式（`aggregate.mode` rrf/chain） | TODO(S3) | TODO(S4) | TODO(S5) |
| 引擎顺序（`engine` 首选） | TODO(S3) | TODO(S4) | TODO(S5) |
| 结果缓存 | TODO(S3) | TODO(S4) | TODO(S5) |
| 冷却（`cooldown`） | TODO(S3) | TODO(S4) | TODO(S5) |
| X 语料（`x_search`） | TODO(S3) | TODO(S4) | TODO(S5) |
| 网页阅读（`read_page`） | TODO(S3) | TODO(S4) | TODO(S5) |
| 单引擎独立工具 | TODO(S3) | TODO(S4) | N/A: 宿主无此 API（`SearchProviderId` 封闭枚举） |
| MCP：context7 | TODO(S2) | TODO(S4) | TODO(S5) |
| MCP：grep | TODO(S2) | TODO(S4) | TODO(S5) |
| 配置热更新 | TODO(S3) | TODO(S4) | N/A: 宿主无对应 UI（`fs.watch` 只监视自身 config） |
| 设置卡片 UI | TODO(S3) | N/A: 宿主无对应 UI（mod 无内置卡片渲染） | N/A: 宿主无对应 UI |
| 引擎失败诊断 | TODO(S1) | TODO(S1) | TODO(S1) |
| 服务不可达时的降级 | TODO(S3) | TODO(S4) | N/A: 宿主无此 API（无 provider 回退链） |

## 已知语义损失（不是「不支持」，是「有损」）

这三项在 omp 侧会丢信息，与「不支持」分开记录：

| 能力 | dsh / Claude Code | omp | 原因 |
|---|---|---|---|
| 聚合耗时（`durationSeconds`） | 服务返回真实墙钟 | 不可见 | omp 的 SearXNG 解析器不读该字段 |
| RRF 融合分数 | 可见 | 不可见 | 同上 |
| 引擎失败列表 | 可见 | 仅 `unresponsive_engines` | omp 只认这一种形状，其余丢弃 |

## 变更记录

- 2026-11-21：创建骨架，全部标记 TODO，等待 S1–S5 落地后填充。
