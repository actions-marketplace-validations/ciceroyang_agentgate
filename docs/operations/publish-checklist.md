# npm 发布清单

> 给"没做过 npm 发布"的人看。每一步写清点哪里、填什么、看到什么算成功。
> **2026-09-17：已完成。** 账号与作用域见第一节；`0.1.0` 本机手动发（bootstrap），`0.1.1` 起由 CI 用 OIDC 发布（带 provenance）。

## 零、先理解三个词（30 秒）

- **npm**：JavaScript 的包仓库。别人跑 `npx @zhiliangtech/agentgate` 时，东西就是从这里下载的。
- **作用域（scope）**：包名前 `@` 后面那一段。`@zhiliangtech/agentgate` 里的 `zhiliangtech` 就是作用域。
- **关键**：作用域必须是**你自己的 npm 用户名**，或者**你拥有的组织**。
  - 我们的账号是 `zhiliangtech`，所以包名是 `@zhiliangtech/agentgate`——这是**用户作用域，不需要建组织**。
  - **为什么不叫 `@zhiliang`**：registry 上 `zhiliang` 这个作用域属于**另一个账号**。2026-09-17 实测：用我们的账号往
    `@zhiliang/agentgate` 发布，registry 返回 **404 Not Found on PUT**——npm 对"不属于你的作用域"就返回 404，
    不是 403。所以那个名字拿不到；也不值得为它去找到对方。

## 一、账号（已完成，2026-09-17）

| 项 | 值 |
| --- | --- |
| 用户名 | `zhiliangtech` |
| 邮箱 | `zhiliangtech@163.com`（已验证） |
| 两步验证 | **已开，模式 `auth-and-writes`**（发布必须；只开 authorization 发布仍会被拒） |

本机登录（网站登录与命令行登录是两件事，命令行要单独拿 token）：

```sh
npm login --auth-type=legacy    # 网页被 Cloudflare 挡住时的备用路径；会问用户名/密码/OTP
npm whoami                      # 应打印 zhiliangtech
```

## 二、发布第一个版本（已完成 2026-09-17；bootstrap，需要 OTP）

```sh
cd <agentgate 仓库目录>
npm publish --access public --tag next --no-provenance --otp=<6位动态码>
```

- `--tag next` 是故意的：先发到 `next`，等自托管演示验过了再提升到 `latest`。
- `--no-provenance`：本机没有 OIDC 提供方，而 `package.json` 里写了 `publishConfig.provenance: true`。
  **只有 0.1.0 这一个版本没有 provenance**，之后都走 CI，都带。
- 如果 npm 打印 `https://www.npmjs.com/auth/cli/...` 让你在浏览器确认，就打开确认（终端别关）。
- 成功标志：出现 `+ @zhiliangtech/agentgate@0.1.0`。

## 三、验证它真的发出去了

```sh
npm view @zhiliangtech/agentgate@next version
npx --yes @zhiliangtech/agentgate@next version
npx --yes @zhiliangtech/agentgate@next check --root .
```

最后一条应该直接出结果，不需要 policy 文件（用内置默认策略，并会打印它用的是默认）。

## 四、绑定 Trusted Publishing（已完成）

npm 网站 → 你的包 `@zhiliangtech/agentgate` → **Settings** → **Trusted Publisher** → GitHub Actions：

| 字段 | 填什么 |
| --- | --- |
| Organization or user | `ciceroyang` |
| Repository | `agentgate` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

绑定之后，仓库里不需要存任何 npm token。

已核对：`npm trust list @zhiliangtech/agentgate` 显示 `github / publish.yml / ciceroyang/agentgate / 权限 publish, stage publish`。

## 五、之后每次发版（已跑通：v0.1.1）

```sh
# 改 package.json 里的 version，然后
git tag v0.1.1 && git push origin main --tags
```

工作流会跑完整测试 → 拒绝 tag 与 version 不一致 → 用 OIDC 发布（带 provenance），不需要任何动态码或密钥。

已跑通：`v0.1.1` 由 CI 发布成功，registry 的 dist-tags 显示 `next: 0.1.1`；该版本带两条 attestation（npm publish v0.1 与 SLSA provenance v1）。GitHub Release：<https://github.com/ciceroyang/agentgate/releases/tag/v0.1.1>。

## 六、提升到 latest（待做：目前 latest = 0.1.0）

自托管演示验过之后再：

```sh
npm dist-tag add @zhiliangtech/agentgate@0.1.1 latest
```

---

## 已经验证的事实

| 事 | 结果 | 怎么验的 |
| --- | --- | --- |
| `@zhiliangtech/agentgate` 是否被占 | **没被占**，registry 返回 404 | `curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/@zhiliangtech%2Fagentgate` |
| `@zhiliang` 是不是我们的 | **不是**：属于另一个账号；我们发布时 PUT 返回 404 | 2026-09-17 实际发布尝试 |
| 不带作用域的 `agentgate` | **已被占**（200），所以必须用作用域 | registry |
| `@zhiliangtech/agentgate` 的版本 | **0.1.0**（本机 bootstrap）、**0.1.1**（CI 发布，带 provenance） | `curl -sS https://registry.npmjs.org/-/package/@zhiliangtech%2Fagentgate/dist-tags` |
| 从 npm 装出来的包能不能跑 | **能**：`npx --yes @zhiliangtech/agentgate@0.1.1 version` 打印 `agentgate 0.1.1`；`npm i` 后 `node_modules/.bin/agentgate` 直接可执行；`check --root .` 正常给出 verdict | npx / `npm i`，2026-09-17 实测 |
| 0.1.1 有没有 provenance | **有**：attestations 两条（npm publish v0.1 与 SLSA provenance v1） | `curl -sS https://registry.npmjs.org/-/npm/v1/attestations/@zhiliangtech%2Fagentgate@0.1.1` |
| 打出来的包长什么样 | 123 个文件、394.5 kB、解开 1.8 MB | `npm publish --dry-run` |
| 从 tarball 解出来的包能不能跑 | **能**：解包后 `check` 和 `serve` 都通 | `node --test test/package.test.mjs` |
| 账号的 2FA | `auth-and-writes`（不开这个发布会被拒） | `npm profile get` |
| 一个坑：packument 的缓存 | 两处都会滞后：registry CDN 缓存发布前的"不存在"（`npm view` 报 404），以及**本机 `~/.npm` 里那份旧 packument**（`npm i @zhiliangtech/agentgate@0.1.1` 报 `ETARGET No matching version found`，npx 报 `command not found`，而 tarball 本身没问题）。`/-/package/<name>/dist-tags` 与搜索接口是即时准确的；换个 `npm_config_cache` 或等几分钟即自愈 | 实测（2026-09-17 两处都踩到，之后同一命令通过） |
