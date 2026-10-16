# CHANGELOG

## 2026-10-17 01:00 — 数据隔离：临时 profile 不再碰真机目录

### 问题
临时 profile 里的插件按 `homedir()` / `DSH_HOME` 推数据目录，于是**实测会写进真机的 `~/.dsh/memories`**（当天两次污染用户真实状态）。

### 修改
- `lib/runner.js` 新增 **`isolatedHome()` / `applyIsolatedHome()`**（导出）：spawn 前设置环境变量 ——
  1. `HOME` / `USERPROFILE` → `<profile>/.lab-home`（插件按 homedir 推的路径全落这里）；
  2. `DSH_HOME` → `<profile>/.lab-home/.dsh`（DSH 的 memories / sessions / coi … 也落这里），其下 `profiles/<name>` 用 **junction 指回真实 profile**，DSH 照常找得到 profile。
  - 链接**幂等重建**（先删再建，避免"链接还在但指错地方"——首版就在这栽过一次）。
  - 逃生口：`DSH_LAB_KEEP_HOME=1` 时两层隔离都不做。
- `runHeadless()` 与 `lib/web.js` 的 `startWebInstance()` 都在 spawn 前套用。

### 实测
- 起 meblk web 实例后，探针 `/memory-evolve/api/tools` 的 `file` 字段由 `C:\Users\53518\.dsh\memories\tools.json` 变为 `…\.dsh\profiles\meblk\.lab-home\.dsh\memories\tools.json` ✓（真机目录不再被写），探针 HTTP 200。

### agent 约定
- 临时 profile 默认隔离 home；确有需要读写真机数据时才设 `DSH_LAB_KEEP_HOME=1`。
- 隔离数据在 `<profile>/.lab-home`，清理 profile 时一并删除。

## 2026-10-17 00:30 — 装包自动降级 + web 实例能力预检

### 问题
1. **clone 出来的 profile 装包必失败**：它只逐项链接了 `node_modules`，没复制 pnpm 的 `.modules.yaml` → `dsh plugin --profile <n> add …` 报 `ENOENT … .modules.yaml`。
2. **headless 型 profile 起 web 实例**：首版尝试「自动补 `@deepseek-ai/dsh-web-app`」，实测**没用** —— **一个 profile 只能有一个 app**：补了 bundle 后 `dsh --profile <n> --help` 仍打印 headless app 的用法、`--port` 变成未知参数、端口上根本没有我们的服务。

### 修改
- `lib/lab.js`：
  - 新增导出 **`fallbackInstallLinked(name, packages, home)`**：手工装配 —— 建 junction + 写 `dependencies` 与 `dsh.profile.bundles`（带 `dsh.bundle` 的包照官方行为挂进 bundles）；只支持 `link:` 规格，其它规格如实报 `reason`。
  - `installIntoProfile()`：pnpm 失败时**自动降级**，返回 `{ ok: true, fallback: true, … , note }`；降级也做不了才失败，并给出 `fallbackReason`。
- `lib/web.js`：
  - 新增 `assertWebCapable()`：起实例前看 profile 的 bundles —— **含 headless（app 是 headless）或缺 web-app** 都直接返回可读错误 + 指引（`template: 'web'` 或从 web 型 profile 克隆），不再做无效的自动补 bundle。
  - `startWebInstance()` 用它替换首版逻辑，失败 `reason: 'not-a-web-profile'`。

### 实测
- `tmpprofile_install(meblk, ['link:…/dsh-cache-keepalive'])` → pnpm ENOENT → **降级成功**（`fallback: true`，bundle 与 dependency 均已写入）。
- `tmpprofile_web_start(meblk2)`（headless 型）→ 「app 是 headless，不能起 web 实例」+ 两条可执行建议。
- `tmpprofile_web_start(meblk)`（web 型）→ 成功，探针 **HTTP 200**（回归通过）。

### agent 约定
- **一个 profile 只有一个 app**：headless 型只跑 headless 探针，web 型只起 web 实例；两用就建两个 profile。
- 往临时 profile 装包用 `link:` 规格最稳（pnpm 失败会自动降级，registry 规格不支持降级）。

## 2026-10-16 23:55 — 探针运行：类型预检 + `--json` 自适应（用户实测反馈）

### 问题
用户在真机跑探针时连续撞两种难懂的失败：
1. 对 **clone 出来的 web 型 profile** 跑 headless → `too many arguments. Expected 0 arguments but got 1: <task>`（web app 不接受位置参数，但工具没拦）。
2. 另一些场景报 `unknown option '--json'` —— 目标 app 不支持该 flag 时照发，整轮直接失败。

### 修改
- `lib/runner.js`：
  - 新增导出 `profileBundles(profile, home)`：读 `<DSH_HOME>/profiles/<name>/package.json` 的 `dsh.profile.bundles`。
  - `runHeadless()` 改为 `async`，开跑前**预检 profile 类型**：bundles 里没有 `@deepseek-ai/dsh-headless` 就直接报错，并给出两条可执行建议（`tmpprofile_create({template:'headless'})` 或 `tmpprofile_install` 补 bundle）。
  - 新增 `supportsJsonFlag()`（跑一次 `<profile> --help` 探测，结果缓存）：目标 app 不支持 `--json` 时**自动降级为纯文本模式**（sessionId 由既有的会话目录回捞逻辑补上）。
  - 返回值新增 `jsonFlag`：本轮是否真的带了 `--json`。
  - 并发报错文案补上"请先 tmpprofile_web_stop 或等它跑完"。

### 实测（临时 profile）
- `tmpprofile_run(meblk)`（web 型）→ 立即返回**可读错误**，含 bundles 清单与两条修复建议（不再是 `too many arguments`）。
- `tmpprofile_run(meblk2)`（headless 型）→ 成功，3.6s，`exitCode 0`，无 `--json` 相关报错。

### agent 约定
- 跑 headless 探针**必须**用 `template: 'headless'` 建的 profile；clone 的 web profile 只能起 `tmpprofile_web_start`。

## 2026-10-16 17:30 — 测试临时目录自动清理

### 问题
测试用 `mkdtempSync(join(tmpdir(), 'xxx-'))` 建临时目录，靠零散的 `rmSync` 手动删。断言失败提前抛出、或漏写删除时目录永久残留在 `%TEMP%`。累积数千个顶层条目后，Windows 登录时 `winlogon 通知订户 <Profiles>` 耗时升至 100+ 秒（欢迎界面卡死）。

### 新增
- `tests/_tmp.js`：临时目录登记 + 三层清理 + 启动清扫。
- `scripts/clean-tmp.mjs`：测试结束后的最终清扫。

### 修改
- 6 个 `tests/*.test.js`：`mkdtempSync(join(tmpdir(), 'xxx-'))` → `tmproot('xxx-')`，并 import `tmproot`。
- `package.json`：`test` 脚本追加 `node scripts/clean-tmp.mjs`。

### agent 约定
- 测试建临时目录一律用 `tmproot(前缀)`，**禁止**直接 `mkdtempSync(join(tmpdir(), ...))`。
- 需要提前释放用 `tmpremove(dir)`。
- **不要**在测试里写 `rmSync(dir)` 手工清理：`_tmp.js` 已覆盖（含断言失败路径）。多写反而在 Windows 上触发"删完又被异步写盘重建"。
- 清理脚本 `clean-tmp.mjs` 已挂进 `npm test`；单独跑测试后用 `npm run test` 或手动执行该脚本兜底。
