# 136 · macOS 自动更新 404（issue #2 症状二）：darwin 显式禁用检查 + 双语提示

> 状态：已实现（3.14.4-ce.1，工作树待提交）。覆盖 backlog「已排入 3.14.4-ce.1」表中
> 「macOS 自动更新 404（issue #2 症状二）：darwin 显式禁用检查 + 提示」一条。
> 编号说明：135 已被 bot-management-ui 占用，取下一可用号 136。

## 0. 开工前读了什么 / 结论一致性

| 材料                                                                | 结论                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根 AGENTS.md（「UI 与平台边界」「文档与知识库」「实现与验证」各节） | 一致。平台差异走依赖注入、不直接调 window.zcode；文档与代码同步更新。                                                                                                                                                                                                 |
| docs/development/delegation-discipline.md                           | 一致。本任务单人完成，无并行写范围冲突；回传含门禁真实结果。                                                                                                                                                                                                          |
| docs/operations/release.md                                          | 一致，且是判定依据：§平台支持「Linux 与 Windows。macOS 暂不发布（无代码签名证书）」；§更新渠道的产物表只有 latest-linux.yml / latest.yml 两行。⇒ macOS 客户端的 app-update.yml（github provider）请求 latest-mac.yml 必然 404。本文档同步处见 §6。                    |
| packages/desktop/src/main/autoUpdater.ts（全文 1982 行）            | 一致。入口已定位：initAutoUpdater（启动检查 + 每小时轮询）、checkForUpdateMenuClick（手动检查，回传 UpdateCheckResultPayload）、requestForceAutoUpdate（强更，CE 不接线见 §1.5）。三处都可能触发 autoUpdater.checkForUpdates()，darwin 分支须同时覆盖前两者与第三者。 |
| packages/desktop/src/main/manifestUpdateProvider.ts                 | 一致。getElectronReleasePlatform 把 darwin 映到 osx；ManifestUpdateProvider 是自建 manifest 协议路径，本任务不动。                                                                                                                                                    |
| packages/ui/src/root/useRootPlatformEffects.ts                      | 一致。UpdateCheckResultPayload 按 kind 走 toast（i18n 族 update.toast.\*），新增 kind 只需加 case + 两条 locale 条目。                                                                                                                                                |
| packages/desktop/src/main/index.ts:2047-2062                        | 一致。CE 显式跳过远端强更门，requestForceAutoUpdate 在 CE 不可达；对它加 darwin 守卫是防御性的（注释须写明）。                                                                                                                                                        |
| packages/desktop/test/remoteAssetCdnSettingPriority.test.ts:8-12    | 一致，并给出测试形态约束：「会拉进 electron 的模块在 node:test 里必然失败」——判定逻辑必须抽成不导入 electron 的纯模块才能有可执行测试。                                                                                                                               |

## 1. 产品规则

1. macOS 上「不支持自动更新」是确定事实，不是故障。提示不得读成「检查失败请重试」：
   不复用 error / failed 通道，单独一个 payload kind + 单独 i18n 键，文案给出可操作动作（手动从 GitHub Releases 下载）。
2. 跳过范围精确到「darwin 正式包 + 未配置更新源覆盖」三个条件同时成立。其余形态行为完全不变：
   - win32 / linux 正式包：启动检查、轮询、手动检查、下载、安装链路逐行不动。
   - darwin 未打包 + ZCODE_AUTO_UPDATE_DEV：本地 manifest 验证链路（含 isDevSquirrelReadyError 那套 Squirrel 兜底）保持可用。
   - 任意平台 + ZCODE_UPDATE_FEED_URL 覆盖（镜像 / 自建 feed）：另一种部署形态，其 manifest 是否提供 macOS 包由部署方决定，不由本发行线的缺失反推禁用。
3. 跳过 = 不发请求、不报错、不展示失败。具体：initAutoUpdater 不注册事件、不启动 startup 检查、
   不起一小时轮询；菜单项保持「检查更新」可用（enabled），点击后给出确定性提示，而不是禁用后无解释。
4. 日志必须可排查：init 时一条 info，写明「darwin 正式包不支持自动更新、已跳过检查、请手动下载」，
   替代原先每次启动/轮询产生的 404 error 噪音。
5. requestForceAutoUpdate 同样加守卫（复用既有 dev-skipped 通道回传原因）：CE 当前不接线强更门，
   此分支纯防御，避免将来接线启用时 macOS 上又回到 404 循环。

## 2. 状态所有者

| 状态                                         | 唯一所有者                                                                   | 读取方                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| 跳过判定（platform / isPackaged / feed url） | 纯函数 shouldSkipAutoUpdateCheckOnDarwinRelease（autoUpdateAvailability.ts） | initAutoUpdater / requestForceAutoUpdate 各自调用 |
| 「本进程已确认 darwin 跳过」                 | autoUpdater.ts 模块级 autoUpdateUnavailableOnDarwinRelease 标志              | checkForUpdateMenuClick / requestForceAutoUpdate  |
| 更新状态机（idle / checking / ...）          | 不变，仍是 autoUpdater.ts 的 menuState                                       | 菜单与 renderer，darwin 跳过时恒为 idle-enabled   |

