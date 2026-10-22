# dsh-topic-for-each-turn

适用于 DeepSeek Harness（`0.2.0-rc.2` 及同系列 `0.2.1-rc.1`）的 Host + Client 插件。为每个已结束的真实用户轮次自动或手动提炼 8–15 字主题标题、一句话结论详情、稳定事项标签（最多 2 项）及可选历史轮次关联（接着 / 回到 / 另探），并在原生右侧轮次刻度浮层与官方右侧栏面板中展示与管理。模型直接复用当前 DSH 已配置的服务商与凭证，插件不保存密钥。

## 加载性能（experimental.17）

打开面板的耗时几乎全部来自读取整个会话事件日志。本机实测一个长会话为 8450 个事件、22 MB 原始数据、28 个轮次：仅 `JSON.parse` 97 ms，结构克隆 137 ms，而旧实现每次打开要读**两遍**（分支继承检查一遍、提取轮次一遍），之后每 10 秒的空闲轮询还会重读。

现在的做法：

- **一次读取**：`state` 先取一份会话快照，分支继承检查与轮次提取共用它；`start`（自动生成、整理）同样只读一次。
- **令牌缓存**：以「活动会话 `seq` + 主题缓存文件大小/mtime」组成令牌，令牌不变时轮次提取结果直接复用。因此重新打开页签、编辑后刷新、悬浮刻度预览都不再读日志。
- **轮询变便宜**：客户端带上上次的 revision，命中时后台只回 `unchanged`；整理运行中只回传 `job` 进度（`jobOnly`），不重发全部条目。
- **逐轮校验改令牌**：整理时每轮生成后不再整读日志核对原文，令牌未变即视为未变；令牌变化才重读并丢弃过期结果。
- **页签保留**：注册 `keepMounted`，再次打开先显示上次内容，随后后台刷新。

限制：令牌依赖活动会话句柄，未打开的持久化会话仍需读取一次；首次打开一个很长的会话仍会有一次读取开销。

## 设置界面（experimental.16）

- 设置页按官方设置页的度量重做：20px 页面标题、分隔式卡片、36px 控件、标签在上/说明在下的字段排列、操作按钮底部右对齐，主操作只用一枚主色按钮。
- 按钮复用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `Button`（注入该客户端模块），悬停、聚焦环、禁用态与 DSH 自身设置页一致；该模块缺失时回退到内置按钮样式，功能不受影响。
- 模型卡片顶部用徽标显示当前生效的 `服务商 · 模型` 或「未配置」；未配置、只读、模型不在目录中、保存失败分别有对应提示，字段通过 `aria-describedby` 关联说明，状态区使用 `aria-live`。
- 全局整理并入同一套卡片：费用确认、进度（含已完成/跳过/总会话数）、停止与会话级错误列表，不再使用行内样式。
- 颜色、圆角、字号全部走 `--dsw-*` 主题令牌并带回退值，跟随 DSH 明暗主题。

## 增量整理、分支继承与全局并行（experimental.14）

- **分支继承**：依据官方 `session.parentSession`、`isSeeded`、`inheritedEventCount`，只复制继承前缀内已结束且内容指纹一致的轮次缓存。分支点之后的原会话内容、分支生成的中断闭合事件、子代理会话均不继承。保留有效标签、人工修改和可验证的历史关联；不覆盖分支已有条目，不随父会话后续编辑自动变化。创建分支时同步，打开已有分支/整理前也会补齐，整个复制过程不调用模型。
- **整理主题默认增量**：仅处理缺失或内容指纹已失效的轮次，跳过有效旧主题（包括尚无事项标签的旧缓存）及人工修改，连续点击不重复计费。不自动重新提炼全部历史轮次。
- **最多 3 个会话并行**：自动生成、手动整理、全局整理共享同一个并发上限；单会话仍按轮次顺序执行并去重。缓存写入按会话加锁；模型请求不持有文件锁。
- **设置 → 轮次主题 → 全局整理**：勾选费用/发送范围确认后，整理所有未归档普通会话与分支（包含持久化但未打开的会话，排除子代理），支持进度、停止和会话级失败列表。归档列表不可用时直接停止，不擅自扩大范围；处理前和每轮调用前再次检查归档状态。
- **停止与恢复**：保留已保存结果，取消时丢弃尚未完成请求的返回；全局停止不取消进入批次前已存在的手动任务。再次点击可补齐剩余项；全局任务队列与进度只存内存，重启后不会自动付费恢复。
- 模型和 Key 设置在批次排队或运行时禁止修改；Key 路线同步串行且只写变化项，模型请求可并发，不会把同步锁占用至请求结束。
- 使用当前安装 DSH `0.2.1-rc.2` 的官方会话/分支/归档源码核验契约；合成事件、临时缓存及 VM 界面测试通过不代表已完成真实桌面重启验收。

