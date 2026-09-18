# 部署手册：阿里云 + 智量.com

*目标：一条命令部署，一条命令回滚，数据（尤其是历史）不丢。*

## 架构

```
                ┌──────────────────────────────┐
  公网 80/443 → │ Caddy（自动 TLS，反代）        │
                └───────┬──────────────┬───────┘
                        │              │
              app.智量.com          api.智量.com
                        │              │
                ┌───────▼──────────────▼───────┐
                │ agentgate serve  :8080        │
                │  读 data/index.json           │
                └───────────────┬──────────────┘
                                │
                ┌───────────────▼──────────────┐
                │ 定时任务：采集 → 索引 → 快照   │
                │   data/index.json             │
                │   data/history/YYYY-MM-DD.json│
                └──────────────────────────────┘
```

## 前置

- 服务器：Linux x86_64 或 arm64，2 vCPU / 4 GB 起（索引与历史都很小，瓶颈在网络）。
- 安全组放行：22（或自定义 SSH 端口）、80、443。
- DNS：`A` 记录指向服务器公网 IP。中文域名在配置里一律用 punycode。
- **2026-09-18 起,产品就是主域**：`xn--5kvo87g.com` 提供落地页、证据索引和 `/v1`；个人网站搬到了
  `cicero.xn--5kvo87g.com`；`app.` 只作旧地址保留(页面 301 到主域，API 仍直连一段时间)。

```
# 产品需要这两条 —— deploy/Caddyfile 声明了它们,所以主域必须有证书:
xn--5kvo87g.com          主机记录 @      类型 A   值 <公网IP>
app.xn--5kvo87g.com      主机记录 app    类型 A   值 <公网IP>   # 旧地址:页面 301,API 直连

# 个人网站(Next.js)现在在这里,不属于 agentgate 的部署块:
cicero.xn--5kvo87g.com   主机记录 cicero 类型 A   值 <公网IP>

# 操作者的重定向,同样不在部署块里:
www.xn--5kvo87g.com      主机记录 www    类型 A   值 <公网IP>
```

**为什么部署块现在声明主域**:2026-09-18 之前主域是个人网站，所以旧版 `deploy/Caddyfile` 刻意避开它；
那天两边对调(产品上主域、个人站下到 `cicero.`)，不声明主域就会装上去没证书。
**没有 `api.`、`docs.` 和 `try.`**:文档留在仓库里；在线试用页面在主域的 `/try.html`(即 `xn--5kvo87g.com/try.html`)。
等有了内容再加子域,不要为了占位建一条指向空目录的记录。


### 怎么加这两条记录（阿里云云解析，逐步）

**最少要加 `@` 和 `app` 两条**——主域是产品主页,旧地址 `app.` 保留 301 与直连 API
(`/v1/*`、`/health`、`/badge/*`)。个人站要一起上线的话再加 `cicero` 一条。

**方式一:控制台点**

1. 浏览器打开 <https://dns.console.aliyun.com>(或:阿里云控制台 → 搜"云解析 DNS")。
2. 在域名列表里找到 `xn--5kvo87g.com`(可能显示成 `智量.com`),点右边 **解析设置**。
3. 你会看到已有的记录:`@`、`www`(值都是 `8.218.22.11`)——**这两条不要动**。
4. 点 **添加记录**,只填这几个框:

   | 框 | 填什么 |
   | --- | --- |
   | 记录类型 | `A` |
   | 主机记录 | `app` ← **只写 app**,不要写 `app.`,更不要写整个域名 |
   | 解析线路 | 默认 |
   | 记录值 | `8.218.22.11` |
   | TTL | 默认(10 分钟) |

5. 点 **确认**。个人站要一起上线的话,重复第 4 步,主机记录换成 `cicero`,其余一样。
   (2026-09-18 实测:新版控制台的"添加记录"抽屉对程序化提交不友好——用键盘正常填、点确认就行。)

**方式二:一条命令(阿里云 Cloud Shell,已登录状态)**

打开 <https://shell.aliyun.com>,粘贴:

```sh
aliyun alidns AddDomainRecord --DomainName xn--5kvo87g.com --RR app --Type A --Value 8.218.22.11
# 个人站(可选):
aliyun alidns AddDomainRecord --DomainName xn--5kvo87g.com --RR cicero --Type A --Value 8.218.22.11
```

