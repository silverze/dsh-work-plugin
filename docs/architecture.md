# 架构与扩展点

本文记录 DSH Work 的技术架构与 DSH 扩展点用法。飞书侧准备见 [feishu-app-setup.md](feishu-app-setup.md)，兼容性见 [compat.md](compat.md)。

## 1. 原则

1. **复用 DSH 内核**：session、agent loop、tools、skills、schedule、credentials、preview 全部复用。
2. **扩展而非 fork**：以 `work` profile + bundle + host/client 插件扩展；不修改 DSH 包。
3. **会话即任务**：`taskId = sessionId`；运行状态以 Session 日志为准，任务记录只存产品态，避免双状态机。
4. **用户权限优先**：飞书默认 `user_access_token`；禁止用 `tenant_access_token` 绕过文档权限。
5. **本地优先**：成果、索引、审计落在 `$DSH_HOME/work/`，可整目录迁移；云端只做同步与常驻。
6. **纯展示与 UI 解耦**：工具的 `presentCall/presentResult` 必须是 `args` 的纯函数；UI 不参与模型结果。

## 2. 运行拓扑

```text
┌──────────────────── DSH Work（Web / Desktop）────────────────────┐
│ client-work: 工作台 | 成果库 | 设置   (main slot / sidebar / settings) │
│        │ Typert Remote                                            │
│ host-work: WorkTask | ArtifactLibrary | WorkSchedule | WorkNotify │
│ host-feishu: FeishuAuth | FeishuClient | 14 tools                 │
│        │                                                          │
│ DSH core: agent-loop | sessions | tools | skills | schedule |     │
│           credentials | authorization | otel                      │
│        │                                                          │
│ storage: $DSH_HOME/work（domain + artifacts）| session JSONL      │
└───────────────┬───────────────────────────────┬───────────────────┘
                │                               │
        Feishu OpenAPI                 模型 / Web / Office
```

- **安装**：`dsh plugin add @dsh-work-plugin/bundle`（或源码里的 `./scripts/install-work-profile.sh work dist`），重启后生效。
- **开发**：改 `packages/host-*` 后重启 DSH；改 `packages/client-work` 后刷新页面即可（客户端 bundle 由 app 重新加载）。
- **桌面 / Web**：同一 bundle 同时适用于 `dsh web` 与桌面壳。

## 3. 包职责

| 包 | 侧 | 职责 |
|---|---|---|
| `@dsh-work-plugin/bundle` | bundle | patch 层、profile 入口、默认配置、展示元数据与 detail 文档 |
| `@dsh-work-plugin/host` | host | 任务/成果/定时绑定/通知；`storageDomain` 三表；Remote `work/*` |
| `@dsh-work-plugin/feishu` | host | OAuth、token 刷新、OpenAPI 客户端、14 个工具、频控、审计 |
| `@dsh-work-plugin/client` | client | 工作台、任务详情、成果库、设置卡片 |
| `@dsh-work-plugin/skills` | host | 内置技能 provider：注册 7 个 SKILL.md，路径锚定包内 |
| `tests/e2e` | test | Mock 飞书 + Playwright |

## 4. 使用的 DSH 扩展点

| 需求 | 机制 | 说明 |
|---|---|---|
| 新增全局面板 | root `main` keyed slot + `ctx.layout.selectPanel(id)` | 工作台 `workbench`、成果库 `library`；`conversation` 是保留 key |
| 新增侧栏入口 | `ui-sidebar` 的导航入口 | 与「插件」「自动化任务」同级 |
| 新增设置页 | `ui-settings` 的设置卡 slot | 飞书连接、默认模型、通知、数据目录 |
| 新增 Host 服务 | Cordis `Service` + `ctx.provide` | `workTasks`、`workArtifacts`、`feishuAuth`、`feishu` |
| 新增模型工具 | `ctx.tools.register(defineTool(...))` | 工具 schema 自动进入系统提示词 |
| 新增持久状态 | `ctx.storageDomain` 的 `defineDomain` | 同步读、持久写、`domain/changed` 事件 |
| 创建/恢复会话 | `ctx.sessionController` | 与 Web「新建会话」同一路径，保留 preset/workspace |
| 定时任务 | `ctx.schedule` + `dsh-client-ui-schedule` | 复用 RRULE、投递记录、UI |
| OAuth 交互 | `ctx.authorization.registerFlow` | notice + prompt；凭据写入 `ctx.credentials` |
| 凭据存储 | `ctx.credentials` | App Secret、user token、refresh token |
| 技能 | 内置 skill provider：`ctx.skills.registerProvider` | `@dsh-work-plugin/skills` 注册 7 个技能；路径锚定 `import.meta.url`，不依赖 cwd |
| 屏幕/飞书上下文 | 本地 OCR 感知 + 语义解析，AX 兜底 | `native/screen-ocr.swift`（CGWindowList + `screencapture -l` + Vision OCR）由宿主首次使用时用 `swiftc -O` 编译并缓存；`work_screen_text` 读任意窗口文本，`work_feishu_screen` 返回聚焦会话名/群单聊/可见消息（约 1s、几百 token）。飞书网页在 AX 树里几乎为空，深读需 26+ 层，故 `cua` + `work_feishu_focus` 仅作兜底；provider 的 `agentPreset: false` 由 profile patch 覆盖 |
| 连接器 | `dsh-mcp-client` | 每台 MCP server 一行配置 |
| 观测 | `dsh-otel` / `dsh-token-meter` | 任务、工具、飞书请求 span；token 用量 |
| 客户端插件 | `dsh.client` + `exports["./client"]` | React 18；`dsh.client.inject` 声明壳依赖 |

