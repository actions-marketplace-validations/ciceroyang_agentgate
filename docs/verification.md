# Verification against something nobody wrote here

*The tests in this repository are written by the same party as the code, against inputs
chosen by that party. This page records the checks that are not that.*

## A real MCP server through the gateway

```sh
node scripts/verify-real-server.mjs
```

Run on 2026-09-15 against `@modelcontextprotocol/server-filesystem`, installed from npm by
`npx` during the run:

```
1.2s  initialize -> {"name":"secure-filesystem-server","version":"0.2.0"}
6.0s  tools/list -> 11 tools
      read_file, read_text_file, read_media_file, read_multiple_files,
      create_directory, list_directory, list_directory_with_sizes,
      directory_tree, search_files, get_file_info, list_allowed_directories

removed by policy: 3  (write_file, edit_file, move_file)
```

The server advertises 14 tools. The client, going through the gateway with
`forbidden.tools: ["write_*", "delete_*", "move_*", "edit_*"]`, is allowed to see 11. The
log records each removal with its reason. This is not a test of the policy language; it is
evidence that the gateway sits in front of a real server, speaks the protocol, and that the
decision reaches the real tool list.

### A caveat worth keeping

The first attempt at this reported zero messages. Nothing was wrong with the gateway: that
run paid for the `npx` download, which outlasted the fifteen-second window the probe
allowed. A gateway is a transparent pipe, so the startup cost of the command it wraps is
the client's handshake timeout, and pointing it at an un-cached `npx` package on a cold
machine can exceed one. Pre-install, or give it time.

## The GitHub Action on a real pull request

