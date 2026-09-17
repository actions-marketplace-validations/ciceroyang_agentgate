# 生产化路线图

*2026-09-17。目标是"能长期跑、出事能自己喊、有人能接手"，不是"功能看起来多"。*

## 怎么用这份文档

一次只推一个阶段，每个条目都必须有：**为什么**（不做会怎样）、**做到什么算完**（可验收）、**怎么验**（命令或测试）。做完一条就单独提交，并在这里改状态。任何一条如果验收不通过就不算完成。

状态：`待做` / `在做` / `完成`（完成必须写清验证命令与提交号）。

## 现状盘点（已经在的，不要重做）

| 已有 | 在哪 |
| --- | --- |
| systemd 硬化（ProtectSystem=strict、只读路径、NoNewPrivileges、独立用户、Restart=always） | `deploy/agentgate.service` |
| Caddy 侧安全头（HSTS / nosniff / Referrer-Policy / X-Frame-Options / 去 Server） | `deploy/Caddyfile` |
| 服务只绑 127.0.0.1，只接受 GET，缺索引返回 503 而不是空答案 | `packages/service/src/server.mjs` |
| 零运行时依赖（没有 npm 供应链可攻击） | `package.json` |
| 门禁：`scripts/verify.sh`（YAML、全量测试、M1–M4 验收、部署彩排、regression、bench） | `scripts/verify.sh` |
| CI：test / minimum-node / docker / pages / action-verify / publish（OIDC + provenance） | `.github/workflows/` |
| 采集账本：hash 链 + 内容寻址快照 + `history --verify` | `packages/history/src/ledger.mjs` |
| 部署彩排：不碰 systemd 与 Caddy 的整套演练 | `scripts/rehearse-deploy.mjs` |
| 公开页有数据说明（不记录访客什么） | `docs/operations/legal/data-handling.md` |

## P0 可观测与告警（先做，否则后面每一件都是盲的）

### P0-1 服务自述：/metrics、访问日志、请求 ID、优雅退出 —— **完成**

- **为什么**：现在 `/health` 有结果但没人能画图，访问日志默认没有，systemd 发 SIGTERM 时进程没有明确的收尾动作。
- **做到什么算完**：`/metrics` 只在回环可达；路由标签是有界的（未知路径一律 `/other`）；日志不写 IP / UA / 查询串；SIGTERM 退出码 0。
- **怎么验**：`node --test packages/service/test/observability.test.mjs packages/service/test/metrics-http.test.mjs`（12 项，含"一千个不同路径只产生一个标签""扫描路径不出现在指标与日志里""SIGTERM 退出码 0"三条负路径）；提交 `f7fdb25`；门禁 `scripts/verify.sh` 全绿。

### P0-2 故障能自己喊出来 —— **完成（代码 cb81f93；服务器安装与演练 2026-09-17）**

- **为什么**：`daily-job.sh` 失败只在机器上的 log 里留一行，`/health` 的 `stale` 没有任何外部东西在看。**采集断一天是补不回来的**，这是唯一无法回溯的失败。
- **做什么**：`scripts/healthcheck.mjs`（检查 /health 的 ageHours/stale/gaps、磁盘余量、归档链 verify、站点关键 URL 200），退出码非 0 即异常；异常时通过现有阿里云 DirectMail SMTP 发一封告警到我们自己的信箱（`curl --url smtps://... --user ... --upload-file`，零依赖）；cron 每小时跑一次，连续失败不静默。
- **做到什么算完**：拔掉 daily-job（或把 index 改旧）后，一小时内收到一封告警邮件；恢复正常后收到恢复通知；`--dry-run` 不真的发信。
- **怎么验（已完成的部分）**：`node --test packages/service/test/healthcheck.test.mjs packages/service/test/alert.test.mjs test/healthcheck-cli.test.mjs`（33 项，含"服务不可达必须算问题""什么都没检查不算通过""凭据不进 argv""缺凭据时退出码 3"）；提交 `cb81f93`；门禁全绿。
- **服务器上实做（2026-09-17，部署后 HEAD `6db65c4`）**：
  - `/etc/agentgate/alert.env` 已装：`600 agentgate`，键为 SMTP_HOST/PORT/USER/PASS + AGENTGATE_ALERT_FROM/TO。密码经 ssh stdin 管道写入，**没有出现在任何命令输出里**。
  - `/etc/cron.d/agentgate` 已更新（每小时 :07）；`/var/log/agentgate-health.log` 预先建好并归 agentgate（`/var/log` 本身不可写，不预建这条 cron 会静默丢输出）。
  - `systemctl restart agentgate` 后 `/metrics` 在线，`agentgate_health_ok 1`。
  - **演练**：`--state /tmp/drill3.json --max-age 0` → 退出码 **1**、stderr `告警已发出（已交给 smtpdm.aliyun.com）`；随后 `--max-age 26` → 退出码 **0**、发出恢复邮件。**163 收件箱确认收到** `[agentgate] 巡检异常：2 项` 与 `[agentgate] 巡检已恢复`（各两封，来自两次演练）。
  - **cron 环境模拟**（`env -i SHELL=/bin/sh PATH=/usr/bin:/bin`）退出码 0：没有依赖交互式环境，也没有因为没有 HOME 而失败。