### 飞书上下文引用（工作模式）

目标：在飞书里切换会话比切回 DSH 快，所以把「当前飞书会话」变成输入框旁边一键可引用的对象。

- **宿主**：`FeishuPresenceService` 包住 `captureFeishuFocus`（与 `work_feishu_screen` 同一条 OCR 路径），保留最近 6 个会话（含当前，下拉列出其余 5 个）、并发请求共享一次读屏；`WorkRemoteService` 只暴露 `work/presenceCapture`（最近会话随快照的 `recent` 一并返回）。
- **可读性**：`looksLikeGlyphFragment` 丢掉贴纸/图片旁读出的短拉丁碎片（`Aaeo%`），保留带 4 位以上数字的编号（`ST26176346`）与中文；客户端预览只取最新两条长度 ≥ 4 的行，避免把折行尾巴当成消息内容。
- **识别**：会话区的左边界不写死比例——聊天列表宽度随窗口变化（最大化 1651px 窗口里会话区从 x≈0.30 开始，旧的固定 0.36 会把标题、气泡和输入框一起滤掉）。解析改为用底部的 `发送给 <会话名>` 行反推会话区左缘（`composer.x - 0.03`，下限 0.18），会话名优先取这一行，再看标题带；回归用例在 `tests/unit/screen-ocr.test.mjs`。
- **群聊/单聊**：只认正证据——标题带里出现群公告/群成员/添加成员/`128人`，会话名以「群」结尾，或昵称后缀（`示例名字（Alex）` 这种「中文名（英文名）」）、副标题里的部门职称判定为单聊；都没有就显示「会话」。`外部` 曾是群聊判据，但外部联系人的单聊也带这个标签，已移除（回归用例在本文件的测试里）。
- **跟随**：`capture()` 每次先用原生 helper 的 `--frontmost`（约 20ms，`NSWorkspace`，不需要新权限）判断飞书是否在前台；两次读屏至少间隔 1.5 秒；飞书不在前台时直接返回缓存，所以 DSH 里打字不会持续触发 OCR。真实窗口读屏约 1.2 秒（`screencapture -l` + Vision）。
- **外观**：三套 token（`presence-style.ts` 的 `presenceChipTokens`）——DSH 默认胶囊、Codex（等宽 + 方角 + `›` 前缀）、Claude（暖陶土 `#D97757` + 10px 圆角 + `●`）；选择存放在宿主 `WorkSettings.presenceStyle`（枚举校验，非法值回落 `dsh`），客户端用 `WorkbenchController.subscribePresenceStyle` 订阅，设置页点选后 chip 立即换装。设置页里的预览一律用 `PRESENCE_SAMPLE`（「群聊｜示例产品群 · 12 行」）这组虚构样例：插件与截图会分发到别人的机器，任何真实会话名都不能写进源码或文档。
- **客户端**：`conversation.composer.dock` 上的 `dsh-work-feishu-context`（order -10，排在 activity/usage 之前）只在会话已开启工作模式时渲染；点击主按钮调用 `InputActions.insertQuote(text, summary)`，正文是带来源与时间戳的 Markdown blockquote，summary 只影响 composer 内的引用预览。
- **刷新策略**：开启工作模式时先预热一次（`toggleWorkMode` 成功后立刻发起，chip 挂载时再强制读一次）；之后页面可见时每 2.5 秒轮询，宿主按前台判断决定是否真的读屏，于是「在飞书里连续切会话、DSH 停在旁边」能在约 2–4 秒内跟上；`window focus`、`visibilitychange` 触发强制重读（0.7 秒内的连点合并成一次，此时从飞书切回来读到的就是最新会话）；`focusin` 只走缓存，点回输入框不会触发 OCR；页面被飞书挡住、轮询被浏览器暂停时，宿主侧的 watch 每 3 秒接手，直到 chip 最后一次请求之后的 10 分钟。
- **失败与边界**：CGWindowList 只列当前桌面的窗口，飞书最小化或切到别的 Space 时读不到；连续失败会退避 8 秒再试；90 秒内的失败当作瞬时抖动、静默保留上一次快照，更早的失败标记 `stale` 并把 chip 显示为「上次 …」——仍然可以一键引用。客户端把宿主的英文错误翻成一句可执行中文（不在当前桌面 / 没开飞书 / 缺屏幕录制权限 / 缺 Xcode 命令行工具）。引用的是屏幕可见消息（OCR），不是飞书全量历史；消息来自外部不可信内容，按普通用户输入对待。