输出里有 `RecordId` 就是成功;如果报 `DomainRecordDuplicate` 说明已经有了。报权限错就用方式一。

**怎么知道加对了**:等 1–10 分钟,在这台机器上执行 `nc -vz -w 5 app.xn--5kvo87g.com 443`,
看到 `succeeded` 就说明解析生效了。也可以直接告诉我,我从外网查。
**主域已经换过了(2026-09-18)**:那天把个人站搬到 `cicero.`、产品搬到主域,同时给 `app.` 加 301。
改动是手改 `/etc/caddy/Caddyfile` + `systemctl reload caddy`(备份留在 `/etc/caddy/Caddyfile.bak-20260918`),
仓库里的 `deploy/Caddyfile` 同步成同一份内容;回滚就是把备份装回去再 reload。

**大陆服务器需要 ICP 备案才能用 80/443**，走 [plan-b-no-icp.md](plan-b-no-icp.md)。

**从大陆服务器克隆 GitHub 经常不通,而这是部署的第一步。** 预演会先测三个地方并告诉你哪个不通:

```sh
bash scripts/onboard-server.sh              # 预演,含网络预检
```

仓库主机不通时,换镜像(脚本会照你给的这个 URL 去克隆):

```sh
sudo bash scripts/onboard-server.sh --apply --repo https://gitee.com/<你的镜像>/agentgate
```

完全离线或不想等超时:`--skip-network` 跳过预检。
MCP 注册表或 npm 不通不会让部署失败——索引会退回提交里的样本,并在输出里说明"这是样本"。

## 实测耗时（2026-09-15 彩排）

从公开仓库全新 clone 到冒烟通过，在本机（macOS，arm64）实测：

| 步骤 | 耗时 |
| --- | --- |
| clone + 克隆内测试 | 约 30 秒 |
| **全量 refresh（采集 + 包扫描 + 建索引）** | **2 分 4 秒** |
| serve + 冒烟 | 约 5 秒 |

原先文档里写"约十分钟"是保守估计，实际快得多。瓶颈是网络而非算力。

彩排结果：243 个包被扫描，索引 2,127 条（2039 clean / 66 findings / 22 incomplete），第一份历史快照与 diff 正常生成，冒烟全绿。

## 选哪条路：先看这个

有两条部署路径,**优先用第一条**,理由不是偏好而是验证状态:

| 路径 | 验证状态 |
| --- | --- |
| **Node + systemd** | **已在公开仓库上完整彩排过**(clone → 采集 → 服务 → 冒烟全绿) |
| Docker compose | 只能验到"构建上下文里文件齐全、镜像的 CMD 能跑";**镜像分层构建本身没验过**,因为写这份文档的机器上没有 docker |

所以默认走 Node + systemd。除非你明确想要容器,否则不要在第一次部署时引入一个我们没能验证的环节。

## 部署步骤（Node + systemd，已验证）

```sh
# 1. 基础环境
sudo apt-get update && sudo apt-get install -y git curl
#   需要 Node 20+；用 nvm 或 nodesource 装，不要用发行版自带的旧版本

# 2. 取代码
sudo mkdir -p /opt/agentgate && cd /opt/agentgate
git clone https://github.com/ciceroyang/agentgate .

# 3. 首次采集（实测约 2 分钟）
node bin/agentgate.mjs refresh --max 300

# 4. 起服务（先手动确认，再交给 systemd）
node bin/agentgate.mjs serve &
node scripts/smoke.mjs http://127.0.0.1:8080 --expect-min 1000
kill %1

# 5. 主域是静态站，得由仓库里的脚本生成
#    跳过这一步，Caddy 起来也是一个空页面：它 serve 的目录没人创建。
sudo mkdir -p /var/www/zhiliang /var/www/zhiliang-docs
node scripts/build-site.mjs --index data/index.json --out /var/www/zhiliang --name evidence.html --pages site
#    证据索引链到样例报告，在线上不能是死链
node bin/agentgate.mjs check --root examples/action-verify \
  --policy examples/action-verify/agentgate.policy.json \
  --format html --out /var/www/zhiliang/report-sample.html || true

# 6. 交给 systemd
sudo useradd -r -s /usr/sbin/nologin agentgate || true
sudo chown -R agentgate:agentgate /opt/agentgate
#    单元文件里 node 是绝对路径。手册推荐 nvm，而 nvm 装的 node 不在 /usr/bin，
#    直接 cp 过去会让 systemctl 报 "No such file or directory"。
which node
sudo sed "s#^ExecStart=.*#ExecStart=$(which node) bin/agentgate.mjs serve#" \
  deploy/agentgate.service | sudo tee /etc/systemd/system/agentgate.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now agentgate
systemctl status agentgate --no-pager | head -5
```

