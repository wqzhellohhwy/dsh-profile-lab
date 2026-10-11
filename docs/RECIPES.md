# 配方（RECIPES）

四条实战配方。前三条对应真实发生过的需求，第四条是收尾。

---

## 配方 1：验证一个插件改动，不碰 desktop

**场景**：你改了 `C:\plugins\dsh-my-thing` 的源码，想知道它在真实 DSH 装配下能不能加载、工具面对不对，但**不敢直接装进 desktop**。

```
tmpprofile_create {
  name: "chk-mything",
  template: "headless",
  purpose: "验证 dsh-my-thing 装配与工具面",
  packages: ["link:C:/plugins/dsh-my-thing"]
}
```

看返回：
- `bundles` 里应出现 `dsh-my-thing`（带 `dsh.bundle` 的包会被 dsh 自动挂上；没挂上说明该包没声明 `dsh.bundle`，只作为普通依赖装了——`install.addedBundles` 空就是这个信号）；
- `install.stderrTail` 里若有 `declares no dsh.bundle — installed as a plain dependency`，就是同一个信号。

```
tmpprofile_run { name: "chk-mything", task: "只回复两个字：OK" }
```

- `exitCode: 0` + 有 `sessionId` → 装配成功；
- `exitCode: 1` 且 `stderrTail` 里有 `skipping profile bundle ... incompatible` → 版本闸门拒了（用 `tmpprofile_install` 的 `remove` 卸掉，或确认包的 peerDependencies）。

```
tmpprofile_session { name: "chk-mything", sections: ["tools", "preset", "errors"] }
```

看 `tools` 列表里有没有你的插件注册的工具，`errors` 有没有启动期报错。

确认无误 → 装进 desktop；有问题 → `tmpprofile_clean { names: ["chk-mything"], confirm: true }`。

---

## 配方 2：会话行为测试（preset / 上下文 / 工具面 / 缓存）

**场景**：验证某个 agent preset 到底挂了多少工具、注入没注入记忆上下文、改配置后 KV 缓存命中率如何。

**多轮对照要用同一个会话**（`--session-id`）：

```
tmpprofile_create { name: "probeA", template: "headless", purpose: "preset 与上下文验证" }
tmpprofile_run    { name: "probeA", task: "回复两个字：第一轮" }
tmpprofile_run    { name: "probeA", task: "回复两个字：第二轮", sessionId: "<上一轮返回的 sessionId>" }
tmpprofile_session { sessionId: "<sessionId>", sections: ["preset", "tools", "contexts", "tokens"] }
```

摘要里看：
- `preset.agentPreset`：会话实际用的 preset；
- `tools[]`：每次工具调用次数与错误数（`errors`）；
- `contexts[]`：`system/message` / `developer/message` / `request/context` 的条数与样例（**记忆插件、提示词插件注入的东西就在这里**）；
- `tokens`：`uncachedInputTokens` / `cacheReadTokens` / `outputTokens` 累计——同一会话多轮时 `cacheReadTokens` 明显大于 0 就说明前缀被复用了。

需要看原始事件时加 `"raw"` 到 `sections` 并给 `limit`。

---

## 配方 3：复现「一个插件把 dsh 搞崩」

**场景**：怀疑某个插件让桌面版起不来，想在隔离环境里复现崩溃日志。

用**克隆**：把 desktop 的插件集原样搬到一个临时 profile，然后在里面开刀（加/减/改 bundles），`desktop` 一个字节都不动。

```
tmpprofile_create { name: "reproA", clone: "desktop", purpose: "复现 xxx 导致的启动崩溃" }
tmpprofile_install { name: "reproA", remove: ["dsh-super-injector"] }   # 二分法逐步摘
tmpprofile_run { name: "reproA", task: "只回复两个字：OK" }
```

- 克隆出来的 `node_modules` 是**逐项链接**，所以摘/装包只改 `reproA`；
- 崩溃信息在 `stderrTail`；如果崩在启动装配阶段，`exitCode` 非 0 且 `stderrTail` 里能看到 `skipping profile bundle` / `entry did not activate` 之类；
- 改完 bundles 想整体校验配置树（不启动）时，可以直接用 pwsh 跑一次 `dsh --profile reproA --dump-config`（只打印组合结果）。

收尾：`tmpprofile_clean { names: ["reproA"], confirm: true, archiveTo: "<证据目录>" }`——`archiveTo` 会把配置文件归档（不含 `node_modules`），并写一份 `ARCHIVE-NOTE.md`，便于日后复现。

---

## 配方 4：清理与自查

```
tmpprofile_list        # managed = 我建的；unmanaged = 正式实例或历史残留（本插件不碰）
tmpprofile_clean { names: ["probeA", "chk-mything"] }                  # 演练：只告诉你将删什么
tmpprofile_clean { names: ["probeA", "chk-mything"], confirm: true }   # 真删（含探针会话）
```

**自查有没有误伤别的 profile**（做危险操作前后各采一次，对比即可）：

```
tmpprofile_fingerprint { exclude: ["probeA"] }
```

两次返回值里同名路径的 `sha256` 与 `mtime` 完全一致 = 没被碰过。

---

## 附：什么时候不要用这套

- **主力 profile 已经起不来了** → 用 `rescue` / `reserve` 实例，不是本插件（插件本身也起不来）。
- **只是想看看某个 profile 的配置树** → 直接用 `dsh --profile <n> --dump-config`，不必建临时 profile。
- **要跨机器/长期保留的验证环境** → 本插件的临时 profile 是为"用完就删"设计的；要长期保留请显式 `adoptProfile` 纳管，或自己建正式 profile。