## DSH 0.2.1 适配（experimental.13）

- 版本要求改为 `engines.dsh: ">=0.2.0-rc.2 <0.3.0"`，两个 dsh peer 同步为同一范围。此前 peer 精确锁定 `0.2.0-rc.2`，而插件管理器在没有 `engines.dsh` 时逐个比对 `@deepseek-ai/dsh-*` peer（含预发布），于是 `0.2.1-rc.1` 被判定不兼容并阻断安装。现在同一 0.2 系列补丁版本不再需要逐次改清单。
- 页签种类注册补充 `priority: 'extension'` 与 `guide` 入口（引导页可直接打开本面板）。这些字段在 0.2.0-rc.2 上被忽略；若运行时拒绝未知字段，注册会退回 `{id, kind, title}` 三字段声明并记录一条警告，面板与头部入口照常可用，不再因注册失败导致整个客户端插件加载中断。
- 已核验 0.2.1-rc.1 保留本插件依赖的全部契约：`sessionId` 仍作为插槽 props 注入、`sidebar.right.pane.tab` 仍为 keyed 座位且 key 等于类型 `id`、插槽正文/标题经 `useTabInfo()` 读取、`settings.section` 仍为 list 座位、`settings.describe()`、`connection.register()` 与 `rpc.call()` 签名、`sessionQuery.readSession()`、`llm.stream()` 与 `BlockAssembler`/`createUserMessage` 导出、`data-chat-anchor-key` 锚点、`轮次导航` 的 `aria-label` + `aria-describedby` + `data-index` 结构均未变。
- 新增回归测试：页签注册字段与标题 key 一致、旧运行时拒绝未知字段时仍能挂载并打开面板、清单版本范围覆盖 0.2.0-rc.2 与 0.2.1-rc.1 且排除 0.3、bundle 补丁只注册一次、前后台版本号与 `package.json` 一致。

## 设置保存位置修正（experimental.12）

- 修复「Configuration for "topic-for-each-turn" is overridden by a home patch or command-line overlay」。该提示由 `dsh-config-editor` 拒绝写入产生：桌面 profile 的 `cordis.patch.yml` 用 `- insert:` 块插入本插件条目，而配置编辑器只改写顶层 `{id, config}` 行；它新增的行会被 insert 块遮蔽，于是抛出这条错误。条目并非被家目录补丁覆盖（`$DSH_HOME/cordis.patch.yml` 不存在）；`llm-pi-ai` 是顶层行，所以官方模型页写入正常。
- .12 起模型设置不再写插件自身 Config：保存到 `$DSH_HOME/storages/turn-topic-outline/model-settings.json`（临时文件原子替换、版本与取值范围校验），运行时以该文件覆盖 Config 默认值。设置界面仍由官方 `settings.section` 承载；服务商/模型列表只读官方 `llm-pi-ai`。
- 服务商目录按能力读取：旧 Host 用 `settings.get(ns)`，当前 Host 用 `settings.describe({redactSecrets:true})`；不再调用已移除的 `installSection`。Key 池仍写官方 `llm-pi-ai` 顶层条目。
- 自动测试覆盖该故障：设置服务对插件条目写入一律抛出上述错误时，插件仍能启动、注册 RPC、保存并回读模型设置，且不触发任何设置写入。

## 当前桌面设置兼容（experimental.11）

- 修复settings-state HTTP405：实际桌面ASAR里的settings已删除installSection/get，改为volatile Config和profile entry forms；.10在注册RPC前调用旧方法抛错，导致通道未挂载。此前检查的profiles/node_modules官方包是旧版本，不能代表Electron实际加载版本。
- .11按能力选择新旧官方读接口；新Host用describe({redactSecrets:true})读配置，旧Host保留命名空间读取。无另起服务、不改端口、不绕过认证。404/405给出后台接口未注册提示，不再归因模型或Key。
- 自动测试包含当前Host无get/installSection时启动/注册RPC/读取；真实桌面ASAR源码已核验，但不自动重启桌面，现有19387运行实例加载后的HTTP状态需重启后验收。

## 模型设置（experimental.10 起；experimental.15 移除 Key 管理）

