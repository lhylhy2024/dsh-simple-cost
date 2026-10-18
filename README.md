# dsh-simple-cost

DeepSeek Harness 的**账户余额 + 本会话计费**挂件。

> A DeepSeek Harness widget that keeps your account balance in the sidebar, shows the running cost of the
> current conversation, and offers a one-click AI breakdown of any single turn that burns more than a
> configurable token threshold. Peak / off-peak pricing is applied per the official DeepSeek price list.
> No dependencies beyond DSH itself.

## 它显示什么（三个落点）

| 落点 | Slot | 内容 |
|---|---|---|
| **侧栏底部「用户栏正上方」** | `sidebar.footer.action` | ① 账户余额（`¥` / `$`，含赠送余额）② 时段徽标：**高峰时段** / **空闲时段** 四个字 ③ 距下次切换的分钟数，如「90 分钟后转为高峰时段」 |
| **会话页底部居中的信息条** | `conversation.composer.dock` | 本会话累计花费，如「本会话 ¥1.2345」。累计 token 与轮数由 DSH 自带的 `ContextMeter` 显示，本插件不再重复 |
| **每一轮回答的动作行** | `conversation.chat.assistant-actions` | ① 紧跟「用量 xxM tok」之后的「· 本轮对话约 ¥0.1234」② 排在「存入记忆 / 开新分支」之后的「AI 分析」按钮（自绘 **A** 图标），本轮总 token ≥ 阈值时才出现 |

设计取向：**侧栏卡片只留「余额 + 时段」两行**，所有与本会话/单轮有关的信息都放进对话流本身，避免同一份数字在两处重复。

## 计费口径

依据 DeepSeek 官方价目表（本插件内置版本戳 `PRICE_VERSION = 2026-09-10`，抓取日期 2026-10-13）：

```
cost = 命中输入/1e6 × P_hit + 未命中输入/1e6 × P_miss + 输出/1e6 × P_out
```

- `P_*` 由 **(模型, 高峰|空闲)** 决定；**空闲价 = 高峰价 × 50%**（官方是两套并列的价目表，不是折扣）。
- **高峰时段** = 北京时间**周一至周五（不含中国法定节假日）09:00–12:00 与 14:00–18:00**；其余全部空闲，**含周末全天与法定节假日全天**。
- 缓存写入（`cacheWriteTokens`）官方没有独立单价，本插件按**未命中输入**计价。
- 思考 token（`reasoningTokens`）计入输出计费——官方页面只分输入命中/未命中/输出三档，未单列思考价。
- **CNY 与 USD 是两套独立价目表**，按余额接口返回的 `currency` 选表，不做汇率换算。
- 时段归属按**该轮开始时间**判定。

内置价目表（元 / 百万 tokens）：

| 模型 | 命中·空闲 | 命中·高峰 | 未命中·空闲 | 未命中·高峰 | 输出·空闲 | 输出·高峰 |
|---|---|---|---|---|---|---|
| deepseek-flash | 0.02 | 0.04 | 1 | 2 | 4 | 8 |
| deepseek-v4-pro | 0.15 | 0.30 | 4.5 | 9.0 | 13.5 | 27.0 |

> 价格与时段规则由 DeepSeek 单方面调整，且**价目表页面本身不印生效日期**。所以它们在本插件里是**常量而非硬编码在逻辑中**，改价只需改 `index.js` 顶部的 `PRICES` / `HOLIDAYS` 并把 `PRICE_VERSION` 往后挪。价格变动不在界面上做提醒。

## 架构（为什么逻辑在 Host 半边）

浏览器半边拿不到这些数据：

- **逐轮 token 用量**只存在于 Host 的会话日志里（`ctx.sessions.get(id).snapshotEvents()`）；客户端只能看到被压缩改写过的窗口。
- **账户钱包**要经 `ctx.deepseekAccount`（其文档明确「only Host consumers can obtain a request credential」）。
- **AI 分析**要跑 `ctx.llm.stream`；而客户端 Remote 面的 `llm` namespace 只暴露 `discoverModels` / `listProviders` / `listConfigurableProviders`，**没有任何生成接口**。

而 DSH 的客户端 Remote namespace 集合是**构建期固定**的（`dsh-api-remotes` 里逐个显式导入并 `$mount`），第三方插件**无法注册自己的 namespace**。所以本插件走第三条路：

