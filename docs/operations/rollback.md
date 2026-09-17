# 回滚手册

*2026-09-17。什么时候用：刚发出去的版本有问题、站点被一次部署搞坏、或者数据被误操作。*

## 先决定回滚哪一层

三层的回滚彼此独立，先看清楚坏的是哪一层，别一起动：

1. **npm 包**：别人 `npx` 装到的东西；
2. **服务/站点**：app.智量.com 上跑的东西；
3. **数据**：`/opt/agentgate/data` 里的索引与采集账本。

## 1. npm 包

只有两种情况需要回滚：**latest 指错了版本**，或者**某个版本有毒**。

```sh
# 把 latest 指回上一个好版本（需要动态码；这一步只有人能做得成）
npm dist-tag add @zhiliangtech/agentgate@0.1.0 latest

# 某个版本有毒：标记它，不要删除（删除会破坏别人的 lockfile，而且删不掉已下载的）
npm deprecate @zhiliangtech/agentgate@0.1.1 "0.1.1 的 X 有问题，请用 0.1.0；原因见 <链接>"
```

- **不要** `npm unpublish`：24 小时后会被拒，而且会让正在装的人直接失败。
- 确认：`curl -s https://registry.npmjs.org/-/package/@zhiliangtech%2Fagentgate/dist-tags`。
- 已经装到别人机器上的版本，任何回滚动作都拿不回来——所以"有毒版本"的处置是 **deprecate + 发修复版**。

## 2. 服务与站点

```sh
ssh agentgate
cd /opt/agentgate
sudo git log --oneline -3                 # 先看清现在在哪
sudo git fetch -q origin
sudo git merge --ff-only <上一个好提交或 tag> # 用 --ff-only，失败就停下来问，不要 reset
sudo systemctl restart agentgate
curl -s http://127.0.0.1:8080/health | head -20
curl -s http://127.0.0.1:8080/metrics | grep -E "health_ok|index_records"
```

- **绝不** `git reset --hard` / `git clean`：`/opt/agentgate` 里可能有只存在于服务器的数据与产物，而且 `data/` 不属于 git。
- 站点是每天重建的静态文件；如果只是页面坏了，重跑一次 `scripts/build-site.mjs` 通常就够，不必回滚代码。
- 回滚完要确认：`/health` 的 `records` 不是样本的 300 条、`generatedAt` 是当天、`/history.html` 200。

## 3. 数据

索引可以重建（`refresh`），**账本不能**。所以数据这一层的回滚只有一个方向：从备份恢复。

```sh
sudo -u agentgate node /opt/agentgate/scripts/backup.mjs --data /opt/agentgate/data --site /var/www/zhiliang --out-dir /var/backups/agentgate   # 先给"现在"留一份
sudo -u agentgate node /opt/agentgate/scripts/restore-drill.mjs --out-dir /var/backups/agentgate --keep   # 演练并保留解出来的目录
# 确认演练通过、且你要回滚到的那份就是它，然后才替换：
sudo systemctl stop agentgate
sudo mv /opt/agentgate/data /opt/agentgate/data.bad-$(date -u +%Y%m%dT%H%M%SZ)
sudo cp -a <演练保留的目录>/data /opt/agentgate/data
sudo chown -R agentgate:agentgate /opt/agentgate/data
sudo systemctl start agentgate
sudo -u agentgate /opt/agentgate/scripts/healthcheck.sh
```

- **代价要说明白**：备份之后产生的采集会消失，而采集是不可再生的。所以先备份"现在"，再替换，别反过来。
- 恢复完必须跑 `history --verify`（演练脚本已经跑过一遍，替换后再跑一遍确认）。

## 4. 做完之后

在 `docs/operations/incidents.md`（P6）里记一行：时间、哪一层、怎么发现、怎么回滚、下次怎么更快发现。回滚不是失败，**没有记录的静默回滚才是**。
