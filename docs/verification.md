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
