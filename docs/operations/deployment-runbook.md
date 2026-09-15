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
- DNS：`A` 记录指向服务器公网 IP。中文域名用 punycode。

```
app.智量.com   →  xn--5kvo87g.com 的子域，配 A 记录 →  <公网IP>
api.智量.com   →  同上
docs.智量.com  →  同上
```

在阿里云云解析里，主机记录填 `app`、`api`、`docs`，记录类型 `A`，值填公网 IP。

**大陆服务器需要 ICP 备案才能用 80/443**，见 `what-i-need.md` 第三节。

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
# /etc/cron.d/agentgate  —— 每天 04:17 采集并留快照
17 4 * * * root cd /opt/agentgate && docker compose --profile collect run --rm refresh \
  && node bin/agentgate.mjs diff --from data/history/previous.json --to data/index.json \
     --out data/history/diff-$(date +\%F).md \
  && cp data/index.json data/history/$(date +\%F).json \
  && cp data/index.json data/history/previous.json
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
