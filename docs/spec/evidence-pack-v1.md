# Evidence pack v1（数据契约）

*2026-09-18。这份文件先定字段与不变量，再写实现。**每一条都必须是机器可判的**：pack 里出现的任何"我们能给"，都要能追到本次生成的数据；追不到就不许写。*

## 0. 这是什么

一次 `agentgate pack` 产出一个目录，交付给**客户的客户**（买方的安全评审人）：

    agentgate-pack/
      pack.json          机器可读：清单 + 证据 + 逐题答案 + 覆盖率
      pack.html          给人看：同一批内容，顶部是未测计数
      answers.aicaiq.md  填问卷的人用：AI-CAIQ 四个域逐条
      manifest.txt       逐文件 sha256 + 生成命令 + 索快照
      manifest.sha256    manifest.txt 自身的哈希（封条）

**它不是合规结论。** 我们出证据，客户自证，第三方签字——这三件事在每一条答案里分开写，不能合并成一句话。

## 1. 不许破的不变量

1. **未测到不等于没有。** 任何一类证据没有数据支撑，状态必须是 `unmeasured`，不得省略、不得折叠成"通过"。
2. **引用完整性。** 每条答案里列出的 `backing`（条目 id）必须存在于 `items`；断链是生成失败，不是警告。
3. **claims 手写，状态机器算。** 题目说明、我们能给什么、边界，都是人写的常量；本次状态与依据全部由数据算出。两件事在同一个对象里，但字段分开。
4. **不出现合规词。** 生成的三个文件里不得出现：已合规、合规通过、已满足、认证通过、已认证、完全合规、保证合规。
5. **不写凭据、不写绝对路径。** 只写清单里的名称/包名/版本，以及从索引读到的公开字段；不写本机绝对路径、环境变量、启动参数。
6. **不联网。** 生成与校验全程不发起请求。
7. **退出码沿用**：0 = 我们声称的每一条都测到了且没有 medium 及以上发现；1 = 有发现；2 = 有我们声称的条目没测到 / 校验不过。

## 2. pack.json

```
{
  "schemaVersion": "agentgate.evidence-pack/v1",
  "generatedAt": "<ISO>",
  "tool": { "name": "agentgate", "version": "<package.json>" },
  "index": { "generatedAt": "<ISO|null>", "scanner": "<string|null>", "records": <int>,
             "snapshot": <bool>, "truncated": <bool> },
  "input": { "items": <int>, "framework": "aicaiq" },
  "items": [ {
      "id": "tool-1",
      "input": { "name": "<string>", "package": "<string|null>", "registry": "<string|null>", "version": "<string|null>" },
      "state": "matched|unmatched|ambiguous|version_missing|version_mismatch|insufficient",
      "label": "<中文标签>",
      "reason": "<为什么是这个状态>",
      "selected": { "server": "<string|null>", "package": "<string|null>", "registry": "<string|null>", "version": "<string|null>" } | null,
      "evidence": [ { "block": "<id>", "status": "<string|null>", "source": "<string|null>",
                      "reason": "<string|null>", "digest": "<sha256|null>", "scope": "<string|null>",
                      "findings": [ { "rule": "...", "severity": "...", "evidence": "..." } ] } ],
      "execution": { "state": "...", "required": <int|null>, "completed": <int|null>,
                     "failed": <int|null>, "components": [ ... ] } | null,
      "findings": [ ... ],
      "claim": "ev:tool-1"
  } ],
  "evidenceClasses": [ {
      "id": "<class id>", "title": "<中文>",
      "state": "measured|partial|unmeasured",
      "backing": [ "<item id>" ],
      "missing": [ { "item": "<item id>", "reason": "<为什么这一类在这条上没有>" } ],
      "counts": { "backing": <int>, "missing": <int> }
  } ],
  "answers": [ {
      "id": "STA-09.1", "topic": "<中文，自己的措辞>",
      "owner": "we|customer|third-party",
      "state": "measured|partial|unmeasured|not-ours",
      "evidenceClasses": [ "<class id>" ],
      "backing": [ "<item id>" ],
      "weProvide": "<我们能给什么>",
      "boundary": "<边界：这块不是我们>"
  } ],
  "coverage": {
      "questions": { "total": 58, "ours": <int>, "notOurs": <int>,
                     "measured": <int>, "partial": <int>, "unmeasured": <int> },
      "items": { "total": <int>, "matched": <int>, "needsAttention": <int> },
      "evidence": { "blocks": <int>, "withDigest": <int> }
  },
  "limits": [ "<固定几句：范围、只覆盖公开可查的部分、不是合规结论>" ]
}
```

