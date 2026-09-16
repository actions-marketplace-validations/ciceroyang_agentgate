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
#      主域的另一个站点与产品共存,Caddy 会为四个名字各自签发证书

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
另一个站点    未改动; 改动前备份 /etc/caddy/Caddyfile.bak.*
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
- README、试点材料和数据处理草稿已统一已实现能力、材料要求与尚未验证的运营边界。

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

仍然没有验证的边界：Windows（部署相关测试依赖 `bash`）；服务器上真正的 `systemd` 与
`caddy validate`/`reload`（本轮只跑彩排，没有 `--apply`）；公网页面本轮没有改动。

