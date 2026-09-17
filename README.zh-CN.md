[English](README.md) · **中文**

# agentgate

**agent 工具层的控制面。** 把存在的工具清点出来，说清每条结论背后的证据，决定什么允许用，并在 CI 与运行时把那个决定执行下去。

它存在的理由只有一条规则，这里的一切都从这条规则推出来：

> 只有每一个检查都跑完，才会给出 `clean` 这个结论。任何测不到的东西都是 `unmeasured`；一件作品只要有一块没测到，它就是 `incomplete`，永远不会是 `clean`。

一个安全工具最糟的失败，是**没做的活拿到了一次绿灯**。这个项目就是为了让这件事不可能发生。

## 四个部分

| 部分 | 做什么 | 代码 |
| --- | --- | --- |
| **inventory** | 枚举注册表、解析包、抓取仓库 | `packages/collect` |
| **evidence** | 合成每台 server 一条记录，每条断言背后都有原始字节 | `packages/collect` |
| **policy** | 扫配置、钩子、清单与源码，找出一家公司会拒绝的东西 | `packages/guard` |
| **verification** | 用断言之外的东西去检验断言 | `packages/verify` |

## 开始部署

部署步骤在 [docs/operations/deployment-runbook.md](docs/operations/deployment-runbook.md)。[docs/verification.md](docs/verification.md) 记录了 2026-09-16 的第一次部署：查了什么、还有什么没验。

## 阅读

[Clean 是对"做过的工作"的断言（英文）](docs/articles/2026-09-clean-is-a-claim.md)——五个失败，其中四个是我的，以及这个工具对它们做了什么。一句话版本：**去问扫描器它没做什么。**

## 什么都不装先看看

服务跑在 <https://app.xn--5kvo87g.com/>：落地页、价格页、可浏览的证据索引（每天重建）和同一个域名下的 API。那台机器上原有的另一个站点没有被改动。

<https://ciceroyang.github.io/agentgate/> 是落地页；证据索引是一页可以浏览的 <https://ciceroyang.github.io/agentgate/evidence.html>，每天从实时注册表重建：记录内嵌在页面里，筛选在本地跑，不需要注册任何东西。价格在 [/pricing.html](https://ciceroyang.github.io/agentgate/pricing.html)，[/try.html](https://ciceroyang.github.io/agentgate/try.html) 用十分钟带你走一遍。

## 快速开始

Node 20 或更新，零依赖。仓库 clone 下来就自带一份样本索引，服务立刻能答；`refresh` 会把它换成当天的。

```sh
node bin/agentgate.mjs serve
# agentgate serving http://127.0.0.1:8080

curl -s localhost:8080/health
curl -s localhost:8080/v1/index/summary
curl -s localhost:8080/v1/servers/<name>
curl -s localhost:8080/badge/<name>.svg
```

它发布在 npm 上，包名 `@zhiliangtech/agentgate`。推一个 `v*` tag，CI 就发一个带 provenance 的版本——[docs/operations/publish-checklist.md](docs/operations/publish-checklist.md) 记录了那套配置和当时验证过的事实。

```sh
npx @zhiliangtech/agentgate check --root .
npx @zhiliangtech/agentgate serve
```

`npx` 解析的是 `latest` 这个 dist-tag；需要精确版本时钉住它（`@zhiliangtech/agentgate@0.1.2`）。

没有策略文件时，`check` 用的是内置默认策略：不额外拒绝任何东西。`serve` 用它发布时带的那份快照作答。`refresh` 永远写到你身边的 `./data`，不会写进装好的包目录里。

也可以用 docker，同一条命令跑在容器里：

```sh
docker compose up                            # 服务在 :8080
docker compose --profile collect run --rm refresh   # 重建 data/index.json 并写入第一份快照
```

## 我的工具清单

