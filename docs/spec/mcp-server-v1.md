# agentgate MCP server（stdio）

把这个索引变成一个 MCP 客户端（Claude Desktop、Cursor、任何会说 MCP 的 agent）可以直接调用的
**四个只读工具**。它不装东西、不执行被查的工具、不上传、不联网。

启动：

```sh
node bin/agentgate.mjs mcp [--index data/index.json]
```

客户端配置（`claude_desktop_config.json`、仓库里的 `.mcp.json`，或同类文件）：

```json
{
  "mcpServers": {
    "agentgate": {
      "command": "npx",
      "args": ["--yes", "@zhiliangtech/agentgate@next", "mcp"]
    }
  }
}
```

本地克隆用绝对路径（`--index` 指向你自己 refresh 出来的索引）：

```json
{
  "mcpServers": {
    "agentgate": {
      "command": "node",
      "args": ["/path/to/agentgate/bin/agentgate.mjs", "mcp", "--index", "/path/to/agentgate/data/index.json"]
    }
  }
}
```

## 工具

| 工具 | 输入 | 回答什么 |
| --- | --- | --- |
| `lookup_server` | `server` 或 `package`（可加 `version`） | 这条记录的结论、覆盖块（哪些扫描器跑完/没跑成/为什么）、发现计数与来源时间 |
| `inventory_tools` | `tools`：名称或 `{name,server,package,registry,version}` 的数组（≤500） | 哪些对上了、哪些需要你的精确版本、哪些索引里根本没有 |
| `coverage_report` | 无 | 整个索引的覆盖分布：完全测过多少、其余卡在哪、跑出来的发现有多少 |
| `check_project` | `root`（默认当前目录）、可选 `policy`、`exclude` | 对一个本地目录跑 agentgate 自己的检查，给结论、发现和"没测到的部分" |

四个都在 `annotations` 里标了 `readOnlyHint: true`、`destructiveHint: false`。每个调用同时返回
文本和 `structuredContent`，文本末尾始终带一条边界说明。

## 三条规则

1. **只读。** 不写索引、不 refresh、不安装、不执行被查的工具、不打开网络连接。`check_project` 只读
   被扫目录里的文件。
2. **没有测量就没有结论。** 自带覆盖块而显示必需扫描器没跑完的记录，报 `incomplete`（文本里写
   "this is not a pass"）；写在覆盖块出现之前的老记录会明说"没有记录不等于跑完过"。
3. **索引里没有 ≠ 安全，也不 ≠ 不存在。** 找不到时只报告"这个索引里没有它"，并说明这条索引是
   什么时候生成的。

另外：显式传了 `--index` 而文件不存在时，**不会**回退到包里那份历史样本，工具会直接说明没有索引；
没有显式指定而回落到样本时，每条回答前面会加一行 "index warning: this is the historical sample
index…"。样本数据不能用来看起来像真实结论。

## 协议细节

- JSON-RPC 2.0，**一行一条 JSON**（stdio 传输）；stdout 只有协议，日志一律走 stderr。
- 实现 `initialize`、`ping`、`tools/list`、`tools/call`；客户端通知（`notifications/*`）不回包。
- 协议版本协商：`2025-06-18`、`2025-03-26`、`2024-11-05`；客户端报一个未知版本时回落到最新支持的那个。
- 批量（JSON-RPC batch）在这个协议版本里已移除，整批回 `-32600`。
- 未知方法 `-32601`；未知工具 `-32602`；**工具自己失败**（例如没有索引）走 `result.isError: true` 并带上原因，
  这样客户端能读到"为什么"，而不是一个笼统的协议错误。
- 单条消息上限 8 MB；超限回 `-32600`。带 BOM 的行会被剥掉 BOM 再解析。

## 这一轮不做的

- 不提供"这个工具能不能用/安不安全"的判断，只提供记录和覆盖。
- 不在服务端发起 refresh 或任何写操作；要新数据先跑 `agentgate refresh`。
- 不把工具暴露成可执行动作（没有 install / run / 修改配置）。
