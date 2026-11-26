# SearchFuse 设置卡片重构设计

> 状态：已实施。本文档是当时的**设计决策记录**，不是现状说明；实现如果已经演进，以代码为准。

日期：2026-11-22
范围：`dsh/client.js`（浏览器半边）、`dsh/index.js`（卡片数据面）、`src/config.ts`（三态语义）
目标：视觉可用性修复 + 交互逻辑重构 + SearXNG 三态端到端验证

## 一、问题诊断（有证据）

### P1. 样式整体失效（截图 `screenshots/sf.png` 实测）

现象：表单在动漫壁纸上裸奔，行块无底色无描边，页脚跑到页面中部，下方 1000px 空壁纸。

根因：`CARD_CSS` 中 28 处 `var(--dsw-*)` 只有 2 处写了 fallback。CSS 自定义属性解析为空时，
整条声明被丢弃，因此：

- `background: var(--dsw-alias-card-fill)` → 无底色
- `border: 0.5px solid var(--dsw-alias-border-l4)` → 无描边
- `color: var(--dsw-alias-label-primary)` → 继承色，壁纸下不可读

设计文档 F1 已记录：token 挂在 `body` 上，`documentElement` 上取到空串。卡片渲染位置若不在
body 的 token 作用域内（portal、shadow root、或被宿主 scoped 主题类隔离），全部 token 落空。

结论：**不能假设 token 一定存在**。必须给每个消费点写 fallback，且 fallback 必须是可读的实色。

### P2. 三态语义三方分裂（严重逻辑缺陷）

| 位置 | 表达式 | 空白配置下的答案 |
| --- | --- | --- |
| `src/config.ts:866` | `embedded !== false` | **开**（引擎可用） |
| `dsh/index.js:1011` | `embedded === true` | **关**（下发 false） |
| `dsh/client.js:402` | `undefined ? 'off' : 'embedded'` | **关**（显示关闭） |

后果一：全新用户打开卡片看到「关闭」，但运行时 `isAvailable` 认为内置实例可用。卡片撒谎。

后果二：`dsh/index.js` 的 `searxngEmbedded: false` 分支执行 `delete searxngBase.embedded`，
而 `config.ts` 的默认是「未写 = 开」。所以**用户点「关闭」实际关不掉**，切到「外部」时
内置实例也仍在运行。这是功能性 bug，不只是显示问题。

### P3. 交互逻辑问题

- 所有引擎同时展开，8 个引擎 × 多个字段平铺，首屏极长（截图证实）
- `editTarget` 与 `engine`（首选）分离是对的，但 UI 上没有任何视觉引导说明两者的区别
- 保存失败只有页脚一句话，字段级错误无法定位
- 上游引擎 60 条分段 + 内部滚动是对的，但缺乏「当前生效值 vs 文件值」的区分

## 二、设计决策（自决，不咨询）

### D1. 样式韧性：三层 fallback 链路

每个 token 消费点写成 `var(--dsw-X, var(--sf-own-X, <字面实色>)`，其中：

- 第一层：宿主 token（首选）
- 第二层：插件自有的、通过 `.sf-root` 上的自定义属性定义的语义色
- 第三层：字面值兜底

`.sf-root` 内置一套暗色实底基线（`#0a0a0a` / `#121212` / `#1f1f1f` / `#fafafa`），
按用户全局 CLAUDE.md 的「深色模式基准：真纯黑阶梯」取值。这样即使宿主 token 全空，
卡片仍是「纯黑底 + 细描边 + 高对比文字」，不会在壁纸上裸奔。

同时：`.sf-root` 上显式 `background` + `color`，把继承链斩断，不再从壁纸继承颜色。

### D2. 双主题探测保持，但只用于原生控件

现有 `parseCssColor` / `cardThemeIsDark` 逻辑保留，用于 `<select>` 的 `colorScheme`。
新增的插件自有 token 只提供暗色基线；若探测到浅色宿主，改用浅色基线。

### D3. 三态语义统一为单一真源

**统一口径：`searxng.embedded` 未写 = 开（与 config.ts 一致）。**

- `dsh/index.js:1011` 改为 `config.searxng?.embedded !== false`
- `dsh/client.js` 的 `searxngModeOf` 改为：有 baseURL → `external`；否则 `embedded !== false` → `embedded`；否则 `off`
- 前端 `searxngEmbedded` 草稿字段由 `searxngMode` 推导，不再独立维护（消除第二真源）

写盘修正：

- 切到 `off` → 写 `embedded: false`（显式关闭，而不是 delete）
- 切到 `embedded` → 写 `embedded: true`
- 切到 `external` → 写 `embedded: false` + `baseURL`

这样三种状态在文件里都留下明确痕迹，`isAvailable` 不会再与 UI 打架。

### D4. 交互重构：从「全平铺」到「分段 + 渐进披露」

保持已验证有效的部分（分段布局、定高滚动上游清单、统一显式保存），改进三处：

1. **引擎区域**：每个引擎一行（名字 + 就绪点 + 开关 + 展开箭头），点开才显示该引擎的
   密钥/端点/模型/代理/露出形态。一次只展开一个（`editTarget` 已经是单值，正好对应）。
2. **首选引擎**：从引擎行上的「设为首选」按钮切换，而不是顶部独立下拉框。
   下拉框保留在「搜索策略」段，但加一行提示说明它与展开编辑的区别。
3. **字段级错误**：`savePayload` 失败时，后端返回的 `error` 若含字段名，页脚显示的同时
   高亮该字段（`.sf-field-error`）。后端契约不变，只做前端解析。

### D5. 状态总览保留并强化

三枚 `StateDot` 保留，但每枚加 tooltip 说明详情来源。当 doctor 不可用时显示 `ongoing`
而不是假装有答案。

## 三、验收标准

| 编号 | 标准 | 验证方式 |
| --- | --- | --- |
| A1 | token 全空时卡片仍可读 | 单元测试：解析 CARD_CSS，断言每个 `var(--dsw-` 都有 fallback |
| A2 | 空白配置下三处语义一致 | 测试：`embedded` 未写时，index.js 下发 true、client 显示 embedded、config.ts 认为可用 |
| A3 | 关闭后文件里存在 `embedded: false` | 测试：切 off 后读文件断言 |
| A4 | 外部模式带 baseURL 且 embedded=false | 测试：切 external 后读文件断言 |
| A5 | 引擎行默认折叠，点开才见高级字段 | 测试：渲染默认 draft，断言高级字段不在树里 |
| A6 | 全量测试通过 | `pnpm test` |

## 四、不做的事

- 不引入新依赖
- 不自绘开关/标签（继续用宿主 primitives）
- 不改后端 API 契约形状（只改 `embedded` 默认值口径）
- 不重写已经工作良好的 `savePayload` 差异提交逻辑
