# CHANGELOG

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
