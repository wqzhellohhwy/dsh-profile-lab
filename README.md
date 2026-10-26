# dsh-profile-lab

> 给 DeepSeek Harness（DSH）用的**临时 profile 实验台**：一条命令建出隔离的 profile，装插件、跑 headless 探针会话、起驻留 web 实例验 HTTP/渲染面、读回结构化摘要、安全回收。
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
| **验不了渲染端 / HTTP 面**（headless 根本没有 HTTP 服务），只能手搓 pwsh 起 `dsh web --port` 再 curl | `tmpprofile_web_start` / `web_probe` / `web_stop`：起**驻留 web 实例**、探任意路由、按 pid 收（跨插件重载也能收） |
| 读回验证要自己解**多帧 zstd**（`session.v4.jsonl.zstd`），几乎每个会话都重写一遍 Python | `tmpprofile_session`：内置逐帧解码，直接给 preset / 工具面 / 上下文 / token |
| 清理靠自觉（历史上真的漏过两次，残留至今） | `tmpprofile_clean`：清单白名单 + junction 感知删除 + 残留自检 |
| junction 直接 `Remove-Item -Recurse` 有删进源仓库的风险 | 先 `lstat` 判链接、解链接，再递归删目录；**绝不跟随链接** |
| 清理软件按「临时文件」整树删 `%TEMP%` 时会跟随联结，把插件源目录删空（2026-10-25 事故根因） | 要建 junction 的路径（`create: clone/packages`、`install: link:`）一律拒绝落在 `os.tmpdir()` 内的 home；测试等确需临时 home 时设 `DSH_PROFILE_LAB_ALLOW_TEMP_HOME=1` 显式放行 |
| 探针会话落在 profile 内部的隔离 home（`<profile>/.lab-home/.dsh/sessions`），只扫 `$DSH_HOME/sessions` 找不到会话 | `sessionRoots()` 把隔离 home 一并纳入（`findSessionDir` 用），`clean` 则在删 profile 目录**之前**先把会话目录解析好 |

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

## 十个工具

| 工具 | 干什么 | 关键参数 |
|---|---|---|
| `tmpprofile_create` | 建隔离 profile（模板 / 克隆）＋可选装包 | `name`、`template`（默认 `headless`）、`clone`、`packages`、`purpose`、`overwrite` |
| `tmpprofile_install` | 往已登记的临时 profile 追加安装 / 移除 | `name`、`packages`、`remove` |
| `tmpprofile_run` | 跑一次 headless 探针会话（同步、带超时） | `name`、`task`、`sessionId`、`env`、`timeoutMs`、`json` |
| `tmpprofile_web_start` | 起**驻留 web 实例**（真实 HTTP 服务，验 host 路由/渲染面） | `name`、`port`、`probePath`、`waitMs`、`cwd`、`env` |
| `tmpprofile_web_probe` | 对驻留实例发一次 HTTP 探针 | `name`、`path`、`method`、`timeoutMs` |
| `tmpprofile_web_stop` | 停掉驻留实例（`taskkill /T /F` + 确认端口释放） | `name`、`waitMs` |
| `tmpprofile_session` | 读会话日志给结构化摘要 | `sessionId` 或 `name`、`sections`、`limit` |
| `tmpprofile_list` | 列出「本插件管的」与「未登记的」profile | — |
| `tmpprofile_clean` | 清理（默认 dry-run，需 `confirm: true`；会先停实例） | `names`、`confirm`、`sessions`、`archiveTo` |
| `tmpprofile_fingerprint` | 采集 `profiles/` 指纹，自查有没有碰到别的 profile | `exclude` |

> 工具名以 `tmpprofile_` 开头，便于在 `dsh-tool-manager` 里整组启用/禁用。

**典型闭环（模型视角）**：

```
# A. host 面：装配 + 工具面 + 会话行为
tmpprofile_create  { name: "probeA", template: "headless", purpose: "验证 dsh-xxx 的工具面", packages: ["link:C:/plugins/dsh-xxx"] }
tmpprofile_run     { name: "probeA", task: "只回复两个字：OK" }
tmpprofile_session { name: "probeA", sections: ["preset","tools","contexts"] }

# B. 渲染 / HTTP 面：起真实例，探插件的 host 路由
tmpprofile_create    { name: "webA", template: "web", packages: ["link:C:/plugins/dsh-xxx"] }
tmpprofile_web_start { name: "webA", probePath: "/api/dsh-xxx/status" }
tmpprofile_web_stop  { name: "webA" }

tmpprofile_clean   { names: ["probeA", "webA"], confirm: true }
```

> **web 实例与 headless 探针验的不是同一件事**：headless 给 **host 侧装配事实**
> （哪个 entry 没激活、卡在等哪个服务），web 实例给 **HTTP/渲染面事实**
> （端口真的在听、插件的 host 路由真的注册了、页面能加载）。两者都要，才有完整画像。
> 注意 `web_start` 要求 profile 的 bundles 里有 `@deepseek-ai/dsh-web-app`——
> 用 `template: "web"` 建，或从带 web-app 的 profile 克隆。

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
9. **驻留实例是刻意的例外，且加倍设防**：`tmpprofile_web_start` 起的 web 实例会**驻留**（这是它存在的意义），所以：同一 profile 只允许一个实例；端口从 19399 起自动挑空闲的；stdout/stderr 只留尾部环形缓冲；进程**不 detach**（留在宿主 Job Object 内，宿主退出连带杀掉）；插件卸载时 `killAllWebInstances()` 再扫一遍；`tmpprofile_clean` 删目录前先按清单 pid 停实例。
10. **不做后台任务**：DSH 的子进程在宿主的 Job Object 里（宿主退出会连带杀死），所以 `tmpprofile_run` 一律**同步 + 超时**（默认 300s，上限 900s，超时 `taskkill /T /F` 杀整棵进程树）；唯一的常驻形态就是上面那三条 `web_*` 工具，并且必须由调用方显式停止（或用 `clean` 兜底）。

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

## 两个 DSH 侧的坑（本插件都已堵掉）

1. **工具返回值必须是 lossless JSON**。只要返回值里出现 `undefined`（哪怕只是某个可选字段），DSH 会把整条结果拒收，模型看到的是
   `tool "x" returned invalid output: value is not lossless JSON` 而不是数据。本插件在所有工具出口统一做了一次净化（丢 `undefined`、非有限数转 `null`）。
2. **headless 的 `--json` 是投影，不是日志**。它用自己的一套事件名（`tool_call`、`tool_result`、`status`、`thinking`…），**不含**日志里的 `tool/call`；
   官方文档也明说它"caps every string except the terminal `final` at 8 KiB and omits events the projection does not model"。
   所以「到底调了哪些工具」必须以磁盘上的完整会话日志为准——`tmpprofile_run` 已经替你把这一步做了：返回值里的 `session.tools` 就是完整日志的工具面。

---

## 自检

装好之后（或改动代码之后）可以直接跑内置自检——它会真建一个临时 profile、装本插件、跑一次 headless 让模型调用 `tmpprofile_list`、再清理：

```powershell
node scripts/selfcheck.mjs
```

退出码 0 表示插件在真实 DSH 里能加载、工具可被调用、清理无残留。

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
- **web 实例只验到"服务端+静态资源"这一层**：端口在听、路由在答、页面 HTML 能取到；页面里 JS 真的执行、UI 真的渲染出来，只有真浏览器加载才会发生（需要的话自己打开 `http://127.0.0.1:<port>/` 看）。
- **不做脱离宿主的任务**：见上文 Job Object。
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