- **留给 P3 的一件小事**：`/var/log/agentgate*.log` 需要 logrotate（现在只增不减）。

## P1 供应链自保 —— **完成（56dd677）**

- **为什么**：我们卖的是"能核的供应链证据"，自己就更不能被别人塞东西进来。
- **做什么**：CI 里断言 `dependencies`/`devDependencies` 仍然为空（现在就是，写下来防止将来悄悄加）；发布时生成并附上我们自己的 CycloneDX SBOM；Dependabot 只盯 GitHub Actions 的版本。
- **做到什么算完**：CI 有一次"依赖必须为空"的失败演示；release 页面能看到 SBOM 文件；有依赖时 CI 会红。
- **怎么验**：`node scripts/check-zero-deps.mjs`（127 个源文件、0 个裸导入）；`node scripts/sbom.mjs --stdout | python3 -m json.tool`；`node --test packages/verify/test/deps.test.mjs packages/verify/test/sbom.test.mjs`（20 项，含"字符串里的 require 不算导入""本仓库真的没有依赖"两条）。两条都已进 `scripts/verify.sh` 与 CI。**注**：本地没有 pyyaml，所以 YAML 校验在本地会走 `--` 跳过分支，我用 `ruby -ryaml` 单独验过全部 workflow + dependabot.yml 通过；CI 那一步现在覆盖全部 workflow（原来只查 test.yml，publish.yml 坏了要到发版才发现）。

## P2 服务硬化

- **为什么**：公网只经过 Caddy，但服务本身不该依赖"外面那层一定挡住了"。
- **做什么**：请求体积上限（本服务不读 body，超过就 413）、方法白名单（已 405，补 HEAD）、每 IP 令牌桶限流（429 + Retry-After）、header/request 超时、服务端安全头兜底、错误响应统一 JSON。
- **做到什么算完**：`packages/service/test/limits.test.mjs` 覆盖 429/413/405/超时四条负路径，且不误伤正常的 `/health` 轮询。
- **怎么验**：同一套测试 + 一次本地压测（`scripts/bench.mjs` 不回归）。

## P3 数据与恢复

- **为什么**：账本是唯一不可再生的东西；"有备份"和"能恢复"是两件事。
- **做什么**：每日归档打包（index + history + site 产物）到 `/var/backups/agentgate/`，保留 N 天；**恢复演练脚本**：把备份还原到临时目录并跑 `history --verify` + 起服务读一遍；磁盘阈值与快照/日档留存策略；把演练写进 cron 每月一次。
- **做到什么算完**：演练脚本能在一台干净目录上从备份恢复并验证通过，且能人为让一个坏备份失败。
- **怎么验**：`node scripts/restore-drill.mjs --from <备份>`；`node --test test/restore-drill.test.mjs`。

## P4 发布工程

- **为什么**：现在发版靠 checklist 与人记得；`latest` 还是 0.1.0。
- **做什么**：`scripts/release-check.mjs`（tag 与 version 一致、测试通过、打包内容白名单、provenance 存在、dist-tags 现状打印）；CHANGELOG；回滚手册（把 dist-tag 指回上一版 + 站点回滚）。
- **做到什么算完**：一条命令给出"能不能发"的结论与缺口清单；发版后一条命令确认线上装到的是新版本。
- **怎么验**：对 0.1.1 跑一次 release-check，应报 `latest` 未提升为唯一缺口。

## P5 合规资产（客户第一眼要看的）

- **为什么**：我们给 Zilliz 发信时夸的"你们有公开的漏洞上报流程"，自己网站上没有。
- **做什么**：`/.well-known/security.txt`（RFC 9116）、`/security.html`（我们收什么/不收什么/数据在哪/留多久/怎么报漏洞/我们自己的 SBOM 与 attestation 链接）、把 `docs/operations/legal/data-handling.md` 变成公开页。
- **做到什么算完**：三条 URL 在公网 200 且内容与实现一致（例如"默认不记录 IP"要和 Caddy 与服务的实际行为对得上）。
- **怎么验**：`scripts/verify-public.mjs` 增加这三个 URL。

## P6 运维支撑

- **为什么**：一个人也要能休假；出事时要按纸做事。
- **做什么**：事故响应一页（发现 → 止血 → 恢复 → 复盘）、密钥轮换（SMTP、SSH、npm、GitHub）、升级与回滚手册、on-call 期望（单人的现实版）、复盘模板。
- **做到什么算完**：新接手的人只按文档能在 30 分钟内完成一次"从备份恢复并切回服务"。

## 明确暂缓（写下原因，避免反复讨论）

- 不做 Kubernetes / 服务网格：一台机器 + systemd + Caddy 已经够，复杂度是负债；
- 不做外部 APM/SaaS 监控：引入第三方数据处理与我们自己的承诺冲突，先用自建巡检 + 邮件；
- 不做多租户 SaaS：还没有付费客户，先把手上的东西做扎实。