先 `node bin/agentgate.mjs serve`，打开它打印出来的本地地址上的 `/inventory.html`。把工具名清单粘进去，或选一个文本/JSON 文件，处理需要确认的匹配，填上你实际在用的版本，然后下载一份独立的 HTML 证据报告。这个页面拿浏览器内存里的清单与内嵌的索引快照做对照：**它不上传清单、不存清单、不扫描你的机器、不执行任何工具。**

不用浏览器也行：

```sh
node bin/agentgate.mjs inventory --input examples/inventory/tools.json --out my-tools.html
node bin/agentgate.mjs inventory --input tools.json --index data/index.json --format json
```

输入可以是一行一个名字、一个 JSON 数组，或 `{ "tools": [...] }`。每个对象只接受 `name`、`server`、`package`、`registry`、`version` 五个字段；完整的客户端配置和凭据是**故意不接受**的。见[清单输入与报告指南](docs/spec/inventory-v1.md)。

匹配不上、需要确认、缺精确版本、版本不一致、证据不完整——这些条目都会留在报告里。**版本对上了不等于机器上装的就是它。** 仓库里那份样本明确是历史数据，给不出确认过的匹配；没有精确内容绑定的旧证据也一样。即使证据匹配成功，那也不是安全认证，不是一次新的扫描。用之前请看清检查范围、发现、快照日期和缺口。

命令在**产出报告时**退出 0，**不是在所有工具都通过时**；输入格式错误或数据读不了退出 2。`--out` 拒绝覆盖已有文件。**CI 里做策略拦截要用 `check`，不是 `inventory`。**

### 先解决"清单从哪来"

没有人手上有这份清单。`discover` 读机器上已经存在的 MCP 配置文件，每台 server 打一行，格式正好是 `inventory --input` 能吃下的：

```sh
node bin/agentgate.mjs discover --out tools.txt          # 主目录 + 当前目录
node bin/agentgate.mjs discover --roots ~/code/a,~/code/b --format json
```

它**永远不打印** `env` 的值、请求头或启动参数，远程地址只留主机名：路径和查询串里常有 token。存在但读不了或解析不了的文件（包括这一版还不解析的 `.codex/config.toml`）会被连原因一起列出来，并把退出码置成 2——**一份缺了东西的清单，不会被当成完整的清单打出来。**

### 一次看多个仓库

```sh
node bin/agentgate.mjs audit --roots ~/code/a,~/code/b,~/code/c --index data/index.json
```

同一套扫描，每个目录跑一次，整体给一个结论：任何一个目录是 incomplete，整个 audit 就是 incomplete；目录不存在算**没测到的仓库**，不是被跳过的仓库。

### 相比上次变了什么

```sh
node bin/agentgate.mjs watch --input tools.txt --index data/index.json --archive ./archive
node bin/agentgate.mjs watch --verify --archive ./archive
node bin/agentgate.mjs watch --input tools.txt --index data/index.json --archive ./archive \
  --webhook https://example.invalid/hook --webhook-format wecom
```

每次运行往一个链式归档里追加一行（`prev` 是上一行的哈希），并把看到的内容存进 `snapshots/<sha256>.json`。`--verify` 重算整条链与每份保留下来的快照，不一致就以 1 退出。**除非显式给了 `--webhook`，什么都不会发出去**；归档先写、推送后做，所以聊天服务挂了也不会丢一次采集。

### 把答案交给问卷

```sh
node bin/agentgate.mjs framework                       # 哪些 AI-CAIQ 条目由谁交账
node bin/agentgate.mjs inventory --input tools.json --framework aicaiq --out report.html
```

这张对照表逐条说明：我们能提供什么、覆盖到哪里为止、这条最终是**我们**、**你们**还是**独立评估方**来交账。它是对证据的描述，不是合规结论，也不转载官方原文。

## 策略

策略说的是"这家公司拒绝什么"。它是数据，不是代码，而且有规范：[docs/spec/policy-v1.md](docs/spec/policy-v1.md)。

```json
{
  "version": "agentgate.policy/v1",
  "threshold": "high",
  "required": { "pinnedPackages": true, "measuredEvidence": ["packageManifest"] },
  "forbidden": { "rules": ["AG-INSTALL-001"], "servers": ["internal/*"] }
}
```