## 如果服务器是 Alibaba Cloud Linux / CentOS(RHEL 系)

**阿里云 ECS 的默认镜像就是这一系,不是 Ubuntu。** 差别有三处,第三处最容易卡住。

```sh
# 1. 装包命令是 dnf(脚本会自动识别,不用你改)
sudo dnf install -y git curl

# 2. 装 Node 20+ —— 别用发行版自带的旧版本
sudo dnf module install -y nodejs:20/common    # 或按 NodeSource 官方文档加仓库
node --version                                   # 必须 >= 20

# 3. SELinux 默认 Enforcing,而 Caddy 是第三方单元,会被它挡住
getenforce                                       # Enforcing 才需要处理下面两条

# 让 Caddy 能反代到 127.0.0.1:8080
sudo setsebool -P httpd_can_network_connect 1

# 给它服务的静态目录打对标签
sudo semanage fcontext -a -t httpd_sys_content_t "/var/www/zhiliang(/.*)?"
sudo restorecon -R /var/www/zhiliang
```

**SELinux 挡住时的症状**:服务在本机 `curl 127.0.0.1:8080/health` 是好的,Caddy 却返回 403 或 502。确认方式:`sudo ausearch -m avc -ts recent | tail`。

临时验证可以用 `sudo setenforce 0` 看是不是它;确认之后**要把它调回 Enforcing 并用上面的规则解决**,不要长期关着。

**Docker 这条路在这一系上没验过**(基础镜像与仓库都要换)。直接用 Node + systemd 路径,那条是完整彩排过的。

## 部署步骤（Docker，未验证）

```sh
# 1. 基础环境（Ubuntu/Debian）
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git curl
sudo systemctl enable --now docker
#    RHEL 系（阿里云默认镜像）没有 apt-get,而且 SELinux 默认 Enforcing:
#    先看本文开头的 RHEL 一节,再回来走这条。

# 2. 取代码
sudo mkdir -p /opt/agentgate && cd /opt/agentgate
git clone https://github.com/ciceroyang/agentgate .

# 3. 首次采集（会产生 data/index.json 和第一份历史快照，约十分钟）
sudo docker compose --profile collect run --rm refresh

# 4. 起服务
sudo docker compose up -d agentgate
curl -s localhost:8080/health
```

## 现成的部署文件

- `deploy/Caddyfile` — 复制到 `/etc/caddy/Caddyfile`，域名已用 punycode 写好；
- `deploy/agentgate.service` — 不用 Docker 时用 systemd 直接跑（只读运行）；
- `scripts/onboard-server.sh` — 先预演再执行；
- `scripts/smoke.mjs` — 部署后检查。

**一个有用性质**：服务每次请求都重读索引文件，所以 `refresh` 之后**不需要重启服务**，新数据立刻生效。

## Caddy（自动 HTTPS）

**不要手抄这段配置。** 直接复制仓库里的 `deploy/Caddyfile`,它是唯一的一份;
这一节原来贴过一份手抄件,已经漂移了(漏了 `docs.`,也没有日志与 SELinux 的说明)。

```sh
sudo cp /opt/agentgate/deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile     # 先验语法,再 reload
sudo systemctl reload caddy || sudo systemctl restart caddy
```

Caddy 会对配置里的**每个名字**申请证书,前提是 80/443 已放行、前置一节那五条 DNS 都已生效。
证书没签下来时看 `journalctl -u caddy -n 50`,最常见的原因是某条 A 记录还没生效。

RHEL 系(SELinux)下 Caddy 会被挡住,见本文开头那一节。

## 数据与备份（最重要的一节）

`data/` 目录里有两样东西：索引和历史快照。**历史是唯一抄不走的资产**，丢了补不回来。

