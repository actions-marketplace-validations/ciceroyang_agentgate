# 运维手册索引

*出事了从这一页找。每一页开头都写"什么时候用它"。*

## 按症状找

| 症状 | 去哪 |
| --- | --- |
| 收到巡检告警、采集停了、站点打不开、账本异常 | [incidents.md](incidents.md) |
| 要回滚 npm 包 / 服务 / 数据 | [rollback.md](rollback.md) |
| 怀疑凭据泄露，或者到了该轮换的时候 | [key-rotation.md](key-rotation.md) |
| 要发一个新版本 | [publish-checklist.md](publish-checklist.md) + [deployment-runbook.md](deployment-runbook.md) 的「发布与回滚」 |
| 部署、升级、看指标与日志 | [deployment-runbook.md](deployment-runbook.md) |
| 备份与恢复演练怎么跑 | [deployment-runbook.md](deployment-runbook.md) 的「备份与恢复（P3）」 |
| 这件事整体做到哪一步了 | [productionization.md](productionization.md) |
| 对外怎么描述数据处理 | [legal/data-handling.md](legal/data-handling.md) + 线上 `/privacy.html` |

## 运行节奏（当前实际在跑的）

| 频率 | 做什么 | 在哪定义 |
| --- | --- | --- |
| 每天 5 次（4/8/12/16/20 点 17 分） | 采集 → 建站 → 校验年龄 → 复核高危 | `deploy/cron.d-agentgate`、`scripts/daily-job.sh` |
| 每小时 07 分 | 巡检（含备份年龄）+ 邮件告警 | `scripts/healthcheck.sh` |
| 每晚 03:30 | 备份，保留 14 天，**最新一份永不删** | `scripts/backup.mjs` |
| 每月 1 日 05:00 | 恢复演练（解开、重算哈希、校验链、起服务） | `scripts/restore-drill.mjs` |
| 每周 | Actions 依赖更新 | `.github/dependabot.yml` |
| 每季度（人工） | 凭据与 2FA 过一遍 | [key-rotation.md](key-rotation.md) 第 4、5 节 |
| 每季度（人工） | 核对线上 `/privacy.html` 与实际行为是否仍一致 | [legal/data-handling.md](legal/data-handling.md) |

## 同目录、但不是运维手册的文档

| 文档 | 是什么 |
| --- | --- |
| [pilot-package.md](pilot-package.md) | 免费试点的范围与信任阶梯（L0–L3），对客户讲清"代码不用给我" |
| [plan-b-no-icp.md](plan-b-no-icp.md) | 没有备案时的部署路线 |

## 这份文档自己的维护规则

- 文档里引用的每个 `scripts/*` 必须真的存在——`test/runbooks.test.mjs` 会检查，删了脚本不改文档就会红；
- 每一页都必须被本文件链到（同样有测试）；
- **不允许留占位词**：没做的就写"没做"和原因，写不出来说明还没想清楚（`test/runbooks.test.mjs` 会扫这几个词，包括这一页）。