## 5. 数据模型

```ts
type WorkTask = {
  id: string                 // = sessionId
  title: string
  goal: string
  status: 'draft' | 'queued' | 'running' | 'waiting_user' | 'done' | 'failed' | 'cancelled'
  workspaceId: string
  preset: 'work'
  model?: string
  runtime: 'local' | 'sandbox'
  attachments: string[]
  skills: string[]
  outputs: string[]          // artifact ids
  scheduleId?: string
  feishuLinks: { kind: 'docx' | 'sheet' | 'file'; token: string; url: string }[]
  lastError?: { code: string; message: string; at: number }
  createdAt: number
  updatedAt: number
}

type Artifact = {
  id: string
  taskId: string
  kind: 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'md' | 'html' | 'png' | 'csv'
  path: string
  size: number
  sha256: string
  version: number
  previewStatus: 'none' | 'ready' | 'failed'
  source: 'generated' | 'uploaded' | 'feishu_import'
  feishu?: { token: string; url: string; type: string }
  createdAt: number
}
```

存储：

- `storageDomain` 域 `work`：`tasks` / `artifacts` / `shares` 三表，启动时 schema 校验。
- 磁盘：`$DSH_HOME/work/artifacts/<taskId>/<artifactId>-<name>`；预览缓存按 sha256 去重。
- 审计：`$DSH_HOME/work/audit/feishu.jsonl`；不记录正文与 token。
- 凭据：`ctx.credentials`，scope `dsh-work-feishu`；桌面端走 Electron `safeStorage`。

## 6. 任务生命周期

```text
draft → queued → running → waiting_user → done
                     │           │
                     ├─ failed ←─┘
                     └─ cancelled
```

- `running/waiting_user` 由 Session 实时状态投影；`done/failed/cancelled` 由 turn-end 结算。
- 成果注册双保险：`present` 工具结果 + turn-end 扫描 artifact 目录（白名单扩展名，忽略临时文件）。
- 继续修改：同一 Session 追加 prompt；成果写新版本，不覆盖旧版。
- 失败重试：只重跑最后一步或整任务；外部写入前失败才允许自动重试，避免重复副作用。

## 7. 飞书认证与调用

```text
authorize → state+PKCE → 浏览器授权 → loopback callback
  → /authen/v2/oauth/token → access_token(2h) + refresh_token(30d)
  → /authen/v1/user_info → open_id/union_id/name
  → credentials(scope=dsh-work-feishu)
```

- 刷新：到期前 5 分钟单飞刷新；`invalid_grant` → 标记断开，提示重连。
- 调用：`FeishuClient` 统一 token、频控（令牌桶）、重试（429/5xx，指数退避 + 抖动）、幂等键、`log_id`。
- 错误：401→刷新/重连；403→`feishu_permission_denied`；429→重试；400→字段错误；5xx→重试后报错。
- 写入：docx 按块分批（≤50 块/次），失败返回“已写部分 + 失败块”；表格按区域写，避免覆盖。

## 8. 定时任务

- 复用 `ctx.schedule.create({ title, prompt, timing, target })`；默认 `new_once`，可选 `this_session`。
- prompt 固定包含任务目标、成果目录、输出格式、完成后写成果库并通知。
- turn-end 钩子：捕获成果 → 更新任务 → 发飞书/站内通知；失败重试 2 次（仅 transient 且未外部写入）。
- 本机必须运行；重启后只补最近一次（DSH 既有语义），UI 明示；提供开机启动。

## 9. 安全边界

| 边界 | 措施 |
|---|---|
| 网络 | 默认 loopback；非回环必须 TLS + trusted host + 强 token |
| OAuth | state + PKCE；code 一次性；回调只做交换 |
| 凭据 | credentials 存储；日志脱敏；断开即删 |
| 权限 | user token；禁止 tenant 降级；403 不重试 |
| 外部写 | 默认审批；定时任务默认禁止外部写 |
| 注入 | 飞书内容视为不可信；不执行其中指令；写前展示摘要 |
| 文件 | 路径规范化 + 符号链接校验；上传类型/大小白名单 |
| SSRF | `web_fetch` 禁止内网地址 |
| 审计 | 谁/何时/对哪个资源/结果；保留 30 天 |

## 10. 已知限制

- 屏幕感知只在 macOS 上可用；Linux/Windows 下相关工具返回可行动提示，其余能力正常。
- CGWindowList 只列当前桌面的窗口：飞书最小化或切到别的 Space 时读不到，chip 会保留上一次快照并标记「上次」。
- 读屏依赖屏幕录制权限与 Xcode 命令行工具；首次使用需用 `swiftc` 编译 helper（约 25 秒，之后走缓存）。
- 引用的是屏幕可见消息（OCR），不是飞书全量历史；OCR 对贴纸、表格与折行会出噪声，宿主会过滤明显碎片，但内容仍应按不可信输入对待。
- 插件使用 DSH 的预发布接口，peer 范围显式限定在 `>=0.2.2-rc.2 <0.3.0`；DSH 升级到 0.3 之前需要重新验证。