- 目录：`/opt/agentgate/data/`（compose 已挂载）。
- 备份：每天把 `data/` 打包上传到阿里云 OSS（`ossutil cp -r`），保留 90 天。
- 报警：`/health` 返回非 200 或索引 `generatedAt` 超过 36 小时，就发通知。

## 定时任务

```sh
# 安装: sudo cp /opt/agentgate/deploy/cron.d-agentgate /etc/cron.d/agentgate（0644, root）
# 由 agentgate 用户跑:数据目录与 /var/www/zhiliang 都归它。root 跑会把新文件变成 root 所有,
# 第二天的 agentgate 就写不动了。安装前先 sudo chown -R agentgate:agentgate /var/www/zhiliang。
#
# 一条链写在 scripts/daily-job.sh 里(版本化,不靠这台机器上的手抄),cron 只负责按点叫它:
#   17 4,8,12,16,20 * * * agentgate /opt/agentgate/scripts/daily-job.sh >> /var/log/agentgate.log 2>&1
#
# 为什么一天跑五次:这个项目里只有一种失败补不回来——某天没有采集。账本每次只追加一行,
# 而且只有在记录真的变了时才追加,所以多跑几次的代价只是一次 refresh。refresh 失败也不
# 跳过当天:盘上已有的索引照样算一次采集(脚本会写明"capturing the index already on disk")。
#
# 顺序(脚本内部):refresh → daily-snapshot → build-site → history --max-age 26 → review-criticals。
#   · build-site 必须早于 review:review 查到没读过的 critical 会返回 1。
#   · history --max-age 26 把"最近一次采集有多旧"写进日志;/health 里也有同一个数字,
#     所以外部监视不需要读这台机器上的文件。
#   · review-criticals 排在最后,而且不在同一条 && 链上:它返回 1 是在等人读,
#     不是跳过当天的理由。处理办法是去读代码,读完 node scripts/review-criticals.mjs --accept。
# 第一次没有可比对象时,daily-snapshot 把当天存下来当基准、不写 diff;第二天起才有 diff。
#
# 只重建索引是不够的:evidence.html、每台 server 的页面、厂商页、history.html、sitemap 都是
# 构建时快照,不重建它们站点就会停在最后一次手工构建——而页面本身写着"每天重建"。
```

## 回滚

```sh
cd /opt/agentgate && git log --oneline -5 && git checkout <good-sha> && docker compose up -d --build agentgate
```

索引格式是「只加字段」的，所以回滚代码不会让旧索引读不出来。

## 自动化脚本

`--with-caddy` 之外还有 `--port <n>`:共享机器上 8080 若已被别的服务占用,脚本会自动挑一个空闲端口,
并把同一个端口写进 systemd 单元与 Caddyfile 的转发目标。想固定就用 `--port` 指定。


```sh
# 在服务器上，先预演，确认无误再 --apply
bash scripts/onboard-server.sh
sudo bash scripts/onboard-server.sh --apply

# --apply 依次做：装 git -> 克隆/更新 -> 采集 -> 把静态站建到 Caddy 的目录
#   -> 建 agentgate 用户 -> 用实测到的 node 路径生成并安装 systemd 单元
#   -> 起服务 -> 跑 smoke。幂等，可以重复执行。
# 预演只打印，不动机器；测试里每次都会跑一遍预演，确认它不会碰任何东西。

# 部署后检查（把地址换成公网入口）
node scripts/smoke.mjs http://127.0.0.1:8080 --expect-min 1000
```

`--expect-min 1000` 是关键的一条：样本索引只有 300 条，如果这里过了但数字还是 300，说明**采集没跑成功，服务在读样本**。

## 发布与回滚（P4）

发版前先跑一条命令，它负责说"不"：

```sh
node scripts/release-check.mjs --tests --online
```

它检查：`package.json` 的版本与 `--version`/`--tag` 一致、`agentgate version` 报的是同一个数、`CHANGELOG.md` 里有这个版本的一节、`npm pack --dry-run` 的内容没有缺文件、没有 `.env`/`账号本`/`生成的索引`、每个文件都被 `files` 字段解释、`publishConfig` 带 provenance。`--tests` 会真的跑测试（不跑只提醒），`--online` 查 registry（这个版本是否已存在、latest 指向谁）。**默认离线：不加 `--online` 就不联网。**

