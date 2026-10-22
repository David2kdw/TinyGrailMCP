# TinyGrailMCP

在 Windows 本地运行的小圣杯 MCP 应用，让 ChatGPT 查询市场、角色和账户，并在本地逐笔确认游戏操作。

- **市场探索**：每周萌王、往期萌王、通天塔、英灵殿、幻想乡、ICO、ST、上市角色、股息/市值/涨跌榜、精炼榜、番市首富、最新圣殿和 LINK。
- **角色查询**：名称搜索、批量行情、股东、买卖盘、历史行情、个人委托与成交、圣殿、LINK 和奖池。
- **账户管理**：资产、持股、圣殿、ICO、拍卖、道具、资金流水、红包记录、股息及圣殿收益估算。
- **本地审批**：限价与冰山委托、撤单、拍卖、ICO 发起/投资、献祭建塔与升级、融资、星之力、精炼、魔法、圣殿编辑/连接/拆除、图片上传、奖励及红包。

写权限默认关闭。MCP 只能创建计划，实际执行必须由你在 Windows 管理界面批准。GM 接口不接入。写入适配器经过隔离模拟测试，尚未进行真实账户写入验收。

## 环境要求

- Windows 10/11，PowerShell，Node.js **22.18 或以上**。
- 可访问 TinyGrail、Bangumi、npm、GitHub 和 OpenAI 的出站 HTTPS 网络。
- 已开通小圣杯的 Bangumi 账号。
- 使用 ChatGPT 时，需要添加自定义 MCP 的权限和 OpenAI Secure MCP Tunnel 权限。

每位使用者在自己的电脑安装，并使用自己的游戏账号、Tunnel 和 API Key。

## Windows 安装

下载本仓库 ZIP 并解压，或用 Git 克隆后，在项目目录运行：

```powershell
.\scripts\Install.ps1
.\scripts\Start.ps1
```

也可双击 `Install.cmd`、`Start.cmd`。安装脚本会安装锁定的 npm 依赖、构建程序、下载 Playwright Chromium 和官方 Windows Tunnel 二进制，并校验发布方 SHA256。