```sh
node bin/agentgate.mjs check --policy agentgate.policy.json --root .
```

没有策略文件、也没给 `--policy` 时，check 照样跑：它报告检查发现了什么，并说明自己用的是内置默认策略（不额外拒绝任何东西）。**替用户发明义务只会让结果更不值钱，不是更值钱。** 但明确指定了却读不了的策略文件仍然是错误——那说明打错了字。

同一份评估也可以交给一个人，而不是交给终端：

```sh
node bin/agentgate.mjs check --policy agentgate.policy.json --root . --format html --out report.html
```

一个静态文件，能打印，无脚本。**测不到的东西会单独成节、排在发现前面**——一份把"没查的部分"埋起来的报告，读起来比它实际更完整。这个文件就是免费体检的交付物。

三种结局，而 `incomplete` 优先于 `findings`：只要有一个检查没跑成，或者策略要求的证据块是 `unmeasured`，退出码就是 **2**，不管发现看起来多干净。**没有任何阈值能把一个局部的答案变成通过。**

| 退出码 | 含义 |
| --- | --- |
| 0 | clean |
| 1 | findings |
| 2 | incomplete |

## CI 拦截

一个 PR 如果加了策略拒绝的东西，就合不进去，而且**理由写在 PR 里**，不是写在一个没人打开的日志里。

```yaml
- uses: ciceroyang/agentgate@main
  with:
    policy: agentgate.policy.json
```

见 [examples/github-actions/policy.yml](examples/github-actions/policy.yml)。这个 action 跑检查、为 code scanning 写 SARIF、把给人看的报告评论到 PR 上，然后用检查自己的退出码退出——所以没测完的扫描仍然会以 2 让构建失败。

## 运行时

同一套策略也可以管已经发布出去的东西：不把客户端直接指向 server，而是在前面放一个网关。

```sh
node bin/agentgate.mjs proxy --policy agentgate.policy.json --log calls.jsonl -- \
  npx -y @modelcontextprotocol/server-filesystem /data
```

策略拒绝的工具调用在本地被回答、附上原因，**永远到不了 server**；被禁止的工具会从对外宣告的列表里摘掉，客户端连问都问不到。每一个决定——允许的、拒绝的——都追加进日志，因为审计读的就是这个日志。

## 变更历史

索引是留存的，所以两次构建可以对比，而最有意思的是最后一列：**本该由一次发版解释、却没有解释的变化。**

```sh
node bin/agentgate.mjs diff --from previous-index.json --to data/index.json
```

```
  added:           0
  removed:         0
  verdict changed: 1
  package changed: 0
  silent (no version move, different evidence): 1
```

版本没动、却发现变了——这通常意味着：包被换过但没有发版、仓库被就地改过、或者扫描器开始看到新东西。**这条记录没有人能事后补**：只有当时一直有人在看，它才存在。

## 索引背后的流水线

```sh
node packages/collect/mcp-audit.mjs --max 6000 --out data/census.json
node packages/collect/scripts/guard-scan.mjs --census data/census.json --out data/guard-scan.json
node packages/collect/scripts/build-index.mjs --census data/census.json --guard data/guard-scan.json --out data/index.json
```

在本地项目上跑扫描器：

```sh
node packages/guard/bin/agent-guard.mjs . --fail-on high
node packages/collect/bin/agent-add.mjs --index data/index.json <server-name>
```

## 测试

```sh
npm test                              # 全套；会打印跑了多少项
node scripts/bench.mjs 50000 200      # 查询必须保持在 10 ms p50 以内
node scripts/measure-verify.mjs       # 断言抽取，对着一小份带标注的集合
node packages/guard/scripts/regression.mjs   # 良性的必须保持沉默，阳性必须命中
```

## 目录