发布：

```sh
git tag v0.2.0 && git push origin main --tags   # CI 用 OIDC 发布到 next，并附 SBOM
npm dist-tag add @zhiliangtech/agentgate@0.2.0 latest   # 需要人的动态码，这是有意的
```

回滚见 [rollback.md](rollback.md)——分 npm 包 / 服务站点 / 数据三层，先判断坏的是哪一层。

## 备份与恢复（P3）

- **每晚 03:30** 归档到 `/var/backups/agentgate`（保留 14 天，但**最新那份永不删除**——窗口比故障还短的清理会删掉唯一还能恢复服务的那份）。**每月 1 日 05:00** 自动做一次恢复演练。cron 见 `deploy/cron.d-agentgate`，日志轮转见 `deploy/logrotate-agentgate`。
- 安装（`/var/log` 与 `/var/backups` 都不能由 agentgate 自己创建）：

```sh
sudo install -d -m 755 -o agentgate -g agentgate /var/backups/agentgate
sudo install -m 644 -o agentgate -g agentgate /dev/null /var/log/agentgate-backup.log
sudo install -m 644 -o root -g root deploy/logrotate-agentgate /etc/logrotate.d/agentgate
```

- 手动跑：

```sh
sudo -u agentgate node scripts/backup.mjs --data /opt/agentgate/data --site /var/www/zhiliang --out-dir /var/backups/agentgate
sudo -u agentgate node scripts/restore-drill.mjs --out-dir /var/backups/agentgate
```

- 演练做的事：解开归档 → 按 manifest 重算每个文件的 SHA-256（字节数也要对）→ 拒绝任何跑到目标目录之外的 manifest 路径 → 校验账本哈希链 → **用恢复出来的索引起一次服务并读 `/health`**。任何一步不过就退出 1；没有可演练的归档退出 3。
- **巡检也看备份年龄**（每小时，`--backup-dir /var/backups/agentgate`）：备份停了不会自己喊，因为上个月那份照样能恢复。
- 实测（2026-09-17）：6.2 MB / 3072 个文件 / 索引 2066 条 / 账本 5 次采集；演练通过（链一致、服务从恢复的索引返回 2066 条）；把窗口收紧到 0 小时后 `backup_age` 如期报警。
- 还没做的：**异地副本**。账本本身每天被镜像到 GitHub 的 `history` 分支（算异地），但 `/var/backups` 目前只在本机——见 P3 遗留项。

## 服务自身的限制（P2）

服务不假定"外面那层一定挡住了"：

- **方法**：只服务 GET；HEAD 走同一个处理并丢掉响应体；其它方法由服务层返回 405。
- **请求体**：一条也不需要。带 `Content-Length` 或 `Transfer-Encoding` 的请求在读任何内容之前就返回 **413**。
- **速率**：`AGENTGATE_RATE_LIMIT`（次/分钟，**0 表示关闭**，service 单元里设的是 1200）。超限返回 **429 + Retry-After**。注意：Caddy 反代下所有请求都来自 127.0.0.1，所以这实际上是**一个全局上限**——它的作用是保护进程不被拖垮，按访客限流应该在边缘做。`/metrics` 不占这个额度。
- **连接超时**：headers 15s / request 20s / keep-alive 5s（Node 默认分别是 60s / 300s / 5s）。
- **响应头**：`x-content-type-options: nosniff`、`referrer-policy: no-referrer`、`cache-control: no-store`（Caddy 那层另有 HSTS 等）。

## 可观测（2026-09-17 起）

服务自述三样东西，够一个人管一台机器：

- **`/metrics`**（Prometheus 文本，**只在回环可达**；Caddy 不转发这个路径，公网拿不到）。计数器是每路由每状态码的请求数；gauge 有
  `agentgate_health_ok`、`agentgate_index_records`、`agentgate_index_age_seconds`、`agentgate_history_captures`、
  `agentgate_history_age_seconds`、`agentgate_history_gaps`、`agentgate_history_stale`。
  路由标签是**有界的**：认不出的路径一律算 `/other`，所以扫描器刷不出无限多的时间序列。
