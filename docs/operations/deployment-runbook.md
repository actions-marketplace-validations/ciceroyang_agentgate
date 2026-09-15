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
- DNS：`A` 记录指向服务器公网 IP。中文域名在配置里一律用 punycode，所以下面直接给 punycode。
- **Caddy 服务这五个名字,五个都要有 A 记录。** 少配一个,那个名字的证书就签不下来,主域会是空的:

```
xn--5kvo87g.com          主机记录 @      类型 A   值 <公网IP>
www.xn--5kvo87g.com      主机记录 www    类型 A   值 <公网IP>
app.xn--5kvo87g.com      主机记录 app    类型 A   值 <公网IP>
api.xn--5kvo87g.com      主机记录 api    类型 A   值 <公网IP>
docs.xn--5kvo87g.com     主机记录 docs   类型 A   值 <公网IP>
```

另一个站点(如果保留):把 `me.xn--5kvo87g.com` 用 CNAME 指向它现在所在的地方。这台服务器不管它。

**没有 `try.`**:在线试用的页面就在主站的 `/try.html`,不需要单独的子域。

**大陆服务器需要 ICP 备案才能用 80/443**，见 `what-i-need.md` 第三节。

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

# 2. 取代码
sudo mkdir -p /opt/agentgate && cd /opt/agentgate
git clone https://github.com/ciceroyang/agentgate .

# 3. 首次采集（会产生 data/index.json，约十分钟）
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

```
# /etc/caddy/Caddyfile
xn--5kvo87g.com, www.xn--5kvo87g.com {
    root * /var/www/zhiliang
    file_server
}

app.xn--5kvo87g.com {
    reverse_proxy 127.0.0.1:8080
}

api.xn--5kvo87g.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 会自动申请并续期证书；前提是 80/443 已放行且 DNS 已生效。

## 数据与备份（最重要的一节）

`data/` 目录里有两样东西：索引和历史快照。**历史是唯一抄不走的资产**，丢了补不回来。

- 目录：`/opt/agentgate/data/`（compose 已挂载）。
- 备份：每天把 `data/` 打包上传到阿里云 OSS（`ossutil cp -r`），保留 90 天。
- 报警：`/health` 返回非 200 或索引 `generatedAt` 超过 36 小时，就发通知。

## 定时任务

```sh
# /etc/cron.d/agentgate  —— 每天 04:17 采集、留快照、算 diff
# 第一条命令就够了:第一次没有可比对象时,脚本把当天存下来当基准、不写 diff;第二天起才有 diff。
# 之前的写法直接 diff previous.json,而它第一天还不存在,于是 diff 报错、&& 链断在写快照之前,
# 历史永远是空的——这条在彩排里跑不出来,只有真机第一天会遇到。
17 4 * * * root cd /opt/agentgate && node bin/agentgate.mjs refresh --max 300 >> /var/log/agentgate.log 2>&1 && node scripts/daily-snapshot.mjs >> /var/log/agentgate.log 2>&1
```

## 回滚

```sh
cd /opt/agentgate && git log --oneline -5 && git checkout <good-sha> && docker compose up -d --build agentgate
```

索引格式是「只加字段」的，所以回滚代码不会让旧索引读不出来。

## 自动化脚本

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

## 上线检查清单

- [ ] `curl https://api.智量.com/health` 返回 200，且 `records` 不是样本的 300 条
- [ ] `data/index.json` 的 `generatedAt` 是当天
- [ ] 第一个 `diff-*.md` 已生成（哪怕内容是「没有变化」）
- [ ] OSS 备份跑通一次，并且**试过一次还原**
- [ ] `/badge/<name>.svg` 在外网可访问
- [ ] 安全组只开了 22/80/443，8080 不对公网开放