- 配置入口在 DSH 官方「设置 → 轮次主题」，通过官方 `settings.section` 扩展注册。功能面板不出现模型表单。
- **直接复用你已经在 DSH 配好的模型**：服务商与模型列表读取官方 `llm-pi-ai` 条目，用的是 DSH 现有凭证。安装后打开设置页，选择服务商与模型并保存即可开始生成，不需要在本插件里再填 API Key。首次打开会预选第一个可用的服务商与模型，通常保存一次就能用。
- 设置持久化见上一节（experimental.12 起为插件自持文件），下一次主题调用生效，不修改聊天默认模型。
- experimental.15 移除了插件自带的 Key 池与 Key 管理界面（及其 `keys-*` 接口、`key-pool` 能力）。这部分依赖 DSH credentials 写入隔离路线，属于参考实现而非必要功能，公开版不再随包提供；多 Key 轮换需求请用 DSH 自身的模型路由解决。
- `finish:error` 只按标准 code / HTTP 状态显示安全原因，不输出上游原始错误消息（可能带凭证）。

## 核心功能与边界

- **官方插槽集成**：会话顶部工具栏提供「轮次主题」入口按钮，点击打开官方右侧栏标签页（`sidebar.right.pane.tab`）。
- **自动增量与手动整理**：
  - 新的 `turn/end` 事件自动入队生成当前轮次主题；打开历史会话或读取状态不会自动调用模型。
  - 面板顶部提供唯一主操作「整理主题」（运行中切换为「停止整理」），点击后按时间顺序补齐当前会话缺失或已失效的已结束轮次，跳过已有有效主题与人工修改。
  - 全局最多 3 会话并行，同一会话串行且自动去重，单轮默认 90 秒超时。失败或停止时保留原有有效缓存。
- **人工编辑与保护**：
  - 每轮右侧「⋯」菜单内提供「编辑」入口，支持修改主题标题（≤40 字符，建议 8–15 字）、结论详情（≤120 字符，建议 60 字内），并在折叠高级选项中修改事项标签（最多 2 项，单项 ≤16 字符）与历史关联。
  - 人工保存后的轮次标记为「已修改」，后续点击「整理主题」时自动跳过，不会覆盖人工修改内容。
- **输入截取与独立缓存**：
  - 仅提取每轮首条真实用户文本、末条含文本的 assistant 回复及结束原因；首尾保留截断默认上限 12000 字符，不读取附件或工具输出。
  - 缓存独立保存在 `$DSH_HOME/storages/turn-topic-outline/<sessionId>.json`，采用临时文件原子替换写入，不向 Session 事件日志写入任何数据。
- **定位跳转**：点击列表标题或关联标签时，先调用官方 `session.loadThrough(seq)`，再从 `uiConversation` chat target 获取 `anchorKey` 并滚动至对应轮次。
- **前后台版本兼容检测**：`state` 接口返回 `apiVersion`、`capabilities` 与 `hostVersion`。当前端检测到后台尚未加载新版接口时，仍可浏览已有缓存，但会禁用整理/编辑并提示完整退出并重开 DSH。

## 事项标签与轮次关联

- **单次调用与有限历史上下文**：每轮生成仅调用一次模型。启用 `continuity: true` 时，输入附带有限历史上下文（最近 6 轮有效摘要、用户显式提及的「第 N 轮」、最多 12 个已有事项的代表轮次，候选历史总计不超过 12 轮）。不发送全会话原文，不依赖向量库或跨会话检索。
- **宿主校验与白名单**：事项 ID 由宿主生成与复用；关联目标必须属于本次候选、早于当前轮次且类型属于 `continue` / `return` / `branch`。非法的辅助字段会被安全丢弃，不影响合法标题与结论的保存。
- **关联依据追踪**：记录被引用轮次的指纹与修订时间戳；若被引用轮次后续发生变化，界面隐藏失效关联并提示「关联依据已变化」，不会静默指向错误目标或触发后台级联重算。

## 原生刻度浮层适配

- 适配 `0.2.0-rc.2` 中英文轮次导航（`轮次导航` / `Turn navigation`），通过按钮完整无障碍标签解析真实轮次号，并以 `aria-describedby` 匹配唯一 tooltip，不依赖虚拟列表下标或混淆类名。
- 向浮层追加插件自有的非交互文本节点展示事项、标题、详情与关联；缺失/生成中/失败项保留原生预览并附状态说明。
- 可在面板右上角「设置」中随时关闭「原生刻度浮层显示主题」（状态保存在浏览器 `localStorage`），关闭或卸载插件后立即恢复原生浮层。

## 配置与隐私说明

启用插件后，新的用户轮次及手动点击「整理主题」时，会将截取后的本轮问答文本与少量历史摘要发送至你在设置页选择的模型服务。请确认该模型服务符合你的数据隐私要求。

**首次使用**：安装后打开 DSH「设置 → 轮次主题」，从下拉框选择本机已配置的服务商与模型，保存即可。未选择模型时插件仍会正常加载，只是不会生成主题。

