# npm 发布清单

*2026-09-15。凡是"已验证"的都是这台机器上跑过的,附命令。*

## 已经验证的事实

| 事 | 结果 | 怎么验的 |
| --- | --- | --- |
| `@zhiliang/agentgate` 是否被占 | **没被占**,registry 返回 404 | `curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/@zhiliang%2Fagentgate` |
| `@zhiliang` 这个作用域下有没有包 | **零个** | `curl -s "https://registry.npmjs.org/-/v1/search?text=scope:zhiliang"` |
| 不带作用域的 `agentgate` | **已被占**(200),所以必须用作用域 | 同上 |
| 打出来的包长什么样 | 103 个文件,339.5 kB,解开 1.7 MB | `npm publish --dry-run` |
| 装出来的包能不能跑 | **能**:从 tarball 解包后 `check` 和 `serve` 都通 | `node --test test/package.test.mjs` |

## 顺序:为什么第一次必须在本机发

Trusted Publishing 是"在 npm 网站上把某个仓库绑到某个包上",而那个设置页面**只有在包已经存在之后才能打开**。所以第一次发布没法走 OIDC,必须在本机发一次;之后每次都可以走工作流,带 provenance。

### 1. 登录(只需一次)

```sh
npm login          # 浏览器打开,登录后回来
npm whoami         # 应打印你的用户名
```

账号要开两步验证。npm 现在对新账号基本强制 TOTP。

### 2. 第一次发布

```sh
cd <agentgate>
npm publish --access public --tag next
```

- `--tag next` 是故意的:先发到 `next`,等自托管演示验过了再提升到 `latest`。别人 `npx @zhiliang/agentgate` 拿到的才是验证过的东西。
- **如果这一步报 provenance 相关的错**(本机没有 OIDC 提供方,而 package.json 里写了 `publishConfig.provenance: true`),就加一个开关:
  ```sh
  npm publish --access public --tag next --no-provenance
  ```
  只有 0.1.0 这一个版本会没有 provenance,后面的都走 CI,都带。
- 我没法在这台机器上替你验证这一步(我没有登录),所以报错就把原文发我。

### 3. 绑定 Trusted Publishing

npm 网站 → 你的包 `@zhiliang/agentgate` → Settings → Trusted Publisher → GitHub Actions:

| 字段 | 填什么 |
| --- | --- |
| Organization or user | `ciceroyang` |
| Repository | `agentgate` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

绑定之后,仓库里不需要存任何 npm token。

### 4. 验证第一次发布

```sh
npm view @zhiliang/agentgate@next version
npx --yes @zhiliang/agentgate@next version
npx --yes @zhiliang/agentgate@next check --root .
```

最后一条应该直接出结果,不需要 policy 文件——用的是内置默认策略,并会打印它用的是默认。

### 5. 之后每次发版(走 CI,带 provenance)

```sh
# 改 package.json 里的 version
git commit -am "release 0.1.1"
git tag v0.1.1
git push origin main --tags
```

工作流会:跑完整测试 → 如果 tag 和 version 不一致就拒绝 → `npm publish --provenance --tag next`。
仓库里没有 token 可偷,发布出来的包带一条指向这次 commit 的 provenance。

### 6. 提升到 latest

自托管演示验过之后再:

```sh
npm dist-tag add @zhiliang/agentgate@0.1.0 latest
```

## 我还没验证的

- 本机第一次 `npm publish` 本身(需要你的登录)。
- npm 网站设置页的确切措辞(可能和我上面写的有出入,以你看到的为准)。