若 PowerShell 阻止脚本运行，可仅为当前进程执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install.ps1
```

无需管理员权限。启动后打开本地控制台；关闭页面不会停止后台程序。再次运行 Start 可重新打开管理页面。

## 首次登录与配置

1. 在控制台点击“打开登录窗口”，在独立浏览器完成 Bangumi 登录及 TinyGrail 授权。
2. 点击检查登录，确认账户资料能够读取。
3. 在本地控制台配置 Tunnel；游戏 Cookie 和 API Key 分别使用 Windows DPAPI 加密保存在当前用户目录。

默认运行数据目录为 `%USERPROFILE%\.tinygrailmcp`，兼容 Microsoft Store 版 PowerShell。开发时可通过环境变量 `TG_DATA_DIR` 指定独立目录。该目录包含登录状态、运行令牌、交易计划和日志，应保留在本机。

旧版数据位于 `%LOCALAPPDATA%\TinyGrailMCP`：升级前先用旧版停止管理器，然后将该目录移动至 `%USERPROFILE%\.tinygrailmcp`；目标目录已有数据时不要覆盖。

## 配置 OpenAI Secure MCP Tunnel

1. 在 [OpenAI Platform Tunnel 设置](https://platform.openai.com/settings/organization/tunnels) 创建 Tunnel。创建或编辑需要 **Tunnels Read + Manage** 权限。
2. 为运行客户端准备独立的 Restricted API Key，授予 **Tunnels Read + Use**。Tunnel 还需关联目标 ChatGPT 工作区或账号。
3. 在本地控制台输入 Tunnel ID 和该 Key，点击“加密保存配置”，然后启动 Tunnel。
4. 运行控制台的 stdio 协议检查和连接诊断，确认客户端连接及 MCP 工具发现正常。

管理器会自动生成 stdio 配置，指向本项目的 `dist/index.js`；不需要填写公开 MCP URL 或开放入站端口。`config/tunnel.example.yaml` 仅供手动配置参考，请在仓库根目录运行其中的相对命令。

完整权限和账号关联要求见 [OpenAI Secure MCP Tunnel 文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。公开 GitHub 源码不等于向插件商店发布服务；Tunnel 供各用户连接自己的本地实例。

## 连接 ChatGPT

1. 打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，点击 **＋ → Add custom MCP server**。
2. 名称填写 `TinyGrailMCP`，Connection 选择 **Tunnel**，选取或填入同一个 Tunnel ID。
3. Authentication 选择 **No authentication**；游戏身份由本机登录会话提供。
4. 创建并安装后，在聊天中选择 TinyGrailMCP，先要求调用 `ping`，再进行只读查询。

入口或权限限制可查阅 [OpenAI 自定义 MCP 接入说明](https://developers.openai.com/api/docs/guides/custom-mcp-server)。新增工具后，在自定义 MCP 的设置中刷新工具列表。

## 使用示例

可以直接向 ChatGPT 提问：

> 这周萌王榜是什么情况？空鱼现在排第几？
>
> 查上一期萌王榜，再翻一页。
>
> 看看现在有哪些 ICO、ST 角色和最近建成的圣殿。
>
> 搜索角色，比较行情、股息、股东和买卖盘。
>
> 查我的持仓和资金流水，估算这个圣殿的单期收入。

| 需求               | 工具                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------- |
| 当前/历史萌王      | `get_top_week`、`get_top_week_history`                                                    |
| 市场及排行榜       | `list_market`，通过 `category` 选择榜单                                                   |
| 查找与比较角色     | `search_characters`、`get_character`、`get_characters`                                    |
| 角色市场资料       | `get_orderbook`、`get_price_history`、`list_character_holders`、`get_character_links`     |
| 本人角色订单与成交 | `get_my_character_trading`                                                                |
| 账户与资产         | `get_account_overview`、`get_asset_breakdown`、`list_holdings`、`list_temples`            |
| 其他玩家公开资料   | `get_user_profile`、`get_user_character`、`list_user_assets`                              |
| ICO/拍卖           | `get_ico_status`、`list_ico_participants`、`get_auction_status`、`get_auction_history`    |
| 日常及计算         | `get_daily_status`、`get_dividend_forecast`、`estimate_temple_income`、`calculate_budget` |
| 操作计划           | 各类 `prepare_*` 工具，`get_trade_plan` 查看结果                                          |

列表支持页码和每页数量；玩家持股和圣殿查询还支持服务器原生筛选。完整参数可在本地控制台搜索工具并查看 Schema。默认输出业务数据，计算依据可传 `includeDetails: true` 查看。

萌王评分按 Magrail 的整榜公式估算，排名沿用当前萌王接口的榜单顺序，与通天塔名次分别表示。历史榜的 `Level` 为当期排名，`CharacterLevel` 为角色等级；默认每页 12 条，保留 `Create` 期次时间。历史接口没有独立的日期筛选参数。

节日接口在当前账号测试中返回 `State=1`；本人 ICO 出资查询在没有参与记录时也可能失败。工具保留业务错误，不伪装成空榜或零投资。

## 本地交易确认

例如：“准备以 10 的限价买入某角色 20 股”，会生成绑定账号、参数、最新资产状态和有效期的计划。

1. 在本地控制台选择允许的动作，设置单次、每日和股数限额，再开启写权限。
2. 审阅待确认计划，核对角色、收款人、数量、文本、图片及资产消耗。
3. 勾选确认并点击批准。聊天里的“同意”不能执行操作。

批准前会重新查询状态；状态变化时需要重新准备。写请求发送前先保存执行标记，网络超时、崩溃或无法核对结果时进入 `outcome_unknown`，阻止后续操作，必须在本地对账。不会自动重发。

图片上传使用同一审批流程，支持不超过 1MB 的 JPEG/PNG；本地窗口可预览图片，上传签名不会返回聊天。圣殿建造与升级通过献祭完成。

每次重启都会关闭真实写权限。紧急停止会关闭权限并作废未发送计划。

## 开发与检查

```powershell
npm ci
npm run typecheck
npm run build
npx playwright install chromium
npm test
npm run doctor
npm run verify:public
npm run verify:account
node scripts/Validate-ReadOnly.mjs
npm run docs:tools
```

自动化测试使用虚构账户，包含真实 MCP SDK stdio、官方 Tunnel 二进制、本地浏览器确认、DPAPI 和写入状态机。Tunnel 二进制测试需要先运行安装脚本。`Validate-ReadOnly.mjs` 使用已登录账号，通过独立本地管理器和真正 MCP 调用验证只读功能，不影响正在运行的 Tunnel；报告保存在本地运行数据目录。

`src/api` 负责 API，`auth` 负责登录与加密，`services` 负责查询，`safety` 负责操作计划和对账，`ui` 是本地管理界面。`src/index.ts` 提供 stdio MCP，`src/main.ts` 启动管理器。调研记录和 API 验证数据保留在本地 `doc/`，不随公开仓库分发。

## 常见问题

**管理页面要求重新打开**：运行 `Start.cmd`。裸地址不包含管理会话的启动凭证。

**启动失败**：脚本会显示启动错误码；本地数据目录的 `manager-startup-error.json` 保存最近失败的时间、进程号和错误码。`EADDRINUSE` 表示端口被占用。

**ChatGPT 看不到 Tunnel**：检查 Platform 的 Tunnel 权限、目标账号/工作区关联、自定义 MCP 权限，以及控制台诊断。已有连接新增工具后需刷新工具列表。

**登录过期**：重新打开本地登录窗口完成授权。不要把 Cookie、API Key 或登录代码发给聊天。

**查询失败**：工具结果包含错误码；先检查登录与网络。GM 专用逐笔历史不提供，普通玩家可用行情图表和本人角色成交记录。

**计划过期或状态变更**：重新查询并准备；原计划不会执行。若结果未知，先在游戏核对订单及资产，再在本地填写对账说明。

**停止、重启或卸载**：

也可双击根目录的 `Stop.cmd` 停止，或 `Restart.cmd` 重启。

```powershell
.\scripts\Stop.ps1
.\scripts\Restart.ps1
.\scripts\Uninstall.ps1                    # 保留本地数据
.\scripts\Uninstall.ps1 -RemovePrivateData # 同时删除本地数据
```

## 参考与许可

API 和业务规则参考 [Magrail](https://github.com/koorinyaa/magrail_app)（MIT）并与 [TinyGrail Magic](https://github.com/koorinyaa/tinygrail-magic) 交叉核对；萌王、ICO 和圣殿计算保留来源。MCP 使用官方 TypeScript SDK，传输使用官方 OpenAI Secure MCP Tunnel。本项目采用 [MIT License](LICENSE)。
