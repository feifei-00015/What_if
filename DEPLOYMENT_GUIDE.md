# What_if 上线指南：GitHub Pages + 云端 API

> 核对日期：2026-10-20。适用于目前的匿名每日免费体验和「配置我的 API」流程。
> 这是一份执行清单；当前仓库尚未完成公开部署所需的后端改造。

## 先确定发布范围

第一版建议先发给少量体验用户，观察真实模型调用量和费用，再开放给更多人。目标架构为：

```text
浏览器 → GitHub Pages（只放 web/ 静态文件）
       → HTTPS API（阿里云函数计算 FC + 访问限流）
       → 共享持久数据库（访客、额度、故事结构和分支占用）
       → 模型服务（站点 API Key 只在后端）
```

GitHub Pages 在 GitHub Free 的公开仓库可用，只托管 HTML/CSS/JavaScript，不能运行本项目的 Node 后端。[GitHub Pages 说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[发布来源说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。因此「网页免费」不等于「整个 AI 产品免费」。

## 当前已经有的东西

- 页面、模型请求、分支校验和部分异常回复自动重试。
- 每访客每天 2 个免费新故事、全站每天 50 个免费新故事、全站每天 1000 次模型请求的本地原型额度。
- 服务端保管站点 API Key；个人 API Key 只在浏览器会话保存，并经后端转发。
- 故事正文和结果保存在浏览器；`.what-if-trial.json` 只记录访客、额度和无正文的故事结构。它适合单进程验证，不适合 FC 多实例。
- 前端已可在 `web/api-config.mjs` 配置独立 API Origin；本机默认留空，公开 API 地址尚未确定。
- `npm test` 在 2026-10-20 运行：78 项通过。测试使用模拟模型；真实模型和线上并发尚未验收。

当前目录已初始化为本地 Git 仓库，并备好手动触发的 Pages 工作流；还没有 GitHub 远端。`web/` 不是 GitHub Pages 分支发布功能可直接选择的目录；分支发布只支持仓库根目录或 `/docs`，这里用 GitHub Actions 只上传 `web/`。[GitHub 发布来源说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 上线前必须完成的开发

按以下顺序处理，每项完成后按右侧标准验收：

| 顺序 | 工作 | 验收标准 |
| --- | --- | --- |
| 1 | 在 `web/api-config.mjs` 填入实际云端 HTTPS API Origin | 从 `https://<用户名>.github.io/<仓库名>/` 打开时，请求到云端 API；图片、CSS 和 JS 仍正常加载 |
| 2 | 把访客、额度和故事结构元数据迁到共享持久数据库，并以原子操作处理分支占用、结构写入和额度扣减 | 两个后端实例同时处理同一分支，只保存一次；站点额度不会超扣或漏扣 |
| 3 | 给公开接口加入口限流和成本控制 | 换浏览器身份、快速重复请求都不能无限消耗站点模型费用；额度耗尽后停止站点付费请求 |
| 4 | 固定允许的网页来源，并限制个人 Base URL 的出站访问范围 | 只允许正式 Pages 来源；不能通过自定义 Base URL 访问内网、回环地址或云元数据地址 |
| 5 | 告知用户本地故事的保留和删除规则 | 用户知道清除浏览器数据或换设备后无法恢复；新建故事会删除上一个故事及本地备份 |
| 6 | 配置部署包、环境变量、HTTPS、日志与告警 | API 可从公网经 HTTPS 访问，日志不包含任何 Key，异常和费用能被发现 |

**这些是当前缺口，不是已经可直接点击启用的配置。**前端在 `API_ORIGIN` 留空时仍使用同域 API；FC 入口还要求 `TRIAL_STORE_FILE`，现有 `pack:fc` 包不含共享数据库适配器。不能直接把当前 ZIP 上传 FC 当成公开版。FC 实例本地文件在回收后会丢失；即使挂载共享文件，当前进程内的写入队列也不能保护跨实例更新。[阿里云 FC 文件说明](https://www.alibabacloud.com/help/en/functioncompute/creating-a-web-function)

匿名访客凭证可以通过清除站点数据重置，不能作为防刷身份。`Origin`/CORS 只限制浏览器跨站访问，不能阻止脚本直接调用 API。服务端必须保留全站预算，并考虑按 IP/账号/挑战机制限流。当前仅验证个人 Base URL 是 HTTPS，公开前还要防止服务端请求伪造。[OWASP SSRF 指南](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

个人 API Key 也是敏感凭据。GitHub 提醒 Pages 不适合处理密码、信用卡等敏感交易；公开个人 Key 输入前，要明确告知用户它只保存在当前浏览器会话、会发送到本站后端，并检查页面脚本和跨站脚本风险。[GitHub HTTPS 与敏感信息说明](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)

## 费用先设上限

| 项目 | 费用判断 |
| --- | --- |
| GitHub Pages | GitHub Free 的公开仓库可用；有站点大小和流量限制。[GitHub Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| FC 后端 | 最小实例数设为 0 时，空闲无调用不产生 FC 计算费用；有调用时按资源与时长计费。首次试用额度有期限，不能当长期免费服务。[FC 计费](https://www.alibabacloud.com/help/en/functioncompute/billing-overview-of-fc)、[试用额度](https://www.alibabacloud.com/help/en/functioncompute/trial-quota-1) |
| 数据库、网关、网络 | 另行计费；Tablestore 的存储和读写按用量收费。开通前用所在地域的计算器估算。[Tablestore 计费](https://www.alibabacloud.com/help/en/tablestore/product-overview/billing-overview) |
| 模型 | 按供应商的实际输入、输出 Token 收费，重试也可能计费。必须单独设置供应商侧额度或预付余额。 |

上线初期先量出轻度、正常、深度模式的**单个完整故事**成本，再决定每天免费故事数。当前 `50 故事/天、1000 模型请求/天` 是测试默认值，不代表可承担的现金预算。100 位用户同一天都想免费新建故事时，目前至少有 50 人会被全站故事额度挡住。预算告警不能代替后端拒绝超额请求；提供商侧消费上限是最后一道保护。

## GitHub Pages 发布步骤

### 1. 创建 Git 仓库并检查文件

本地 `main` 已建立并完成一次初始提交；`.gitignore` 已排除 `.env.local`、`.what-if-trial.json`、`dist/` 和设计源文件。推送前仍要检查待提交列表；不要直接 `git add .` 把备份或个人资料放进公开仓库。

```bash
git add web backend scripts test package.json .gitignore .github DEPLOYMENT_GUIDE.md
git status --short
```

检查暂存列表中没有 Key、用户故事或私有备份，再提交并推送到新建的 GitHub **公开**仓库。只要真实 Key 曾经进入 Git 历史，就应在模型平台撤销并更换该 Key；后来删除文件并不能消除已经发布过的历史。

### 2. 只发布 `web/`

`.github/workflows/pages.yml` 已准备好，只在手动运行时发布 `web/`；`API_ORIGIN` 未填入有效 HTTPS Origin 时会拒绝发布。不会上传后端代码、环境变量或故事数据。GitHub 官方提供 `configure-pages`、`upload-pages-artifact` 和 `deploy-pages` 这套流程。[GitHub 自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

在 GitHub 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。填好 API 地址后手动运行工作流，查看 Actions 是否成功，并从 Pages 页面打开站点。普通项目仓库的地址通常是 `https://<用户名>.github.io/<仓库名>/`。相对资源路径要在这个带仓库名的地址下验证。[GitHub Pages 地址规则](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

Pages 本身可启用 HTTPS；云端 API 也必须是 HTTPS。站点 API Key 只放在后端平台配置中，不能放到 GitHub Actions 生成的前端文件里。[GitHub HTTPS 说明](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)

### 3. 部署后端

在完成共享数据库和限流改造后，创建 Node.js Web 函数，并配置：模型服务 HTTPS Base URL、模型名称、站点 Key、精确的 Pages `Origin`、数据库连接和函数端口。`Origin` 是 `https://<用户名>.github.io`，**不包含** `/<仓库名>/` 路径。Key 用云平台的私有环境配置或密钥服务保存；FC 环境变量支持静态加密，但仍不能把它打印进日志。[FC 环境变量文档](https://www.alibabacloud.com/help/en/functioncompute/environment-variables)

入口网关需要限制请求频率和并发，后端仍需判断每个故事及全站的模型预算。先检查 FC 直接 HTTPS 入口和网关的实际报价，再选满足限流需求且账单可接受的方式。不要把“首次试用额度”当成长期预算。

## 发布前验收清单

- [ ] `npm test` 全部通过；真实模型用专门的低额度测试 Key 完成一次长故事整理和一次完整推演。
- [ ] 模拟坏 JSON、错误字段、超时、HTTP 429/503；确认重试有上限，失败不会保存半棵树。
- [ ] 测试免费额度用尽后不再调用站点模型；个人 Key 流程仍能使用兼容 Chat Completions 的服务。
- [ ] 生成一半刷新浏览器、重启后端，再继续同一故事；已完成分支不重复计费。
- [ ] 两个实例同时请求同一分支和同一日额度；结果只提交一次，额度准确。
- [ ] 测试 20、50、100 个并发请求，记录 API 延迟、失败率、内存、数据库冲突和模型供应商限流；按结果设置并发上限。不要只根据 Node 能接受连接就宣称支持 100 人同时生成。
- [ ] 在实际 GitHub Pages 地址检查静态资源、API 跨站请求、HTTPS、页面刷新和手机浏览器。
- [ ] 查看前端网络请求、页面源码、构建产物和服务端日志，确认没有站点 Key 或个人 Key 泄漏。
- [ ] 配置费用告警、供应商侧额度上限，并准备关闭免费生成的开关或操作步骤。
- [ ] 备份和恢复访客、额度、故事结构元数据；确认本地故事删除规则已告知用户。

达不到前述数据一致性和成本控制验收时，先不要向公众开放站点付费的免费生成。可以先把 Pages 链接发给少量测试者，观察真实成本和故障，再逐步放量。