```
packages/guard     扫描器：引擎、八项检查、CLI、语料、GitHub Action
packages/collect   普查、包与仓库扫描、证据索引
packages/policy    策略评估与给人看的报告
packages/gateway   针对 stdio MCP server 的运行时策略执行
packages/history   索引快照与变更比较
packages/service   只读证据 API
packages/verify    跨模型断言核对
docs/              架构与产品笔记
```

## 验证

除了测试（测试和代码是同一方写的），[docs/verification.md](docs/verification.md) 记录了那些**不是这里的人写的东西**上的核对：一台真实的 MCP server 通过网关，以及还有什么没验的清单。

```sh
node scripts/verify-real-server.mjs
```

想检查索引里的 `high` 与 `critical` 发现是否仍然对得上人工复核记录，跑 `node scripts/review-criticals.mjs`（命令名保持原样）。每次复核必须把发现的身份与证据绑定到一个**精确的包版本**和完整的扫描内容来源，包括它的 SHA-256 摘要与范围。绑定缺失或变化，就需要重新人工复核。旧的批准记录不会自动升级。`--accept` 记录一次已完成的人工复核，并且拒绝不完整的来源；它不代替你做复核，也不认证第三方代码。

## 运维这件事

- [docs/operations/README.md](docs/operations/README.md) — 运维手册索引：出事了按症状找。
- [docs/operations/what-i-need.md](docs/operations/what-i-need.md) — 部署前必须提供什么，以及什么可以安全交接。
- [docs/operations/deployment-runbook.md](docs/operations/deployment-runbook.md) — 阿里云加 智量.com 域名，并把 ICP 备案的坑单独点出来。
- [docs/operations/productionization.md](docs/operations/productionization.md) — 生产化 P0–P6：每一步为什么、验收标准、有没有在真实部署上验过。
- [docs/operations/pilot-package.md](docs/operations/pilot-package.md) — 发给潜在设计伙伴的一页纸：交付物、时间线、我们要什么、我们拒绝要什么。
- [docs/operations/trademark-filing.md](docs/operations/trademark-filing.md) — 商标申请材料，除了申请人信息都已就绪。
- [docs/operations/outreach-templates.md](docs/operations/outreach-templates.md) — 最初三个设计伙伴怎么联系。
- [docs/operations/plan-b-no-icp.md](docs/operations/plan-b-no-icp.md) — 大陆机器没有备案时怎么办，这是唯一能让部署半路停下的东西。
- [deploy/](deploy/) — Caddyfile 和 systemd 单元，复制到服务器就能用。
- [scripts/onboard-server.sh](scripts/onboard-server.sh) — 把部署步骤写成脚本：先打印它要做什么，只有加 `--apply` 才动手。
- [scripts/smoke.mjs](scripts/smoke.mjs) — 部署后的自检：通不通、索引在不在、索引新不新、记录是真的还是样本。

## 状态，诚实地说

这是一个早期的开源内核。它包含采集、证据索引、扫描、CI 里的策略检查、针对 stdio MCP server 的运行时网关、历史对比与一个只读服务。部署脚本和 runbook 都有；第一次服务器部署和当时的核对记录在 [docs/verification.md](docs/verification.md)。**那份记录不能说明线上服务当前是否健康**，Docker 镜像构建在那里也仍然没有验过。

价格方案里描述的企业能力——SSO/SAML、RBAC、多租户、签名审计导出——**尚未实现**。Team 与 Enterprise 的价格是**尚未经过客户验证的假设**；免费试点就是为了验证这个需求。见[产品决策](docs/product/decisions-2026-09.md)与[试点范围](docs/operations/pilot-package.md)。

扫描器的测试套件里有一条不变量：**一个崩掉的检查永远不可能产出 `clean`。** 当前结果跑 `npm test` 看；这一页不重复测试数量。

## 许可

AGPL-3.0-only。AGPL 不允许的那种用法——把修改过的 agentgate 作为闭源服务提供而不公开你的修改——可以谈商业许可。见 [docs/product/licensing.md](docs/product/licensing.md)。
