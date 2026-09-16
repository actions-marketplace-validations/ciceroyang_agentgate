# npm 发布清单

> 这份是给"没做过 npm 发布"的人看的。每一步都写清了点哪里、填什么、看到什么算成功。

## 零、先理解三个词(30 秒)

- **npm**:JavaScript 的包仓库。别人跑 `npx @zhiliang/agentgate` 时,东西就是从这里下载的。
- **作用域(scope)**:包名前 `@` 后面那一段。`@zhiliang/agentgate` 里的 `zhiliang` 就是作用域。
- **关键**:作用域**不是随便写的名字**。要发布 `@zhiliang/...`,你得先拥有一个叫 `zhiliang` 的组织,
  或者你的 npm 用户名正好是 `zhiliang`。否则发布时会报 `You do not have permission to publish`。

  （2026-09-16 查过:`@zhiliang/agentgate` 这个名字没被占,`zhiliang` 作用域下也没有任何包——
  所以它还没被谁注册,你注册得到。）

## 一、注册账号(如果还没有)

1. 打开 <https://www.npmjs.com/signup>,填 **Username / Email / Password**,注册。
   - Username 之后会公开出现在包页面上,想好用哪个。
   - 注意:如果用户名就叫 `zhiliang`,那第 2 步可以跳过。
2. 去邮箱点验证链接。
3. 打开 <https://www.npmjs.com/settings/~/profile> 或账号设置里的 **Two-Factor Authentication**,
   开启 2FA。npm 现在基本强制要求发布者开 TOTP,用任意验证器 App 扫码即可。

## 二、建一个叫 `zhiliang` 的组织

1. 打开 <https://www.npmjs.com/org/create>。
2. 组织名填 **`zhiliang`**(小写)。套餐选 **免费** 那一档(公开包不限量)。
3. 建完你就是这个组织的 owner,可以发布 `@zhiliang/...`。

   （另一种做法:不建组织,把包名换成 `@<你的用户名>/agentgate`。但我们的文档、站点、
   工作流里写的都是 `@zhiliang`,换名字要改好几处,所以我建议建组织。）

## 三、在本机登录一次

```sh
npm login            # 浏览器会打开,登录后回到终端
npm whoami           # 打印你的用户名,说明登录成功
```

## 四、发布第一个版本(本机执行一次)

```sh
cd <agentgate 仓库目录>
npm publish --access public --tag next
```

- `--tag next` 是故意的:先发到 `next`,等自托管演示验过了再提升到 `latest`。别人
  `npx @zhiliang/agentgate` 默认拿到 `latest`,那就是验证过的东西。
- **如果报 provenance 相关的错**(本机没有 OIDC 提供方,而 `package.json` 里写了
  `publishConfig.provenance: true`),加一个开关重跑:
  `npm publish --access public --tag next --no-provenance`
  只有 0.1.0 这一个版本会没有 provenance,之后都走 CI,都带。
- **如果报 `You do not have permission to publish`** → 第二节的组织没建,或名字不是 `zhiliang`。

## 五、验证它是真的发出去了

```sh
npm view @zhiliang/agentgate@next version
npx --yes @zhiliang/agentgate@next version
npx --yes @zhiliang/agentgate@next check --root .
```

最后一条应该直接出结果,不需要 policy 文件(用内置默认策略,并会打印它用的是默认)。

## 六、绑定 Trusted Publishing(之后每次发版都不用 token)

npm 网站 → 你的包 `@zhiliang/agentgate` → **Settings** → **Trusted Publisher** → GitHub Actions:

| 字段 | 填什么 |
| --- | --- |
| Organization or user | `ciceroyang` |
| Repository | `agentgate` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

绑定之后,仓库里不需要存任何 npm token。之后发版只要打 tag:

```sh
# 改 package.json 里的 version,然后
git tag v0.1.1 && git push origin main --tags
```

工作流会跑完整测试 → 拒绝 tag 与 version 不一致 → `npm publish --provenance --tag next`。

## 七、提升到 latest

自托管演示验过之后再:

```sh
npm dist-tag add @zhiliang/agentgate@0.1.0 latest
```
---

*2026-09-15。凡是"已验证"的都是这台机器上跑过的,附命令。*

## 已经验证的事实

| 事 | 结果 | 怎么验的 |
| --- | --- | --- |
| `@zhiliang/agentgate` 是否被占 | **没被占**,registry 返回 404 | `curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/@zhiliang%2Fagentgate` |
| `@zhiliang` 这个作用域下有没有包 | **零个** | `curl -s "https://registry.npmjs.org/-/v1/search?text=scope:zhiliang"` |
| 不带作用域的 `agentgate` | **已被占**(200),所以必须用作用域 | 同上 |
| 打出来的包长什么样 | 103 个文件,339.5 kB,解开 1.7 MB | `npm publish --dry-run` |
| 装出来的包能不能跑 | **能**:从 tarball 解包后 `check` 和 `serve` 都通 | `node --test test/package.test.mjs` |

## 为什么第一次必须在本机发

Trusted Publishing 是"在 npm 网站上把某个仓库绑到某个包上",而那个设置页面**只有在包已经存在之后才能打开**。
所以第一次发布没法走 OIDC,必须在本机发一次;从第二个版本起都可以走工作流,并且带 provenance。

这也是为什么第四节先发 `--tag next`:仓库里不存任何 token,而发布出来的包带一条指向具体 commit 的
构建来源证明。别人 `npx @zhiliang/agentgate` 拿到的是 `latest`,也就是你验证过的东西。

## 我还没验证的

- 本机第一次 `npm publish` 本身(需要你的登录)。
- npm 网站设置页的确切措辞(可能和我上面写的有出入,以你看到的为准)。