默认配置不预设任何服务商或模型（`provider` 与 `model` 为空）。如果你想固定某个模型而不在界面里选择，可以在 profile 补丁中覆盖：

```yaml
- id: topic-for-each-turn
  config:
    provider: <your-provider-id>
    model: <your-model-id>
    reasoningEffort: low
    maxTokens: 1024
    continuity: true
    maxInputChars: 12000
    timeoutMs: 90000
```

包内 bundle 补丁负责唯一一次 `insert` 注册；profile 只按 `id` 覆盖配置，不要再复制包内的 `insert` 块。否则插件管理器在升级任何插件时可能报 `user-patch: duplicate loader entry id "topic-for-each-turn" (2 rows)` 并回滚。

- `provider` / `model`：留空则需在设置页选择；填写时必须是当前 DSH 已配置的模型路由。
- `continuity`：默认 `true`；设为 `false` 时仅根据单轮内容生成标题与详情，不发送历史摘要候选。
- `maxTokens`：默认 `1024`，用于容纳 JSON 结构的标题、详情、事项与关联字段。

插件不收集、不上传任何遥测；主题缓存只写本地 `$DSH_HOME/storages/turn-topic-outline`，不修改会话事件日志，不保存任何密钥。

## 构建与测试

环境要求：Node.js `>=24.0.0`，零第三方构建依赖（Host `peerDependencies` 由 DSH 运行时提供）。

```bash
# 语法检查并生成客户端产物 lib/client.js
npm run build

# 运行全部单元测试与契约测试（含分支、并行与全局整理）
npm test

# 打包本地安装归档
npm pack --ignore-scripts
```

## 安装与生效

从 GitHub 安装（推荐，无需本地构建：`lib/client.js` 已随仓库提供）：

```bash
dsh plugin --profile desktop add git+https://github.com/Pandasywithfantasy/dsh-topic-for-each-turn.git
```

也可从已克隆的本地目录或 `npm pack` 生成的 `.tgz` 安装：

```bash
dsh plugin --profile desktop add /path/to/dsh-topic-for-each-turn
dsh plugin --profile desktop add ./dsh-topic-for-each-turn-<version>.tgz
```

安装后**完整退出并重新打开 DSH**（仅刷新网页不会重载 Host 端 RPC 服务），再打开「设置 → 轮次主题」选择模型。

仓库不包含 `prepare` 脚本：仓库里的 `lib/client.js` 就是构建产物，因此 git 安装不会触发 pnpm 的构建白名单（`allowBuilds`）拦截。修改源码后请运行 `npm run build` 并提交 `lib/client.js`。


## 目录结构

```text
dsh-topic-for-each-turn/
├── src/
│   ├── index.js            # Cordis Host 插件入口、RPC 注册、事件监听与 LLM 流式调用
│   ├── core.js             # 轮次提取、原子缓存、分支继承、3 会话调度与人工编辑
│   ├── batch.js            # 未归档会话批次、归档检查、停止与进度
│   ├── batch-panel.js      # 设置页全局整理、费用确认与轮询
│   ├── continuity.js       # 有限历史上下文构建、事项 ID 归一化与关联校验
│   ├── llm-error.js        # 服务商失败的安全原因映射（不泄露上游消息）
│   ├── settings-panel.js   # 官方设置页：模型选择与保存
│   ├── settings-store.js   # 插件自持设置的原子读写与校验
│   ├── settings-bridge.js  # 官方 settings 读取的新旧接口兼容
│   ├── model-settings.js   # 复用 DSH 已配置服务商/模型目录
│   ├── client.js           # 官方右侧栏面板 UI、事项筛选与内联编辑交互
│   └── preview.js          # 原生轮次刻度浮层 DOM 适配器
├── lib/
│   └── client.js           # 构建生成的浏览器端插件入口（内嵌 preview 适配器）
├── scripts/
│   └── build.js            # 零依赖语法检查与客户端构建脚本
├── test/
│   ├── core.test.js        # 核心提取、校验、缓存与队列测试
│   ├── batch.test.js       # 全局整理、归档过滤、并发上限与取消
│   ├── inheritance.test.js # 分支继承边界与缓存保护
│   ├── continuity.test.js  # 脉络上下文、关联校验、重复整理与编辑保护测试
│   ├── contracts.test.js   # Host/Client 注册契约与版本兼容测试
│   └── preview.test.js     # 原生刻度浮层 DOM 适配与恢复测试
├── cordis.patch.yml        # DSH 插件启用与默认参数配置模板
├── package.json
├── LICENSE
└── README.md
```

## License

[MIT](./LICENSE)