It has now run on one. [Pull request #1](https://github.com/ciceroyang/agentgate/pull/1)
was opened with a project that breaks its own policy; the `policy` check went red, the
report named `AG-MCP-010` and `AG-MCP-014`, and the action commented the report on the pull
request. The pull request was closed once that was confirmed.

The workflow that did it is wrong in one way worth recording: run against deliberately
broken input, it failed on every push, which is not a test. `action-verify.yml` now runs
the action with `continue-on-error`, asserts the outcome was failure, asserts the exit code
was 1, and asserts the SARIF names both rules. The enforcement path is exercised on every
push, and it goes red if the action ever lets a breaking project through.

## The deployment itself, rehearsed from a fresh clone

On 2026-09-15 the whole runbook was run against the published repository, not the working
copy: clone, run the tests inside the clone, do a full refresh against the live registry,
write the first history snapshot and diff, start the service, and smoke it with
`--expect-min 1000` so that a service still reading the committed sample would fail.

```
cloned files:  130
tests:         146 pass
refresh:       243 packages, index 2127 records (2039 clean, 66 findings, 22 incomplete)
history:       first snapshot + diff, 1827 added, 1 package changed
smoke:         green, including --expect-min 1000
elapsed:       2m 04s for the collection step
```

That is the deployment as far as it can be exercised without the target server. What it
does not cover: the Docker layer build, TLS issuance, DNS, and the ICP question.

## Scale, and the bug that measuring it found

`scripts/bench.mjs` builds an index far larger than today's and times lookups. At 50,000
records (a 9.8 MB file) the first run showed **p50 29.6 ms per request**, because the service
re-read and re-parsed the entire index on every call.

| | p50 | p95 | max | rss |
| --- | --- | --- | --- | --- |
| before | 29.6 ms | 40.8 ms | 42.3 ms | 276 MB |
| after | **1.1 ms** | 1.3 ms | 2.2 ms | 213 MB |

The parsed index is now cached and revalidated by modification time and size. That
revalidation is the load-bearing part: the runbook promises a refresh takes effect without
a restart, and a cache without it would have quietly broken that promise. There is a test
for it, including a rewrite that keeps the file the same size.

One more thing this found: the benchmark's own budget was 50 ms, which passed. A budget
loose enough to accept a 30x regression is not a budget. It is 10 ms now, and it runs in CI.

## Claim extraction, measured instead of assumed

`node scripts/measure-verify.mjs` runs the crosscheck claim extractor over twelve short
labelled texts and prints whatever it finds:

| metric | value |
| --- | --- |
| extraction precision | **100%** (8 of 8 flagged sentences were labelled checkable) |
| extraction recall | **89%** (8 of 9 labelled sentences were found) |
| planted-defect catch rate | **88%** (7 of 8 deliberate defects were flagged) |

The single miss is a scope boundary rather than a bug. The text contains "ignore all previous
instructions" and nothing else checkable - no link, number, date, citation marker or source
phrase - and those features are precisely the extractor's definition of checkable. Injection
phrasing is checked by `packages/guard`, which is a different tool with a different job.

The weakness is stated in the script: the labels are mine and twelve texts is a small sample.
It beats the number being unavailable, and the test that runs it asserts floors, not targets,
so the figures cannot quietly get worse.

## The published page grows with the corpus

The static index embeds its records, so the page size follows the index size:

| index | page |
| --- | --- |
| 2,128 records (today) | 490 KB |
| 50,000 records | 15 MB |
| 200,000 records | 60 MB |

Build time stays under a second; it is the page that becomes unusable, on a phone in
particular. It is now capped at 20,000 embedded records, chosen so that `incomplete` and
`findings` survive and `clean` is dropped first, and the page states the total it was cut
from. A silently truncated view would be the same failure this project keeps arguing
against, so the truncation is printed.

## Still not verified anywhere but on one machine

| item | state |
| --- | --- |
| Docker image build | not run, no Docker here; the build context and the image command were reproduced instead |
| Scale beyond 50k records | measured at 50,000; the registry writes about 2,000 today |


Each of these is a place where "it works" currently means "it worked once, for me".

## Caddy 追加机制实测（2026-09-16）

部署目标上已经有一份别人在用的 Caddy 配置（主域上的另一个站点）。`--with-caddy` 的做法是
**备份后追加**一个带标记的段落,校验通过才 reload,失败回滚。这个机制用**真的 Caddy 二进制**验过,
不是推断:

```sh
# 用 /tmp 里的 caddy 二进制,对一个"已有主域站点"的配置追加我们的段落
caddy validate --adapter caddyfile --config merged.caddy
#   -> Valid configuration (exit 0)

caddy adapt --adapter caddyfile --config merged.caddy
#   -> 同一个 server 上有四个 host:
#      xn--5kvo87g.com www.xn--5kvo87g.com app.xn--5kvo87g.com api.xn--5kvo87g.com
#      主域上原有的站点与产品共存,Caddy 会为四个名字各自签发证书

# 失败路径:已有配置里也声明了 app.
caddy validate --adapter caddyfile --config dup.caddy
#   -> Error: ambiguous site definition: app.xn--5kvo87g.com (exit 1)
#      这正是回滚要覆盖的情况
```

复跑方式:下载对应平台的 caddy 到 /tmp,然后 `CADDY_BIN=/tmp/caddybin/caddy npm test`。
不设这个变量时,那条测试会跳过并在输出里说明原因——它需要一个 46MB 的二进制,不适合塞进 CI。

## Caddyfile 路由实测（2026-09-16）

`app.` 这个站点把静态页和 API 混在一个 host 里:有序的 `handle` 块 + 最后的 `file_server` 兜底。
块与路径匹配器的顺序是第一次部署才会暴露的东西,所以用**真的 Caddy 二进制 + 真的服务**跑了一遍
(`test/caddy.test.mjs`,设了 `CADDY_BIN` 才跑):

```
GET /                       200  text/html          文件服务
GET /try.html               200  text/html          文件服务
GET /evidence.html          200  text/html          文件服务
GET /health                 200  application/json   反代到 127.0.0.1:<service>
GET /v1/index/summary       200  application/json   通配路径反代
GET /badge/anything.svg     200  image/svg+xml      通配路径反代
GET /nope.html              404                     兜底是文件服务,不是代理
```

也就是说静态页与接口可以共用一个域名,不需要为 API 单独开子域——`api.` 只是给脚本用的可选项。

## 首次真实部署（2026-09-16，阿里云香港）

目标：`8.218.22.11`，域名 `智量.com`。**主域上已经跑着另一个站点(Next.js + Caddy)**,所以产品放在子域,
配置是**追加**到已有 Caddyfile 的,不是覆盖。

```
服务      https://app.xn--5kvo87g.com/   systemd active + enabled, 监听 127.0.0.1:8080
索引      2114 条, generatedAt 是当天(不是样本的 300 条)
证书      Caddy 自动签发; 五个页面 / /health /v1/* /badge/* 从外网全部 200
原有站点  未改动; 改动前备份 /etc/caddy/Caddyfile.bak.*
历史      data/history/{2026-09-16.json, diff-2026-09-16.md, previous.json}
外网验收  node scripts/verify-public.mjs --base https://app.xn--5kvo87g.com  -> 14 项全过
```

部署过程中**真实遇到并修掉**的问题,全部来自环境而不是算法:

1. 服务器没有 Node。旧脚本只提示一句就继续,在 `/usr/bin/node: No such file or directory` 上倒下。
   现在 Node 不满足就在检查阶段停下,并按发行版给出安装命令。
2. smoke 与 systemd 的竞态。`Type=simple` 在进程 fork 后就算"已启动",而 `listen()` 还没返回;
   自检把一个健康的服务报成失败,并且因为这个失败**跳过了 Caddy 那一步**。现在自检前等端口就绪,
   smoke 自己也会重试。
3. 重跑时把**自己**占用的端口当成冲突。`enable --now` 不重启已经运行的单元,于是 unit 里写了 8081,
   而进程还在 8080,配置永远不生效。现在先停自己的服务再探端口,并用 `restart`。
4. `chown` 给 `agentgate` 之后 root 的 git 以 "dubious ownership" 拒绝操作,重跑拉不到新代码。
   现在脚本会先 `git config --global --add safe.directory`。

还有一条与前四项无关但同样真实:这台 Mac 的代理**按域名分流**,裸 IP 走直连(被墙),
所以 `~/.ssh/config` 里那台机器的主机名必须是域名。

## 证据索引的抽屉被吸顶搜索栏压住（用户报告，2026-09-16）

现象:点开一条记录,右侧抽屉的顶部(标题和"关闭"按钮)被**吸顶的搜索栏**盖住,搜索栏浮在最上面。

原因:`.bar` 是 `position:sticky; top:0; z-index:2`,而 `#detail` 是 `position:fixed` **但没有自己的
z-index**,于是带 z-index 的搜索栏在绘制顺序上赢了。

**它只在页面滚动之后出现**:不滚动时吸顶元素还在页头下面,和抽屉不重叠。我最初两次复现都失败,
就是因为我在 `scrollY=0` 测量——这也是这个 bug 容易被漏过的原因。

用真实 Chrome 在 `scrollY=600` 下测量 `elementsFromPoint`(线上,修复前 / 修复后):

```
                修复前                      修复后
y=8      bar > detail > …            detail > bar > …
y=30     q  > bar > detail            close > detail > q
关闭按钮可点   false                     true
drawer z-index auto                     10
```

修复:`#detail` 加 `z-index:10`;关闭按钮在抽屉内吸顶(抽屉会滚动);并支持 Esc 与点击外部关闭。
测试断言"抽屉的 z-index 必须大于搜索栏的",把 `z-index` 去掉就会红。

另外两件顺带发现的事:

- 浏览器会缓存这一页(有 ETag 但没有 cache 策略),导致一次已部署的修复看起来"没生效"。现在 HTML 带
  `Cache-Control: no-cache`(回源校验),静态资源不受影响。
- **我手工 `cat Caddyfile >> /etc/caddy/Caddyfile` 部署过一次,绕过了脚本写的标记,把线上那份配置的
  begin/end 标记弄丢了。** 还好发现了:否则下一次 onboard 会找不到可替换的标记、追加第二份 site 块、
  校验失败。已补回标记,并确认 `begin:1 end:1`、`app.` 块只有一个。教训:部署只能走脚本。

## 本地可靠性修正（2026-09-17，未发布）

本轮只修改本地源码和说明；没有提交、推送、部署、刷新线上索引或发信。
历史部署记录不等同于这些修正已经在线上生效。

- manifest 检查失败、未知状态、重复结果、显式未审计条目均不能变成 `clean`；
  请求仓库扫描但没有结果时保留 `unmeasured`，未请求的仓库扫描仍是可选范围。
- npm 采集与关联使用实际声明的包版本，不再混用 server 版本或回退到 latest。
- 高等级与最高等级发现的复核绑定发现身份、精确包版本、实际扫描输入的 SHA-256 和范围；
  内容改变但描述未变也会要求重新复核。摘要不声称覆盖传递依赖、整个包或运行时行为。
- 安装脚本的越界路径、非法包名以及转向其他内容的响应不能成为当前包的完整证据。
- README、试点材料和数据处理说明已统一已实现能力、材料要求与尚未验证的运营边界。

在本机 Node v26.4.0、npm 11.17.0 下运行 `bash scripts/verify.sh`，退出码为零：
本地测试、M1–M4 验收、临时目录中的部署彩排、语料回归与规模预算检查通过。
新增 `test/collection-review.test.mjs` 使用模拟读取串起采集、索引与复核命令，
覆盖同版本同描述的脚本变化、检查器异常和未审计 remote 条目；没有执行待扫描脚本。

未验证项仍需保留：本机未配置 `CADDY_BIN`，Caddy 可选检查被跳过；缺少 PyYAML，
YAML 解析步骤被跳过；未运行线上验收，也没有验证 Node 最低支持版本的兼容性。

`data/reviewed-criticals.json` 与已有样本索引保持不变。旧复核记录只有文字证据，不能
自动升级为新格式的有效复核；后续必须重新取得实际输入，并逐条审阅后再显式接受。
本轮测试中的接受动作只作用于临时合成样例，不是对任何第三方包的重新背书。

## 我的工具清单与专属报告（2026-09-17，本地，未发布）

新增 `inventory` 命令和 `/inventory.html` 工作页：导入名称清单、确认候选、补充实际版本，
预览并下载独立 HTML 报告。页面、离线命令使用同一个纯 JavaScript 匹配器；报告保留每项
输入、未覆盖原因、发现、源记录时间、检查范围及内容摘要。不扫描本机、不执行工具，
不把名称命中、历史样本或缺少完整来源的证据当作安全认证。

本机 Node v26.4.0 / npm 11.17.0：

- `bash scripts/verify.sh` 完成：测试、M1–M4 验收、本地部署彩排、语料回归和规模检查通过。
- 工具清单专用测试覆盖精确及模糊匹配、版本/来源歧义、样本/错误类型/重复记录、来源时间、
  报告转义、静态构建、固定服务资源、禁用外网的报告生成，以及 npm 打包后的页面及模块。
- 实际浏览器走过粘贴、唯一模糊候选确认、版本补充、版本不一致、预览、HTML 下载并读回文件、
  本地 JSON 文件选择；修改版本后旧预览隐藏、下载停用。
- 隔离合成索引验证两个版本切换时下拉与来源时间同步、输入焦点保留；两行变成重复时两行
  状态一起更新，解除重复后恢复。合成材料没有加入正式索引。
- 手机宽度 390 像素检查未出现横向溢出，测试后恢复浏览器尺寸。

没有提交、推送、部署、刷新公开索引或接触真实客户清单。供用户查看的本地预览仍使用仓库
历史样本，并明确标出限制。真实用户采用、报告转交及付费意愿未验证；审批和升级比较不在
本轮实现范围。Caddy 可选检查、YAML 解析和最低 Node 版本的未验证边界延续上一节。

## 清单工作台定向网页发布（2026-09-17）

用户明确要求发布后，将清单工作台上线至
<https://app.xn--5kvo87g.com/inventory.html>，同时更新首页和试用页入口。
这是现有网站的定向静态发布，不是 npm 发版、GitHub Pages 发布或全部本地修正上线。

- 发布四个工作台文件及首页、试用页、站点地图；站点地图保留原有条目并增加工作台。
- 使用服务器已有公开索引：2,094 条，源时间 `2026-09-16T15:27:24.321Z`。
  没有重新采集、改写索引或用本地 300 条样本覆盖线上证据页。
- 同步工作台所需九个源码/模板文件至服务器工作目录，使现有定时构建仍能生成该页面。
  Git HEAD 和远端仓库未改变；服务器这些文件是有意保留的未提交改动，后续代码更新需先整合，
  不应直接 reset 或用旧仓库内容覆盖。
- 服务器 Node v20.20.2 的清单匹配、报告、页面事件和静态站点测试通过；随后以实际定时任务
  用户在隔离临时目录中重建，核对工作台页面及模块与公开文件一致。
- 公网页面和三个模块返回 200，模块 MIME 正确，内容摘要与发布文件相同；原有公开验收通过。
  实际浏览器完成演示清单核对和嵌入式报告预览，未出现页面错误。
- 公网下载按钮可用并显示已准备下载，但内置浏览器未返回下载事件，本机下载目录也未找到
  本次文件，因此本次公网下载的最终落盘仍为待确认，不能用按钮提示代替完成证据。
- Caddy 配置、个人主站入口、原证据页、索引和人工复核基线的文件摘要均保持不变；
  后端进程没有重启。既有证据缺少来源绑定时，清单报告继续明确保留“证据不足”。

发布备份和逐文件回执保存在服务器 `/var/backups/agentgate-inventory-g0KBcH/`，不由网站提供。
本地原有采集器、复核机制和命令行等其他修改没有随本次静态网页发布部署。

## 安装脚本的临时文件与环境复验（2026-09-17）

服务器只读复验发现 `onboard-server.sh` 把生成的 unit 与 Caddy 片段写到 `/tmp` 下的**固定名字**。
这个脚本的用法就是以 root 在别人的机器上跑：预先存在的同名文件会变成拒绝服务（真机上出现过
`Permission denied`，一次全新 clone 的 7 个测试全红），而指向
`/etc/systemd/system/agentgate.service` 的符号链接会把写入变成对该路径的 root 写入。
两个文件现在都由 `mktemp` 生成、由 `EXIT` trap 删除，失败退出也不留文件。

同一轮里还查出测试自己的问题，两个都会让“本机通过”与“目标机通过”不一致：

- 假 PATH 给了脚本 `mktemp` 却没给 `rm`，trap 因此执行不了：每次彩排都在共享临时目录留下
  一份 unit 和一个空文件。本机没发现是因为检查的是 `/tmp`，而 macOS 的 `TMPDIR` 在
  `/var/folders` 下；服务器上则一直堆在 `/tmp`。假 PATH 现在带 `rm`，并新增一条测试：
  给脚本一个自己的 `TMPDIR`，退出后该目录必须为空。
- `--repo` 测试用的是默认目标 `/opt/agentgate`：笔记本上该目录不存在，脚本打印 clone，测试通过；
  部署机上它已存在，脚本打印 pull，测试失败。现在显式传入不存在的 `--dir`，测试不再读取
  它所在的机器。

已完成的复验：

- macOS / Node v26.4.0 / npm 11.17.0：`bash scripts/verify.sh` 345 项测试、343 通过、0 失败、
  2 跳过，M1–M4 验收、彩排、语料回归、规模检查全部通过。
- macOS / Node v20.20.2 / npm 10.8.2（与服务器同版本）：同一套 345/343/0/2，全部通过。
- 服务器（Linux 6.8 x86_64 / Node v20.20.2）全新 clone `9b2e86f`：345 项测试、343 通过、
  0 失败、2 跳过，`VERIFY_EXIT=0`，全部检查通过；运行后 `/tmp/agentgate.*` 为空。
  这次运行是在两个 root 所属的旧固定名文件**仍然存在**的情况下跑通的，随后才删除它们，
  说明修复不依赖“先把机器清理干净”。`/opt/agentgate` 有意保留的未提交改动没有被触碰，
  本轮没有执行 `--apply`、没有重启服务、没有重建公开索引。
- CI（ubuntu-latest / Node 24）在 `9b2e86f` 上 test、action-verify 通过（pages 被随后的推送
  取消，不是失败）。新增两个作业：`minimum-node`（Node 20 跑测试与彩排）和 `docker`
  （`docker compose up --build` 后用 `scripts/smoke.mjs --expect-min 300 --allow-stale` 验收）。
  两者在 `e3b7738` 上首次运行即通过，同一提交的 test、pages、action-verify 也全绿。

版本边界：本轮没有部署。服务器 `/opt/agentgate` 仍是 `5b06c01` 加上它有意保留的未提交改动，
公开索引、公开页面、systemd 单元和人工复核基线都没有变化；`packages/collect/provenance.mjs`、
复核基线的 `BASELINE_VERSION = 2`、guard 的可靠性修正目前只在 GitHub 与本机。因此复核基线
v1→v2 的迁移**尚未发生**：`data/reviewed-criticals.json` 里的 11 条没有 `schemaVersion`，
新代码会打印 `LEGACY BASELINE`，不复用这 11 条（`for (const entry of legacy ? [] : oldEntries)`），
当前的高/危发现全部按新发现处理并退出非零，直到人工重读后 `--accept` 重新记录
（绑定 finding 身份 + 精确版本 + 扫描输入 SHA-256）。在那之前不声称迁移完成。

## 部署到服务器与复核基线 v1→v2（2026-09-17）

用户确认后把 `bc1ae3e` 部署到 `/opt/agentgate`，并按目标记录完成复核基线迁移。

部署过程：

- **部署前逐文件核对**：服务器工作区那 4 个 `M`（`scripts/build-site.mjs`、`site/index.html`、
  `site/try.html`、`site/sitemap.xml`）与 3 个未跟踪但上游已跟踪的路径（`packages/inventory/`、
  `site/inventory-page.mjs`、`site/inventory.html`）与上游 `bc1ae3e` **逐字节相同**；
  `data/reviewed-criticals.json` 也与上游相同。所谓“承重的未提交改动”没有任何上游没有的内容。
- **备份**：`/var/backups/agentgate-deploy-20260917T021506Z.tgz`（整个 `/opt/agentgate`）、
  `/var/backups/zhiliang-deploy-20260917T021506Z.tgz`（`/var/www/zhiliang`），外加部署前的
  `git status` / `git diff` 文本；三个被移开的路径原样保留在
  `/var/backups/agentgate-pre-deploy-20260917T021506Z/`，与 checkout 出来的版本逐字节相同。
- `git fetch` + `git merge --ff-only`（第一次因为工作区改动被拒，按计划先 `git checkout --` 那 4 个
  文件再合并），HEAD 到 `bc1ae3e`。部署后整棵树与全新克隆逐文件比较（排除 `.git` 与 `data/`）
  **没有差异**；`data/` 下的采集产物（`index.json`、`census.*`、`guard-scan.json`、`history/`）没有被触碰。
  上一轮的旧固定名残留 `/tmp/agentgate.service.new`、`/tmp/agentgate-caddy-block` 已在部署前删除。
- 服务器上全新克隆 `bc1ae3e` 跑 `scripts/verify.sh`：345 项测试、343 通过、0 失败、2 跳过，全部检查通过。
- `systemctl restart agentgate` 后 `/health` 返回新的 2,072 条索引（`generatedAt` `2026-09-17T02:16:20.314Z`）。

索引重建（新代码第一次跑完整 cron 链）：

- `refresh --max 300`：census 2,072 个服务器，guard-scan 238 个包（clean 221 / findings 6 /
  metadata-unavailable 11）；census 明细 auditedNpm 238、auditedPypi 38、remoteOnly 1,781、
  notAuditedPackages 15。
- **结论分布大幅变化**：`clean 1991 → 195`、`incomplete 60 → 1845`、`findings 30 → 32`。
  原因是 `build-index.mjs` 现在真的使用 census 一直在记录的 `audited` 标志：1,781 个没有可审计包的
  remote-only 服务器只有一个 `registryDocument` 块，状态是 `unmeasured`（reason `not-audited`），
  而旧代码把“没有 findings”当成 clean 发布。这正是该提交的自我说明“证据不再夸大自己”，
  首页原本写的就是“查不到的我会写成‘没查到’，不写成干净”。
- 快照 `data/history/diff-2026-09-17.md`：verdict changed 1,807、silent 1,803，并且明确写着
  `the scanner changed between these two snapshots: 5b06c01 -> bc1ae3e` 与
  “so some of what follows may be ours rather than theirs, and nothing here says which”——
  没有把扫描器自己的改动算到别人头上。
- `build-site.mjs`：evidence.html 503 KB / 2,072 条、2,072 张 server 页、738 张 publisher 页、
  sitemap 2,816 条；`inventory.html` 因为内嵌新索引变成 1.5 MB。
- 公网核对：`/health` 2,072；`/v1/index/summary` `{clean:195, findings:32, incomplete:1845}`；
  `/`、`/evidence.html`(503 KB)、`/inventory.html`(1.5 MB)、`/pricing.html`、`/try.html` 全 200；
  evidence 页上的计数与 summary 一致；`/badge/ai.dinglebear%2Fcortex.svg` 200 且显示 findings；
  `/s/ac.inference.sh__mcp.html` 200。
- 上一轮遗留的两件事在这一轮修掉了（提交 `5020173`、`977f113`，服务器已到 `977f113`）：
  - **孤儿页**：`build-site.mjs` 原来只写不删。`/var/www/zhiliang/s` 有 2,107 个页而索引是 2,072 条，
    35 张是被移除或改名的旧记录留下的页；`/o` 754 个文件里也有 16 个同类。现在两个目录都被收敛到
    本次构建产生的集合，且只删这两个目录里的 `*.html`——输出目录里还有个人主站的 `releases/` 和手写的
    根页面，测试专门断言旁边的非页面文件不会被删。重新构建后：`s` 2,107 → 2,072、`o` 754 → 738，
    索引里每条记录恰好一张页、stale 0；公网核对被删的旧页现在 404，仍在索引里的页 200，sitemap 2,816 条。
  - **临时目录**：测试与验收脚本原来都用 `mkdtempSync` 建目录且从不删除。服务器 `/tmp` 曾积到 **557 个**
    `ag-*` 目录（macOS 在 `$TMPDIR`、CI 在容器里，都不显眼）。现在 `test/tmpdir.mjs` 与
    `scripts/scratch-dir.mjs` 把删除登记在进程退出上（断言失败或提前 `process.exit` 也会清理），19 个
    测试文件与 5 个脚本全部改用它。用私有 `TMPDIR` 跑完整 `verify.sh`：**剩下 0 个**（只有 node 自己的
    `node-compile-cache`，服务器上是 0）。

复核基线 v1→v2（本轮完成）：

- 新代码先跑一次（不带 `--accept`）：打印 `LEGACY BASELINE`，
  `high/critical findings: 24 | reviewed: 0 | new: 24`，退出 1，旧基线未被改写。24 条 = 11 条
  `install-hook-script-critical`（critical）+ 13 条 `install-time-execution`（high）；旧脚本只覆盖 critical，
  新脚本覆盖 high 与 critical。
- 重读方式：从 npm 逐个拉取已发布 tarball，读 `scripts/install.js`（11 个）与 `package.json` 的
  `postinstall`（13 个）。11 个 install 脚本都是同一形状：http(s) 下载对应平台 release 二进制、`tar` 解包、
  `chmodSync 0o755`、`spawnSync` 执行（yarr 还会执行 `--version` 自检）；13 条 high 的 postinstall 分别是
  `node scripts/install.js`、`node install.js`，以及 `ai.etincel/etincel-nonfiction` 的内联
  `node -e ... execSync('npm run build')`。证据与结论一致。
- `--accept` 写入 24 条，每条绑定 server/block/rule/file/severity + evidence 文本 + 精确包版本 + 扫描输入
  SHA-256；随后补上每条 note（脚本会保留）。再跑一次：`24 | reviewed: 24 | new: 0 | changed: 0 | cleared: 0`，
  退出 0（本机对着线上索引、以及服务器本机各跑一次）。
- 基线提交为 `6bb3557` 并推送；服务器 `git merge --ff-only` 到同一提交后重跑，同样 24/24、退出 0。
  每天的 cron 仍然**不带** `--accept`：任何一条证据、版本或扫描内容变了，它就会重新报 changed 并退出 1。
- 迁移期间观察到的行为（本轮没有改）：旧基线没有 `schemaVersion`，新脚本按设计整体忽略它，
  因此 `--accept` 不会把旧 note 带过来（写入的是空 note）。这会把“必须重新读一遍”变成强制；本轮由人工
  把 24 条 note 写回。若希望将来迁移自动保留 note，需要显式修改脚本。

仍然没有验证的边界：Windows；Docker 只在 CI 跑过（本机与服务器都没有 docker）；服务器上的
Caddy 配置（本轮没有改 Caddy，也没有跑 `--apply`）。

仍然没有验证的边界：Windows（部署相关测试依赖 `bash`）；服务器上真正的 `systemd` 与
`caddy validate`/`reload`（本轮只跑彩排，没有 `--apply`）；公网页面本轮没有改动。

## 采集账本：把“我们一直在盯”变成可核对的记录（2026-09-17）

历史是这个产品唯一随时间增值的资产，而在这之前它只有一个“上次快照”和按天覆盖的 diff：没有任何东西能证明某天的记录是那天写的而不是今天补的；一天没跑，那天就永远没了，也没人会发现。

新增 `packages/history/src/ledger.mjs` 与 `agentgate history`：

- 每次采集向 `data/history/ledger.jsonl` **只追加**一行：采集时间、条数、结论分布、扫描器提交、所采索引文件的 SHA-256，以及上一行的哈希。
- 当次索引按内容存到 `data/history/snapshots/<sha256>.json`（相同内容只存一份）；当天的 `YYYY-MM-DD.json` 由当天第一次采集写入，之后不再改写。
- `agentgate history --verify` 重算链与每个保留快照：篡改退出 1，被清理掉的快照报“未保留”而不是篡改（清理是存储决定，链仍然证明那天采过）。
- 每行的数字与它指向的快照逐项比对（条数、结论分布）——最后一行没有后继可以断链，只能靠这一条覆盖。
- `agentgate history --backfill` 从已有的按天归档重建账本；重建不出没有归档的那天，那正是它要报出来的缺口。
- **账本本身发布到公开站点**：`/history.html` 由 `build-site.mjs --history <dir>` 生成（默认 `data/history`），列出全部采集、覆盖天数、**照原样列出的缺口**，并把账本原文放进 `<pre>`；首页导航和 `sitemap.xml` 都指向它。它证明的不是结论正确，而是这条记录事后没有被改写——磁盘上的账本改了，会和已发布的一份对不上。

本机：`scripts/verify.sh` 通过（355 项测试、353 通过、0 失败、2 跳过，含 8 条账本测试与 1 条 CLI 测试）；私有 `TMPDIR` 下残留仍为 0。

服务器：部署后 `history --backfill` 用已有的两天归档播种账本，`history --verify` 退出 0。

## 采集账本的第二轮：不丢天，并且放到第二个位置（2026-09-17）

账本上线后还剩两个洞：**一天没采集没人知道**，以及**账本和站点在同一台机器上**（所以“已发布的一份”并不算外部锚点）。这一轮补上这两条。

- **不丢天**：`scripts/daily-job.sh`（版本化，不再靠机器上的手抄 cron 链）把所有步骤写成互不连累的一组，refresh 失败也照样把盘上已有的索引记成一次采集；`daily-snapshot` 只在记录真的变了时才追加一行，所以同一天可以安全地跑多次。`deploy/cron.d-agentgate` 是 `17 4,8,12,16,20 * * *`，一天五次，夜里那次失败最多损失几小时。
- **迟到会自己暴露**：`history --max-age 26` 把“最近一次采集有多旧”变成退出码；`/health` 新增 `history` 块（captures / days / first / last / gaps / ageHours / stale），外部监视不用读这台机器上的文件就能发现停摆。
- **第二个位置**：`/v1/history` 按原样返回 `ledger.jsonl`，`/v1/history/diff` 返回最新一天的 diff。GitHub 的 `pages` 工作流改成**镜像**这份账本：拉取 → 用仓库自己的 `history --verify` 核对链 → 以**普通提交追加**到 `history` 分支（原来是一次性的单提交 + `--force`，而且 refresh 失败时会把 300 条的样本当快照写进去，那两条都已删掉）。站点那边 `build-site.mjs --history <dir>` 也从镜像出来的账本渲染公开页。
- 本机 `verify.sh`：360 项测试、358 通过、0 失败、2 跳过（新增：账本过期、重复运行的幂等、`/health` 的 history 块、`/v1/history` 与 diff 路由、daily-job/cron 的结构断言）。
- 服务器（Node v20.20.2）部署后：`daily-job.sh` 以 cron 用户手跑一次，refresh ok、账本因索引真的变了追加第 3 行、站点重建、`history --max-age 26` 与复核都通过，退出 0；`/health` 的 `history` 块为 `{captures:3, days:2, gaps:[], ageHours:0, stale:false}`；公开的 `/v1/history` 与 `/v1/history/diff` 都是 200，`/history.html` 显示“3 次采集，覆盖 2 天”。
- **CI 镜像第一次跑就暴露了两个错，都已修**：`cp "$WORK/ledger.jsonl" ledger.jsonl` 把文件拷到自己身上（临时目录就是当前目录），步骤直接失败；改成用 `$GITHUB_WORKSPACE` 的绝对路径。修完仍没记录——`git fetch --depth 1` 之后再 push 会被 GitHub 以 `shallow update not allowed` 拒绝，而 push 失败被 `|| echo` 吞掉了，所以步骤“成功”但分支没动；改成完整 fetch + `reset --hard FETCH_HEAD`（并顺手删掉旧方案写进分支的 2.4 MB 索引）。现在 `history` 分支上是一条普通提交 `ledger 2026-09-17`，带 `ledger.jsonl` 与最新 diff。

## 清单报告显示每个扫描器跑没跑（2026-09-18）

`scanExecution` 上线后，网站的证据页已经写清“哪些扫描器跑完了”，但用户自己生成的那份报告还没有。这一轮把它接到清单报告里，并顺手堵住一个矛盾：**证据块看起来完整、记录自带的覆盖块却说必需扫描器没跑完**。

- 报告每条工具新增“扫描覆盖”：状态、必需/跑完/没跑成的数量、每个扫描器的状态、输出是否可读、一致性与未跑成的原因；写于该块之前的记录显示“没有记录不等于跑完过”。版本未对应时，覆盖一节只描述目录记录。
- 匹配器新增规则：`scanExecution.scanner_execution` 存在但 `state` 不是 `complete`、没有必需的扫描器、必需扫描器未全部完成、计数与列出的组件不一致、或摘要记录为不匹配，一律不得进入 `matched`。
- **拿服务器上的真索引取证**（`/opt/agentgate/data/index.json`，2,057 条，全部带 `scanExecution`）：194 条 `clean` 仍然全部 `matched`，没有一条被新规则误杀；`ai.adeu/adeu@1.7.1` 报告显示“`complete` · 必需 2 个，跑完 2 个，没跑成 0 个”（registryDocument、packageManifest 都 completed）；`ai.dinglebear/apprise-rmcp@0.1.3` 仍按 `insufficient` 处理，但覆盖一节保留“`incomplete` · 必需 2 个，跑完 1 个，没跑成 1 个”。
- 用这份真索引跑一次静态构建：`inventory.html` 内嵌的索引带着 `scanner_execution`，`s/ai.adeu__adeu.html` 的“哪些扫描器跑完了”段落显示“必需 2 个,跑完 2 个,没跑成 0 个”。浏览器端用的 `inventory.mjs` / `inventory-report.mjs` 与仓库里是同一份复制。
- 本机 `npm test`：554 项测试、552 通过、0 失败、2 跳过（新增 4 条匹配器测试、2 条报告测试，并让转义夹具覆盖新的组件字段）。

## npm 可信发布：两次误报，两个真原因（2026-09-18）

Marketplace 上线后只剩 npm 一条路，0.2.1 → 0.2.2 → 0.2.3 试了三次。两个错误都指向别处，记下来。

- **v0.2.1：`404 Not Found - PUT`**。provenance 已签发并进了 Sigstore，PUT 被拒，看起来像权限问题。看源码确认：`actions/setup-node@v4` 只要设了 `registry-url` 就往 `.npmrc` 写 `_authToken=${NODE_AUTH_TOKEN}`，并在变量不存在时导出占位符 `XXXXX-XXXXX-XXXXX-XXXXX`；npm 11 优先用这个假 token，而不是 OIDC。v7 的同一段代码改成了"只有用户显式提供才导出"。
- **v0.2.2：清掉占位符后变成 `ENEEDAUTH`**。npm 的 `publish` 先调 `oidc()`，失败就静默返回，然后 `getCredentialsByURI` 拿不到凭证 → ENEEDAUTH。所以 **ENEEDAUTH 不代表"没走 OIDC"，而代表"OIDC 交换失败但没说出来"**。
- **不再猜**。临时加 `.github/workflows/oidc-debug.yml`（`workflow_dispatch`，不发布、不打印 token）：打印 `node`/`npm` 版本与 `ACTIONS_ID_TOKEN_REQUEST_*` 是否存在；用 `audience=npm:registry.npmjs.org` 换一个 OIDC token 并解出 claims；直接 POST 交换端点 `/-/npm/v1/oidc/token/exchange/package/@zhiliangtech%2fagentgate`，只打印状态码与错误 body。
- **结果**：`404 {"message":"OIDC token exchange error - package not found"}`——包明明在。claims 里 `repository_id=1374551755`（仓库 2026-09-17 删后重建，ID 变了），对照 npm 文档"仓库改名/转移后必须更新可信发布者"，判断绑定里留的是旧仓库身份。**删掉再重新添加**（GitHub / `ciceroyang` / `agentgate` / `publish.yml` / 无 environment / 允许 `npm publish`）后，同一条 `publish.yml`（tag `v0.2.3`）重跑，交换通过。
- **收尾**：`next`=0.2.3、`latest`=0.2.0；registry 回 `Your package is being processed and may take a few minutes`，约 30 秒后可见；SBOM 挂到 release；provenance 为 SLSA v1（`dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`）。诊断 workflow 已删除，v0.2.1/v0.2.2 的 release notes 改成如实说明（它们没有上 npm）。
- 附带确认：`.npmrc` 里那行即使把 `NODE_AUTH_TOKEN` 设成空串也仍然存在一个空的 `_authToken` 键，npm 会当成"有凭证"而不走 OIDC；发布步骤里直接删掉 `$NPM_CONFIG_USERCONFIG` 文件才干净。
- **仍然只有本人能做的**：npm 设置页的每次修改都要 security key 或 password。

## 产品上主域，个人站下到 cicero.（2026-09-18）

起因是品牌问题：根域 `智量.com` 一直是个人作品集，产品挂在 `app.` 下面。对 B2B 的安全产品来说，"把 app. 去掉"就看到一个人的简历，正是客户做尽调时最容易起疑的画面；而 npm scope（`@zhiliangtech`）、邮箱（`contact@智量.com`）、将来的主体都已经是公司身份。于是两边对调。

- **DNS**：新增 `cicero` A 记录 → 8.218.22.11（阿里云云解析）。新版控制台的"添加记录"抽屉对程序化提交不友好（试过点确定、真实键盘输入、回车、批量"添加条目"都不生成记录），最后是人在控制台点的；"导入 zone 文件"那条路故意没走——那个 zone 里有邮箱的 SPF/DKIM，不值得为一个 A 记录冒险。
- **Caddy**（`/etc/caddy/Caddyfile`，备份 `Caddyfile.bak-20260918`）：根域改为产品（静态页 `/var/www/zhiliang` + `/health`、`/v1/*`、`/badge/*` 反代 127.0.0.1:8080 + 同样的安全头与 HTML no-cache + 404 页面）；新增 `cicero.xn--5kvo87g.com` → 原个人站（含 `/api/guestbook` 反代 8788）；`app.` 改成"页面 301 到主域，API/badge 仍直连一段时间"。`caddy validate` 通过，`systemctl reload caddy` 后 Let's Encrypt 用 tls-alpn-01 给 `cicero.` 签发了证书（14:43:33）。
- **验收**（服务器上实测）：根域 `/`、`/pricing.html`、`/inventory.html`、`/security.html`、`/.well-known/security.txt` 全 200，标题为 `智量 · agentgate`；根域 `/v1/index/summary` 200；`cicero.` 的 `/`、`/field/` 200，标题为个人站；`app.` 页面 301 到主域、而 `app.` 的 `/v1/index/summary` 仍 200；`www.` 301。sitemap、robots.txt、security.txt 的 canonical 都指向主域。
- **仓库**：55 处 `app.xn--5kvo87g.com` 里，产品链接改成主域（README×2、`site/*`、`scripts/build-site.mjs`、`server.json`、两篇文章、pilot-package、data-handling、security.txt）；`docs/verification.md` 的历史条目保持原样（它是日志）；`deploy/Caddyfile` 同步成线上那份并改了说明（"为什么现在声明主域"）；`test/deploy.test.mjs` 的断言从"不许声明主域"改成"必须声明主域"，`test/security-assets.test.mjs` 的第三方域名白名单加上主域。全套 577 项测试、575 通过、0 失败、2 跳过；站点在服务器上重建（sitemap 2,800 条）。
- **还没跟上的**：npm 上 0.2.4 的 tarball 里 README 仍是旧链接（会 301，不影响访问），官方 MCP Registry 的 `websiteUrl` 也还是 `app.`——registry 拒绝重复版本（`cannot publish duplicate version`），要等下一个版本才能更新。两者都属于"下一个 patch 带上"的清单。

## 证据包（v0.3.0）：把"我们能给"变成可以交出去的东西（2026-09-18）

起因是对着市场做的深度研究（结论写在私有的 `next-leap-research.md`，不在这个仓库里）。要紧的一条是：运行时收据已经有开放标准（OVERT v1.1.0），它把"控制执行过没有"做到独立可验（AAL-4），但**第三方 AI 组件的台账只要求到 AAL-2，也就是运营方自述**，全文没有 BOM/SBOM。那一格空着，而它正好是出海 SaaS 被客户安全评审卡住的地方。于是这一版做的不是更多扫描，而是一个**可第三方复核的交付物**。

- **交付物**：`agentgate pack` 写一个目录——`pack.json`（机器可读）、`pack.html`（给评审人）、`answers.aicaiq.md`（逐题）、`manifest.txt`（逐文件 sha256）、`manifest.sha256`（manifest 的封条）。`pack --verify <dir>` 重算全部哈希与封条。规范：[docs/spec/evidence-pack-v1.md](spec/evidence-pack-v1.md)。
- **答案状态是算出来的，不是写出来的**：9 个证据类（工具身份、精确版本、内容哈希与覆盖范围、包元数据、扫描执行记录、变更历史、归档可校验、覆盖范围记账、网关事前决策）在生成时逐条判定，`owner === "we"` 的条目必须声明至少一个证据类，声明了但没实现或实现了但没声明都由测试拦住（`classContractProblems`）。
- **AI-CAIQ 从 16 条能力级扩到 58 条条目级**（STA 19、CCC 11、LOG 21、A&A 7，与官方域计数逐一对上）：13 条我们出证据、41 条你们自证、4 条第三方。题目说明、我们能给什么、边界全部手写；状态全部来自数据。官方原文没有转载（许可原因）。
- **负例测试 17 项**（`packages/pack/test/pack.test.mjs` 11、`test/pack-cli.test.mjs` 6）：幂等（同一输入两次生成字节一致）、篡改（改 `pack.html` 一个字节 → `--verify` 退出 1 并指名文件）、缺 `manifest.txt` → 退出 2、凭据型输入（`mcpServers` + `TOKEN`）被拒且一个字符都不出现在 stdout/stderr/产物里、非空目录不覆盖、未测计数必须出现在 `pack.html` 顶部、禁用词（已合规/已满足/认证通过…）不得出现、引用完整性断链即生成失败、58 条必须全部归类。
- **退出 0 是被证明可达的，不是许愿**：`--archive`（两次快照）+ `--calls`（可解析的调用日志）+ 一条能对上的工具时，13 条我们出证据的答案全部 `measured`，命令退出 0。少任何一项就退 2。
- **样例包（用线上索引生成，提交在仓库里）**：`docs/samples/evidence-pack-example`，索引 `2026-09-18T04:17:45.595Z` / scanner `192046f` / 2,055 条记录；8 项工具里 6 项对上；58 条里 13 条是我们的（测到 0、部分测到 13），因为清单里有一个内网服务器和一个钉在 `latest` 的项——**一条核不了的工具会让所有依赖它的答案变成"部分测到"**。`pack --verify` 退出 0。
- **测试抓出来的两个错**（都是"看起来完成了其实没有"的那一类）：① `--index` 显式指定却指向不存在的文件时，`resolveIndex` 会静默回落到随包发布的样本索引，于是给客户的包建立在演示数据上——改成"显式指定就是决定"，并把"这份是历史样本"的警告打出来；② 归档/链路这类**上下文级**证据类原本把清单里每一条都算作"有依据"，包括根本没对上的那条——改成只覆盖对上的条目，对不上的写进未测原因（"这一条没有对上索引记录，这一类的证据覆盖不到它"）。
- **全套**：594 项测试、592 通过、0 失败、2 跳过（新增 17 项）。零依赖、不联网、不执行被检查的东西这些不变量没有变。

### 发布 0.3.0（同日）

- `git push origin main` → `427a9e8`；打 `v0.3.0` 推 tag，触发 `publish.yml`（39 秒，全绿）：测试 → 校验 tag 与版本一致 → 自产 SBOM → `npm publish --tag next`，provenance 写进 sigstore 透明日志（logIndex 2883683091）。
- **npm 传播有延迟**：发布后立刻查 `registry.npmjs.org` 还是 404、`npm view` 仍是 next=0.2.5；约一分钟后 registry 直连可见 0.3.0（tarball、SLSA v1 provenance 齐全），dist-tags 变成 latest=0.2.4 / next=0.3.0。判断发布成功要用 workflow 日志里的 `+ @zhiliangtech/agentgate@0.3.0`，不能只看 registry 立刻返回什么。
- **MCP Registry**：`/tmp/mcp-publisher publish` 先报 401（`token is expired`——registry 的 JWT 活得很短）。用 `mcp-publisher login github -token $(gh auth token)`（CLI 支持 `-token` 传 PAT，不必走设备码）后重发成功：`io.github.ciceroyang/agentgate` 0.3.0。
- **GitHub Release**：`publish.yml` 只在 release 已存在时挂 SBOM，所以这次它打印的是 `no GitHub release for v0.3.0`。手动 `gh release create v0.3.0` 后把 workflow 产物（artifact sbom）里的 `agentgate.cdx.json` 上传上去。
- **LobeHub**：`npx @lobehub/market-cli@0.0.41 plugin update --dir .` → `Updated ciceroyang-agentgate (0.2.5 → 0.3.0)`。
- **还没做的**：latest 仍停在 0.2.4。提升 dist-tag 需要浏览器 2FA，属于只有本人能做的步骤（`docs/operations/publish-checklist.md` 里有记录）。

## 1.0 的门 1 与门 2：把承诺写下来（2026-09-18）

roadmap 里新写的一节把 1.0 定义成五道可验收的门。这一轮做掉的是前两道——它们都不是功能，而是**把已经做到的事写成可被检验的承诺**。判据来自门表自己写的缺口：门 1 缺「`SECURITY.md` 和写下来的支持窗口」，门 2 缺「五个 spec 都没有兼容承诺、没有升级指南、没有支持版本政策」。

- **门 1**：新增 `SECURITY.md`——报告渠道（邮箱 + GitHub 私密报告）、回应节奏（3 个工作日内确认、10 个工作日内给评估，之后给修复或书面解释）、**明确写了没有赏金**、在范围内/外的边界（第三方 MCP server 的漏洞不是我们的，但**我们对它的描述不准**是我们的）、以及我们自己可被检验的性质（零运行时依赖、读本机的路径不联网、不读凭据、不执行被扫的代码、崩掉的检查不可能变成 `clean`）。写之前先查了 GitHub 的私密漏洞报告开关：`gh api repos/ciceroyang/agentgate/private-vulnerability-reporting` 返回 enabled=false，于是用 `PUT` 打开，再查为 enabled=true——文档里写的渠道必须真的存在。
- **门 2**：新增 `docs/spec/compatibility.md`，把五种格式逐个写清版本标识与稳定性（policy / scan-execution / inventory / MCP 工具面 = frozen；**evidence-pack = provisional**，因为还没有人拿它给外部评审人看过），并定下：v1 内只许附加式变更；**一个不认识的值必须当成未测到、绝不能当成通过**（这条既是产品不变量，也正好是兼容规则）；破坏性变更要新标识 + 迁移说明 + 至少一个小版本两种都能读；弃用要有 `Deprecated` 节并提前一个小版本；0.x 期间小版本可以含破坏性变更，但必须有 `Breaking` 节；支持窗口是 `latest` 加之前一个小版本线、新小版本顶上来后再保 90 天，`next` 不承诺——并写明只有一个人维护，这是意图不是 SLA。
- **升级路径**：新增 `docs/operations/upgrade.md`，**每个已发布版本**一节（10 个）。其中 0.1.1 那节留成了范例：那次「采用检查变严格」让退出码从 0 变成 2，输出一个字没变，**看起来不像破坏性变更**——升级建议是把退出码当三种结果而不是两种，并把 2 也当成失败。0.2.0 那节写的是另一类：0.1.x 的 provenance 指向的提交在仓库里已经不存在，所以只能用 0.2.0 及以后。
- **五个 spec 各自加稳定性段**，写明标识、frozen/provisional、允许什么变更、指向政策与升级路径。
- **新增 `test/governance.test.mjs`（4 项）**把这些承诺钉住：每个 spec 必须声明稳定性且在政策表里；政策里印的标识必须等于代码导出的常量（`POLICY_VERSION`、`SCAN_EXECUTION_VERSION`、`PACK_SCHEMA`）；**升级指南与 CHANGELOG 的版本集合必须完全一致**（少写一节就红）；`SECURITY.md` 必须存在、有邮箱、指向支持窗口，且不许把「没有赏金」留成暗示。
- **两处顺带**：`docs/operations/README.md` 加了「手上有旧版本，想知道升级要不要动手」一行（该目录每一页都必须被索引链到，有测试）；roadmap 的门表把前两道标成 2026-09-18 关闭，并写清关掉的是文档与政策，不是功能。
- **全套**：598 项测试、596 通过、0 失败、2 跳过（新增 4 项治理测试）。

## 链的推进：仓库级记录并进索引，两个分母分开报（2026-09-19）

起因是一个实测数字：GitHub 上带 `topic:mcp-server` 的仓库有 **16,985** 个（完整枚举、未截断），其中**只有 95 个（0.6%）出现在我们索引里**。也就是说，一家公司在 GitHub 上公开了 MCP server，我们的索引里可能一条记录都没有——我们上周写信的那 5 家国内公司（Zilliz / Kyligence / TextIn）就是这种情况。

- **全量分类**：16,890 个仓库逐个拉递归文件树（每仓库 1 次请求、**不占搜索配额**，77 分钟到 2 小时 49 分两次跑完）。第一版规则（文件名里有 `server` 或 `mcp`）给出 13,304 个「server-like」——**这个数是错的，而且证据在同一份数据里**：`reactive-resume` 命中 `apps/server/src/app-version.ts`（Web 应用）、`pascalorg/editor` 命中 `...server.test.ts`（测试文件）、`0xjacky/nginx-ui` 命中 `e2e/...spec.ts`。原因很朴素：几乎每个 Node 项目都有 `server.ts`。
- **收紧后的规则**（路径里必须含 `mcp`，或有 `mcp.json`/`smithery.yaml` 描述文件）= **9,585 个（56.7%，上界）**；从中等距抽 40 个、把命中路径全列出来**逐个人工判**：是 MCP server 的 27 个、不是的 6 个（客户端/宿主/示例/控制面）、证据不足 4 个 → **精度约 73%**，即我们看不到的真正 MCP server 约 6,500–7,300 个。
- **合并规则**（写进 `packages/collect/src/repository-records.mjs`，6 项测试）：身份优先级 注册表名 → 包坐标 → 仓库 URL；注册表已覆盖的仓库不再新增；**重复身份是错误**；**仓库记录永远不可能是 `clean`**（`packageManifest` 组件是 `skipped`，reason `package-not-inspected`）；每条判定带 sha256 与写明的 scope。
- **本机三道闸全过**：建站 **3.58 秒**、11,620 个服务器页 + 7,938 个发布者页、sitemap 19,569 条 URL、磁盘 146 MB；服务 `/v1/servers` **1.2–4.7 ms**、RSS 212 MB。
- **上线（2026-09-19）**：服务器 `git pull` 到 `c89b9d2` → 把本地产出的两个产物（`github-census.json` 9.35 MB、`repository-classification.json` 3.1 MB）放到 `/opt/agentgate/data/` → `refresh --max 300` → 索引 **11,618 条**（注册表 2,033 + 仓库 9,585）→ 重建站点（`/var/www/zhiliang` 155 MB、11,618 个页面、sitemap 19,566）→ **重启 systemd 服务**（这一步不能省：`/v1/index/summary` 一开始没有 `sources` 字段，因为跑的还是旧进程）。
- **公开实测**：证据页显示「注册表条目 2033: clean 190 · findings 32 · incomplete 1811 ｜ 仓库记录 9585 条（只读公开元数据，按设计不可能是 clean）」；仓库记录页 200（`/s/github.com__0-soft__2captcha-mcp.html`）；`/v1/index/summary` 返回 `sources.registry` / `sources.repositories` 两个块（未测原因 `no-package-declared-in-repository` 9,585）；badge 200；服务器侧 `verify-public.mjs` **全过**。
- **配套**：`refresh --repositories` 是慢的那一半（census 用 `--since` 做增量、分类只重取 `pushed_at` 变过的仓库），加了测试；不带这个 flag 时索引与以前完全一致。`docs/operations/README.md` 加了每周一行的节奏说明；两篇文章各加了一段注明索引已变、两个分母分开显示。
- **全套**：614 项测试、612 通过、0 失败、2 跳过（新增 8 项）。