- **访问日志默认关闭**。要开就设 `AGENTGATE_ACCESS_LOG=1`（systemd 里加一行 `Environment=`），输出一行一条 JSON：
  `ts/method/route/status/ms/requestId`。**刻意不记录**客户端 IP、User-Agent 与查询串——这与 `docs/operations/legal/data-handling.md` 的承诺一致，要改先改那份文档。
- **优雅退出**：`systemctl stop agentgate`（SIGTERM）先关闭监听、等在途请求结束再退出，最多等 5 秒，超时才强制退出并以 1 结束。

本地自查：

```sh
curl -s localhost:8080/metrics | grep -E "history_(age|captures|stale)|index_age"
curl -s localhost:8080/health | python3 -m json.tool
```

## 告警（P0-2）

- 凭据只放一处：`/etc/agentgate/alert.env`（owner agentgate，mode 0600），字段见 `deploy/alert.env.example`。**仓库里永远不存密码。**
- cron 每小时一次（见 `deploy/cron.d-agentgate`）：`scripts/healthcheck.sh` 检查 /health 的采集年龄/缺口、磁盘余量、账本链、以及 `--site` 给的公开 URL。
- 安装三步（`/var/log` 本身不可写，日志文件必须先建好，否则 cron 的输出会被静默丢掉）：
  ```sh
  sudo install -d -m 755 -o root -g root /etc/agentgate
  sudo install -m 600 -o agentgate -g agentgate alert.env /etc/agentgate/alert.env
  sudo install -m 644 -o agentgate -g agentgate /dev/null /var/log/agentgate-health.log
  sudo install -m 644 -o root -g root /opt/agentgate/deploy/cron.d-agentgate /etc/cron.d/agentgate
  ```
- 发送策略：发现异常立刻发；仍异常每 6 小时重发一次（不被忘掉，也不是每小时的轰炸）；恢复正常发一封「已恢复」。状态存在 `data/healthcheck-state.json`（已 gitignore）。
- 密码不进 argv：curl 用 `--netrc-file` 指向一个 0600 的临时文件，用完覆写再删。argv 在共享机器上 `ps` 可见。

**必须真做一次的演练**（否则"有告警"只是配置）：

```sh
# 1) 制造异常：把 index 说成旧的，或临时停掉 daily-job
# 2) 手动跑一遍，确认退出码是 1（不是 0）
sudo -u agentgate /opt/agentgate/scripts/healthcheck.sh ; echo "exit=$?"
# 3) 确认收到邮件，主题形如 [agentgate] 巡检异常：N 项
# 4) 恢复后确认收到「[agentgate] 巡检已恢复」
```

本地排查用 `--no-alert`（只巡检）或 `--dry-run`（打印将要发送的邮件，不发送）。

## 两个部署陷阱（2026-09-17 实际踩到）

1. **服务代码改了，必须重启。** 每日链只重建 `data/`（索引、站点、账本），运行中的进程不会重新加载
   `packages/service/`。症状很隐蔽：数据是新的（`generatedAt` 是当天、记录数也对），但接口缺字段——
   因为代码还是进程启动时那份。命令：`sudo systemctl restart agentgate`。
2. **如果远端历史被重写过，机器上的旧 checkout 无法 fast-forward。** 症状是
   `fatal: Not possible to fast-forward`。正确做法是先 `sudo git status --porcelain` 确认**没有已跟踪的改动**
   （只有 `?? data/...` 这类未跟踪文件是正常的，切分支不会动它们），然后：

   ```sh
   sudo git fetch origin
   sudo git checkout -B main origin/main
   ```

   **不要**用 `git reset --hard` 去猜；先看 status，再切分支。

## 上线检查清单

- [ ] `curl https://api.智量.com/health` 返回 200，且 `records` 不是样本的 300 条
- [ ] `data/index.json` 的 `generatedAt` 是当天
- [ ] 第一个 `diff-*.md` 已生成（哪怕内容是「没有变化」）
- [ ] OSS 备份跑通一次，并且**试过一次还原**
- [ ] `/badge/<name>.svg` 在外网可访问
- [ ] 安全组只开了 22/80/443，8080 不对公网开放
- [ ] `/etc/agentgate/alert.env` 已装（0600），且**做过一次真实的告警演练**（收到异常邮件与恢复邮件）
