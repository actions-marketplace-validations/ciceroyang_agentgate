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

## 部署步骤

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
