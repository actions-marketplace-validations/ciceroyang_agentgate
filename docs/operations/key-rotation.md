# 密钥与凭据轮换

*2026-09-17。原则：**一次只动一处，先加后删，轮换完跑一次演练**。任何一轮的结果记进 [incidents.md](incidents.md) 的复盘记录（哪怕没出事）。*

## 我们有哪些凭据

| 凭据 | 存在哪 | 用来做什么 | 泄露的后果 |
| --- | --- | --- | --- |
| `SMTP_PASS`（阿里云 DirectMail） | `/etc/agentgate/alert.env`（0600，agentgate）+ 本机保存凭据的那个文件（**不进版本库**） | 发外联邮件与巡检告警 | 别人可以用我们的域名发信（SPF/DKIM 会替它背书） |
| SSH 部署私钥 | 本机 `~/.ssh/agentgate_deploy`（+ `ProxyCommand`）；服务器 `authorized_keys` | 登录服务器 | 服务器完全控制权 |
| npm | **没有长期 token**：Trusted Publishing + OIDC；账号 2FA 为 `auth-and-writes` | 发版 | 需要同时拿到 GitHub Actions 与 npm 账号 |
| GitHub | 浏览器会话 + 仓库写权限；CI 用 OIDC，**仓库里不需要任何 secret** | 代码、发版、Pages 镜像 | 仓库被改 |

**没有长期 token 是有意的**：能轮换的东西越少越好。`npm token list` 应该永远为空——**出现任何 token 就按事故处理**。

## 1. 轮换 SMTP 密码

1. 阿里云邮件推送控制台 → 发信地址 → 重新生成 SMTP 密码；
2. 更新服务器：`sudo install -m 600 -o agentgate -g agentgate 新 alert.env /etc/agentgate/alert.env`（内容照 `deploy/alert.env.example`）；
3. 更新本机那个凭据文件；
4. 验证读得到、发得出：

```sh
sudo -u agentgate /opt/agentgate/scripts/healthcheck.sh --dry-run --state /tmp/rot.json --max-age 0   # 只打印不发送
sudo -u agentgate /opt/agentgate/scripts/healthcheck.sh --state /tmp/rot.json --max-age 0             # 真发一封
```

5. 确认收到邮件后，在控制台让旧密码失效；
6. 新的告警邮件到达后，把时间写进复盘记录。

## 2. 轮换 SSH 部署密钥

**先加后删**，否则你会把自己锁在外面：

```sh
ssh-keygen -t ed25519 -f ~/.ssh/agentgate_deploy_new -C "agentgate deploy <日期>"
ssh -i ~/.ssh/agentgate_deploy_new agentgate@<host> 'echo new key works'
# 追加新公钥（不动旧的），确认新密钥能连、能 sudo 之后，再从服务器上删掉旧公钥
```

删旧公钥前，**必须**先用新密钥完整跑一遍：`ssh agentgate 'sudo -u agentgate /opt/agentgate/scripts/healthcheck.sh --no-alert'`。

## 3. npm

- 没有 token 可轮换；要做的是：确认 `npm token list` 为空、2FA 仍是 `auth-and-writes`、恢复码离线保存；
- 如果怀疑账号被进：改密码 → 重新生成恢复码 → 检查 Trusted Publisher 里绑定的仓库/工作流还是不是 `ciceroyang/agentgate / publish.yml`；
- 有问题的版本用 `npm deprecate`，不要 `unpublish`。

## 4. GitHub

- 浏览器会话不共享；给 CI 的权限只有它需要的那几条（`contents`、`id-token`、`pages`）；
- 定期看一遍 `Settings → Deploy keys` 与 Actions 的 secrets：**应该一个都没有**；出现一个就解释它、然后删掉或写进本文件。

## 5. 轮换后必须做的事

1. 跑 `scripts/healthcheck.sh --no-alert`：退出码 0；
2. 跑 `scripts/restore-drill.mjs`：恢复演练通过；
3. 记一行：日期、轮换了什么、怎么验证的、旧凭据什么时候失效。

**没有第 3 步的轮换等于没轮换**——下次出事时没人知道现在用的是哪一把。
