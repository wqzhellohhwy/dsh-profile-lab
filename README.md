# dsh-profile-lab

> 给 DeepSeek Harness（DSH）用的**临时 profile 实验台**：一条命令建出隔离的 profile，装插件、跑 headless 探针会话、读回结构化摘要、安全回收。
>
> 它存在的唯一理由：**改插件时怕把本体改暴毙**——先在隔离环境里验，确认无误再装进日常用的 profile。

- 宿主半侧插件（Cordis），注册 6 个 `tmpprofile_*` 模型工具；**没有浏览器半侧**，不声明 `dsh.client`。
- `inject` 只写 `['tools']`（**不写 `webServer`**）——所以在 headless / tui 这类没有 HTTP 服务的 profile 里不会整体 pending。
- **零第三方运行时依赖**：只用 `node:fs` / `node:path` / `node:child_process` / `node:zlib` / `node:crypto`。

---

## 它解决什么

| 老做法（每次现写脚本） | 本插件 |
|---|---|
| 想隔离测试，但官方 `--from-default-profile` 只能从 5 个内置模板初始化、**不能从现有 profile 克隆**，还要求目标目录不存在 → 手工 `New-Item` + 写 4 个文件 | `tmpprofile_create`：模板建 **或** `clone: "desktop"` 克隆（配置复制 + `node_modules` 逐项链接复用） |
| 以为 `--from-default-profile` 必然启动，没法"只建不跑" | 内部走 `--dump-config` 短路 boot（**只建、不启动**） |
| 跑探针要手拼 `DSH_HOME` + 环境变量 + `dsh --profile X "任务"`，跑完还要自己去 `sessions/` 里翻会话 | `tmpprofile_run`：一次调用完成"装配 → 跑 → 返回 sessionId 与事件摘要" |
| 读回验证要自己解**多帧 zstd**（`session.v4.jsonl.zstd`），几乎每个会话都重写一遍 Python | `tmpprofile_session`：内置逐帧解码，直接给 preset / 工具面 / 上下文 / token |
| 清理靠自觉（历史上真的漏过两次，残留至今） | `tmpprofile_clean`：清单白名单 + junction 感知删除 + 残留自检 |
| junction 直接 `Remove-Item -Recurse` 有删进源仓库的风险 | 先 `lstat` 判链接、解链接，再递归删目录；**绝不跟随链接** |

---

## 安装

```powershell
# 从本地目录装（开发态）
dsh plugin --profile desktop add link:C:/repository/dsh-profile-lab

# 或从 GitHub 装
dsh plugin --profile desktop add github:<你的账号>/dsh-profile-lab
```

装完**重启 DSH**（插件在启动时装配）。桌面版的 profile 由 Electron 独占管理，命令行直连会被拒——用桌面版插件页装，或走应用内通道。

---

## 六个工具

| 工具 | 干什么 | 关键参数 |
|---|---|---|
| `tmpprofile_create` | 建隔离 profile（模板 / 克隆）＋可选装包 | `name`、`template`（默认 `headless`）、`clone`、`packages`、`purpose`、`overwrite` |
| `tmpprofile_install` | 往已登记的临时 profile 追加安装 / 移除 | `name`、`packages`、`remove` |
| `tmpprofile_run` | 跑一次 headless 探针会话（同步、带超时） | `name`、`task`、`sessionId`、`env`、`timeoutMs`、`json` |
| `tmpprofile_session` | 读会话日志给结构化摘要 | `sessionId` 或 `name`、`sections`、`limit` |
| `tmpprofile_list` | 列出「本插件管的」与「未登记的」profile | — |
| `tmpprofile_clean` | 清理（默认 dry-run，需 `confirm: true`） | `names`、`confirm`、`sessions`、`archiveTo` |
| `tmpprofile_fingerprint` | 采集 `profiles/` 指纹，自查有没有碰到别的 profile | `exclude` |

> 工具名以 `tmpprofile_` 开头，便于在 `dsh-tool-manager` 里整组启用/禁用。

**典型闭环（模型视角）**：

```
tmpprofile_create  { name: "probeA", template: "headless", purpose: "验证 dsh-xxx 的工具面", packages: ["link:C:/plugins/dsh-xxx"] }
tmpprofile_run     { name: "probeA", task: "只回复两个字：OK" }
tmpprofile_session { name: "probeA", sections: ["preset","tools","contexts"] }
tmpprofile_clean   { names: ["probeA"], confirm: true }
```

更多配方见 [docs/RECIPES.md](docs/RECIPES.md)。

---

## 安全护栏（都是刻意的）