**答案状态怎么算**（不是人写的）：

| owner | state | 条件 |
| --- | --- | --- |
| `we` | `measured` | 它声明的每一个证据类都是 `measured` |
| `we` | `partial` | 至少一个 measured，至少一个不是 |
| `we` | `unmeasured` | 一个都没测到 |
| `customer` / `third-party` | `not-ours` | 恒为这个值；`backing` 只写我们**能递过去的材料** |

**`owner === "we"` 的条目必须声明至少一个证据类**（测试断言）。否则就是"我们声称能给但拿不出东西"。

## 3. 证据类（v1 全部在这里，不许临时加）

| id | 中文 | 机器判定 |
| --- | --- | --- |
| `tool-identity` | 工具身份 | 该条 `selected` 非空（对上了索引记录） |
| `exact-version` | 精确版本对应 | 该条 `state === "matched"` |
| `content-digest` | 内容哈希与覆盖范围 | 证据块里有 `digest` 与 `scope` |
| `package-metadata` | 包元数据检查 | 存在 `packageManifest` 证据块且 `status !== "unmeasured"` |
| `scan-execution` | 扫描执行记录 | 该条 `execution` 非空（哪些组件跑完、哪些没跑成） |
| `change-history` | 变更历史 | 归档里 ≥ 2 次快照 |
| `archive-integrity` | 归档可校验 | 归档哈希链校验通过 |
| `coverage-accounting` | 覆盖范围记账 | 由构造保证；`counts` 里写出未测条目数 |
| `gateway-decisions` | 网关事前决策 | 提供了 `--calls` 日志并解析成功；否则 unmeasured |

类的状态：`backing` 非空且 `missing` 为空 = measured；两者都非空 = partial；`backing` 为空 = unmeasured。

## 4. manifest.txt 与封条

```
agentgate evidence pack
generated: <ISO>
tool: agentgate <version>
index: generatedAt=<ISO> scanner=<id> records=<n> snapshot=<bool>
command: agentgate pack --input <name> --framework aicaiq [--archive <dir>] [--out <dir>]
scope: 只覆盖公开可查的注册表记录；自托管与内部工具不在内
files:
<sha256>  answers.aicaiq.md
<sha256>  pack.html
<sha256>  pack.json
verify: agentgate pack --verify <dir>
note: manifest.txt 自身由 manifest.sha256 封存（自指哈希无法校验）
```

`manifest.sha256` 只有一行：`<sha256>  manifest.txt`。

## 5. `pack --verify <dir>`

1. 读 `manifest.txt`，若存在 `manifest.sha256` 则先核对封条；
2. 逐个文件重算 sha256 与 manifest 比对；
3. 列出 manifest 里有但目录里没有的文件（= 缺失）；
4. 把目录里多出来的文件列为 `extra`（不算失败，但要说出来）；
5. **重算不通过 → 非零退出**（有文件被改 = 1；manifest 缺失或读不了 = 2）。

## 6. 验收（每条都要有负例）

1. 幂等：同输入跑两次，`pack.json` 除去 `generatedAt` 完全一致；`--verify` 通过；
2. 篡改：改 `pack.html` 一个字节 → `--verify` = 1 并指出文件；删 `manifest.txt` → = 2；
3. 凭据：输入里像凭据的值不出现在任何产物里（沿用 inventory 的拒绝规则）；
4. 未测计数与禁用词：顶部有未测计数；三个产物里都不出现第 1 节第 4 条的词；
5. 引用完整性：每条 `answers[].backing` 与 `evidenceClasses[].backing` 的 id 必须存在于 `items`；人为断链 → 生成失败；
6. 归类完整：AI-CAIQ 四个域 58 条全部出现一次，每个 `owner` 合法、每条 `boundary` 非空，`owner === "we"` 的必须有 `evidenceClasses`。

## 7. 不做什么

- 不做运行时阻断、不做镜像加固与签名、不出合规结论、不代客户签字；
- 不写 SaaS 后端：pack 可以完全在本机生成；
- 不改 `check` / `inventory` / `discover` / `audit` / `watch` / `mcp` 的既有行为。