设计取舍：判定逻辑不内联进 initAutoUpdater，是因为 autoUpdater.ts 顶部 import electron /
electron-updater，node:test 无法加载（desktop 包既有测试纪律，见 §0 最后一行）。纯模块 + 集成桩
两层测试才能同时钉住「判定组合」与「判定真的被接线调用」。

## 3. 事件顺序

darwin 正式包（无 feed 覆盖）：

```
initAutoUpdater({ settingService, locale, updateFeedSource? })
→ canUseAutoUpdaterInCurrentRuntime() 通过（已打包）
→ locale / settingService 落位、既有轮询与状态重置（与 HEAD 一致）
→ shouldSkipAutoUpdateCheckOnDarwinRelease(darwin, packaged, 无 feed) === true
→ autoUpdateUnavailableOnDarwinRelease = true
→ logger.info（确定性提示，一次）
→ return：不注册 electron-updater 事件、不 ipcMain.handle、不起 triggerCheckForUpdates("startup")、不起 setInterval
用户点「检查更新」
→ checkForUpdateMenuClick
→ flavor 门 / 运行态门通过后命中 autoUpdateUnavailableOnDarwinRelease
→ webContents.send(UpdateCheckResult, { kind: "unsupported-platform" })
→ renderer toast：update.toast.unsupportedPlatform（双语）
```

win/linux 正式包：事件顺序与 HEAD 完全一致（判定函数返回 false，新增代码路径不执行）。

## 4. 接口

```ts
// packages/shared/src/update.ts —— 新增一种结果（不影响既有 7 种）
export type UpdateCheckResultPayload =
  | ...
  | { kind: "unsupported-platform" };

// packages/desktop/src/main/autoUpdateAvailability.ts —— 新纯模块，不导入 electron
export function shouldSkipAutoUpdateCheckOnDarwinRelease(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  updateFeedUrl?: string | null;
}): boolean;

// packages/ui/src/root/useRootPlatformEffects.ts —— switch 加一条 case
case "unsupported-platform":
  toast(intl.formatMessage({ id: "update.toast.unsupportedPlatform" }));

// packages/ui/src/i18n/locales/{zh-CN,en-US}.ts —— update.toast.* 族新增一条
```

i18n 文案（双语，不含「失败/重试」措辞）：

- zh-CN：macOS 暂不支持自动更新：本发行线不发布 macOS 安装包，请手动从 GitHub Releases 下载新版本。
- en-US：Auto-update isn't available on macOS: this release line doesn't publish macOS builds.
  Download new versions from GitHub Releases manually.

## 5. 测试

两层，都进 CI（packages/desktop 已在 scripts/run-tests.mjs 的 TEST_PACKAGES 里）：

1. autoUpdateDarwinAvailability.test.ts（纯判定矩阵）：
   darwin+packaged+无 feed → true；darwin+packaged+feed → false；darwin+dev → false；
   win/linux+packaged → false；feed 为空白串按未配置处理。
   同时断言 { kind: "unsupported-platform" } 满足 UpdateCheckResultPayload，
   两个 locale 文件都有 update.toast.unsupportedPlatform 键且非空。
2. autoUpdaterDarwinSkip.test.ts（ electron 桩集成）：用 node:module register 的 resolve 钩子
   把 electron / electron-updater重定向到测试桩，真实加载 autoUpdater.ts：
   - darwin+packaged：initAutoUpdater 后 checkForUpdates 调用数为 0，无 ipc handle 注册，
     checkForUpdateMenuClick 发回 { kind: "unsupported-platform" }；
   - linux+packaged：initAutoUpdater 后 checkForUpdates 调用数为 1（启动检查照常）；
   - darwin+packaged+feed 覆盖：判定不跳过，init 继续走完（setFeedURL 被调，provider 切 manifest）；
   - darwin+dev（未打包 + ZCODE_AUTO_UPDATE_DEV）：判定不跳过，启动检查照常。

未验证项见 §7：未在真实 macOS 客户端验证，行为由上述测试钉住。

## 6. 文档同步

- docs/operations/release.md：§平台支持新增「macOS 客户端不检查更新、显式提示」一句，
  指明方案 a 已实现（release.md 是发布维护者视角，写行为而非实现）。
- docs/operations/release-design.md：其引用的 autoUpdater.ts 行号已漂移（applyManifestUpdateProvider
  已改名 applyUpdateProvider），顺手订正为当前行号并补 darwin 跳过分支。
- docs/development/backlog.md：issue #2 症状二一条状态更新为已完成（spec 136）。

## 7. 诚实边界（未验证项）

- 未在真实 macOS 客户端验证（无 mac 打包环境与签名）：行为靠 §5 两层测试钉住；真实机器上
  可验证点为：帮助菜单点「检查更新」看到确定性提示 toast，且日志目录里无 404 error。
- darwin arm64/x64 未分别验证：判定只看 platform，不看 arch。
- 自托管 feed 在 darwin 上的端到端升级未验证（无自建 manifest 服务），仅钉住「不被本发行线禁用」。