1. **只动自己建的**：只有登记在 `$DSH_HOME/profile-lab.json` 里的临时 profile 才可被写/删；`desktop` / `backup` / `web` / `headless` / `dsh-tui` / `rescue` / `reserve` / `acp` / `sdk` / `sdk-minimal` 一律硬拒。
2. **删链接不删目标**：`node_modules` 里的 junction/symlink 先 `lstat` 判定再解链接，然后才递归删目录。
3. **克隆不共享写面**：克隆时 `node_modules` 里的每一项单独链接（不是整目录一个链接），所以随后 `pnpm add` 只改写新 profile，源 profile 一个字节都不动。
4. **clean 默认演练**：不传 `confirm: true` 只返回"将要删除什么"。
5. **覆盖要显式**：`overwrite: true` 只允许覆盖已登记的同名 profile，旧的挪到 `$DSH_HOME/profile-lab-trash/`，不直接删。
6. **失败留痕**：profile 先登记再装包，装包失败也留在清单里，能被 `tmpprofile_clean` 回收。
7. **进程内 + 跨进程锁**：同一 profile 不允许并发运行；跨进程写操作走 `$DSH_HOME/profile-lab.lock`（陈旧锁 120s 自动抢占）。
8. **审计日志**：每次 create / install / run / clean 追加一行到 `$DSH_HOME/profile-lab-log.jsonl`。
9. **不做后台任务**：DSH 的子进程在宿主的 Job Object 里（宿主退出会连带杀死），所以 `tmpprofile_run` 一律**同步 + 超时**（默认 300s，上限 900s，超时 `taskkill /T /F` 杀整棵进程树）。

---

## 配置（cordis 行 config，全部可选）

```yaml
- insert:
    - id: dsh-profile-lab
      name: 'dsh-profile-lab'
      config:
        home: 'C:/Users/you/.dsh'      # 缺省 $DSH_HOME 或 ~/.dsh
        dshBin: ''                      # 显式指定 dsh 的 lib/bin.js（缺省自动探测）
        nodePath: ''                    # 显式指定跑子进程的 node（缺省 process.execPath）
        tools:
          disabled: ['tmpprofile_fingerprint']   # 按名字关掉工具
```

### dsh 可执行文件是怎么找的

按优先级探测，每条都用 `-V` **实测**（`app.asar` 是文件，`existsSync` 看不到内部路径，只能试跑）：

1. `config.dshBin` / 环境变量 `DSH_LAB_DSH_BIN`
2. **宿主安装锚点**：宿主进程的 `profileContext.installAnchor` → `<安装>/…/@deepseek-ai/dsh/lib/bin.js`，用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（版本与宿主一致，兼容性最好）
3. npm 全局安装：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`
4. `C:\dsh-runtime\<版本>\...`

实测样例（Windows + 桌面版宿主）：宿主锚点 → `0.2.0-rc.2`（host 同版本）；兜底 npm 全局 → `0.2.1-alpha.1`。

---

## 会话日志是怎么读的

`session.v4.jsonl.zstd` 是**多帧** zstd（DSH 每追加一批事件压一帧）。Node 的 `zstdDecompressSync` 对多帧输入**只解第一帧且不报错**，也不暴露"剩余未消费字节"——整段丢进去只拿到 254 字节的 header。

官方 `@deepseek-ai/dsh-session-persistence-jsonl` 的做法是：按 zstd 魔数（`0xFD2FB528`，小端 `28 B5 2F FD`）扫描帧起点，再逐帧解压。本插件用同一思路并利用"one-shot 只解第一帧"的特性把实现压到最短：对每个魔数偏移试解一次，成功即得该帧，伪魔数（解出来不是 `{` 开头）直接跳过。

实测：6.51 MiB 压缩 → **4322 帧** → 20 MiB 文本 → 6901 事件，摘要正确。

---

## 测试

```powershell
# 单元测试（全部在临时 DSH_HOME 里跑，不碰真实环境）
npm test

# 真实闭环（会真建 profile、真跑一次 headless、真清理；消耗极少量 token）
$env:DSH_LAB_LIVE='1'; node --test tests/live.test.js
```

live 测试的硬断言：**除本次建的临时 profile 外，`profiles/` 里其他 profile 的指纹（hash + mtime）必须一个字节不变**。

---

## 限制（明确不做）

- **不是危机救援工具**：主力 profile 起不来时，本插件也起不来。要救援请用 `rescue` / `reserve` 实例。
- **不做后台/脱离宿主的任务**：见上文 Job Object。
- **不自动纳管已有的临时 profile**：`profiles/` 里历史残留（例如早年手工建的目录）会出现在 `unmanaged` 列表里，需要你确认后用 `adoptProfile` 显式纳管，本插件不会自动动它们。
- **共享 `DSH_HOME`**：探针会话仍写在主力的 `sessions/` / `storages/` 下（同一 home 无跨进程锁）。要彻底隔离得用独立 `DSH_HOME`，尚未实现。

---

## 文件位置

| 内容 | 路径 |
|---|---|
| 清单 | `$DSH_HOME/profile-lab.json` |
| 审计日志 | `$DSH_HOME/profile-lab-log.jsonl` |
| 跨进程锁 | `$DSH_HOME/profile-lab.lock` |
| 覆盖时丢弃的旧 profile | `$DSH_HOME/profile-lab-trash/` |
| 临时 profile | `$DSH_HOME/profiles/<name>/` |

## 许可

MIT