```
浏览器半边 client.js  ──fetch 同源──▶  Host 半边 index.js 注册的两条回环路由
                                        GET  /dsh-simple-cost/state?sessionId=
                                        POST /dsh-simple-cost/analyze
```

这与 `dsh-client-modules` 把自己的 bundle 挂在 `webServer` 上是同一条路。路由只接受回环地址（`127.0.0.1` / `::1`）。

**会话 id 的来源**：注册在会话作用域 slot（`conversation.composer.dock` / `conversation.chat.assistant-actions`）里的组件，其标准属性自带 `sessionId`。页面 URL 里既没有 token 也没有会话 id（首页会 303 跳回 `./`），所以不依赖 URL。

## 依赖

**除 DSH 本身外没有任何依赖。**

- `package.json` 没有 `dependencies` / `peerDependencies` / `optionalDependencies` / `devDependencies` 字段。
- `index.js`（Host 半边）**没有任何静态 import**——`@deepseek-ai/*` 只存在于 app.asar 内，从工作区目录静态导入会 `ERR_MODULE_NOT_FOUND`。全部依赖经 `ctx.get()` 软取：`inject` 里只有硬依赖 `webServer`，`credentials` / `deepseekAccount` / `sessions` / `sessionPersistence` / `llm` 缺失时各自降级。
- `client.js`（浏览器半边）只 `require("react")` 与 `require("react-dom")`（后者仅用于 `createPortal`），两者都来自 DSH 客户端自己的冻结模块表；不 import 任何 `@deepseek-ai/*` 包。
- 唯一的外部网络目标是 `https://api.deepseek.com`（你自己的 DeepSeek 账户接口），可用环境变量 `DEEPSEEK_BASE_URL` 覆盖。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：余额读取、事件流折叠成逐轮计费（含 `messageIds` → 轮次映射）、峰谷判定、AI 分析、两条 HTTP 路由。**无任何静态 import** |
| `client.js` | 浏览器半边：侧栏卡片 + 会话信息条 + 逐轮行 + AI 分析面板 |
| `cordis.patch.yml` | bundle patch：把 Host 半边插入 profile |
| `package.json` | `dsh.bundle.patch` + `dsh.client`（`platform: web`）声明 |

## 已知限制

- 余额优先走官方公开接口 `GET https://api.deepseek.com/user/balance`（能区分充值/赠送余额、CNY/USD 多币种）；取不到时回退到 DSH 自己的平台钱包读取，该路径没有赠送余额拆分。
- 高峰/空闲的归属时刻按**该轮开始时间**判定（官方未说明按开始还是结束计费）。
- 法定节假日表内置到 2026 年（国务院办公厅国办发明电〔2025〕7 号）。跨年需要补表。
- 调休上班的周末仍按**空闲**计价——官方规则只说「周一至周五（不含中国法定节假日）」，未提调休。
- 会话日志里的 `reasoningTokens` 若某轮没有上报，则该轮按 0 计——这与官方「思考按输出价计费」的口径一致，不会重复计价。
- **AI 分析的成本上限是「思考 + 正文」的总量**：`deepseek-flash` / `deepseek-v4-pro` 官方默认开思考模式，思考 token 也计入 `maxTokens`。实测 `maxTokens=1200` 时整份预算被思考吃光（`finish.reason.kind === 'max-tokens'`），只回思考不回正文；现已改为 `6000`，并且即便正文为空也会把思考内容作为降级结果返回。
- 逐轮费用与实际账单存在**极小的四舍五入差**（每一轮独立取整到 4 位小数后再求和）。

## 安装

本插件**不在 npm 上发布**（npm 上同名的 `dsh-deepseek-balance` 是另一个作者的另一个插件，与本项目无关）。安装方式二选一：

**① 从本仓库安装**——克隆到本地任意目录，然后让 DSH 按目录安装：

```
git clone https://github.com/lhylhy2024/dsh-simple-cost.git
plugin_manager { action: "install_bundle", target: "<克隆下来的绝对路径>" }
```

**② 从插件市场安装**——本插件正在提交至 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表；被收录后即可在 DSH 内置的插件市场（`dshmarket`）里一键安装，无需手动克隆。

安装后刷新页面即可看到三处落点。改 `client.js` 后刷新页面即可生效；改 `index.js`（Host 半边）需要重启 DSH 进程。
