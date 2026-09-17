# 事故响应

*2026-09-17。适用的现实：**这是一个人的运维**。所以这份文档的目标不是流程完整，而是"半夜被叫起来时知道先敲哪三行"。*

## 一、你怎么知道出事了

| 来源 | 覆盖什么 | 时效 |
| --- | --- | --- |
| 邮件告警 | 采集年龄/stale/缺口、磁盘余量、账本链、备份年龄、`--site` 的公开 URL | 每小时 07 分，异常每 6 小时重发，恢复发一封 |
| `/health` 与 `/metrics`（仅回环） | 索引、采集、限流配置 | 随时 |
| `/var/log/agentgate*.log` | 每日链、巡检、备份与演练的机器日志 | cron 触发时 |
| 你自己打开站点 | 整台机器挂掉、DNS/TLS 问题 | 靠你发现 |

**没有外部 uptime 监控**，这是有意的（不把访客数据交给第三方），代价写在上面：整机挂掉时没有告警。要不要加，是一次明确的取舍，不是遗漏。

## 二、第一分钟：先看清楚，别先动手

```sh
ssh agentgate
sudo -u agentgate /opt/agentgate/scripts/healthcheck.sh --no-alert ; echo "exit=$?"
curl -s localhost:8080/metrics | grep -E "health_ok|index_(records|age)|history_(age|captures|stale)|backup"
tail -50 /var/log/agentgate.log ; tail -50 /var/log/agentgate-health.log
```

三条信息决定后面走哪条路：**服务活着吗**（health_ok）、**采集断了吗**（history_age/stale）、**账本还一致吗**（healthcheck 的 ledger 项 / `agentgate history --verify`）。

## 三、止血优先于根因

先让服务恢复，再找原因。按症状走：

### 采集停了（history_age 超限 / stale / gaps）

```sh
sudo -u agentgate /opt/agentgate/scripts/daily-job.sh ; echo "exit=$?"
```

- refresh 失败也能采集（用磁盘上已有的索引），所以先看是哪一步失败。
- **停一天是不可恢复的**：补不回来。所以先让今天的采集落下去，再慢慢查。
- 缺的是采集本身（账本没写）→ 查磁盘满、权限、node 路径；缺的是页面 → 重跑 build-site。

### 服务不可用

```sh
systemctl status agentgate --no-pager | head -20
journalctl -u agentgate -n 50 --no-pager
sudo systemctl restart agentgate
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/health
```

重启不行就回滚：[rollback.md](rollback.md) 第 2 节（`git merge --ff-only <上一个好提交>`，**不是** `reset --hard`）。

### 账本坏了（ledger_broken）

**不要动 `data/history`，也不要"删了重来"。** 先给现在留一份，再从最近归档恢复：

```sh
sudo -u agentgate node /opt/agentgate/scripts/backup.mjs --data /opt/agentgate/data --site /var/www/zhiliang --out-dir /var/backups/agentgate
sudo -u agentgate node /opt/agentgate/scripts/restore-drill.mjs --out-dir /var/backups/agentgate --keep
```

替换步骤见 [rollback.md](rollback.md) 第 3 节。**代价**：备份之后的采集会消失，这就是为什么先给现在留一份。

## 四、事故中不要做的事

- 不要 `git reset --hard` / `git clean`（`/opt/agentgate` 有只存在于服务器的产物与数据）；
- 不要 `npm unpublish`（24 小时后会被拒，且会让正在安装的人直接失败）——用 `npm deprecate`；
- 不要为了"变绿"降低阈值、删掉未测到的项、或把 incomplete 说成 clean（这是本项目存在的理由）；
- 不要在公开渠道说未确认的原因。

## 五、分级（单人的现实版）

| 级别 | 例子 | 什么时候处理 |
| --- | --- | --- |
| **P1** | 采集停了、账本不一致、站点不可用、发布包有毒 | 当天，其他事都放下 |
| **P2** | 备份过期、限流误伤正常访问、页面错误、依赖告警 | 48 小时内 |
| **P3** | 文档过时、日志没轮转、可观测性缺口 | 一周内，和下一次功能一起做 |

## 六、复盘模板（24 小时内写，哪怕只有三行）

```
## <日期> <一句话标题>
- 时间线（发现/止血/恢复，各带时间）
- 影响：采集少了几次、哪些 URL、有没有客户可见
- 怎么发现的：如果从发生到发现超过 1 小时，写下要改的告警（这是最常见的改进）
- 根因：一段话，不要写"疏忽"
- 修复：改了什么、提交号
- 防止再发生：具体动作 + 谁 + 什么时候；没有就写"接受这个风险，因为 X"
```

复盘写进本文件末尾的「复盘记录」一节，不要另开文件。

## 复盘记录

（还没有。第一次事故后从这里开始。）
