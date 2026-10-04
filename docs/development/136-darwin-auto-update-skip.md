# 136 · macOS 自动更新 404（issue #2 症状二）：darwin 显式禁用检查 + 双语提示

> 状态：已实现。覆盖 backlog「已排入 3.14.4-ce.1」表中「macOS 自动更新 404（issue #2 症状二）：
> darwin 显式禁用检查 + 提示」一条。3.14.4-ce.2 起发行线发布未签名 macOS 安装包
> （darwin x64 + arm64，.dmg + .zip，ad-hoc 签名、不公证）；electron-updater 在 macOS
> 保持关闭（三条件跳过逻辑不变），toast 文案改为引导从 GitHub Releases 下载未签名安装包。
> 编号说明：135 已被 bot-management-ui 占用，取下一可用号 136。

## 0. 开工前读了什么 / 结论一致性

| 材料                                                                | 结论                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根 AGENTS.md（「UI 与平台边界」「文档与知识库」「实现与验证」各节） | 一致。平台差异走依赖注入、不直接调 window.zcode；文档与代码同步更新。                                                                                                                                                                                                 |
| docs/development/delegation-discipline.md                           | 一致。本任务单人完成，无并行写范围冲突；回传含门禁真实结果。                                                                                                                                                                                                          |
| docs/operations/release.md                                          | 发布维护者视角的平台支持与更新渠道表；本文档 §1 的产品规则与之对齐（发布未签名 macOS 包、客户端不检查更新），同步点见 §6。                                                                                                                                            |
| packages/desktop/src/main/autoUpdater.ts（全文 1982 行）            | 一致。入口已定位：initAutoUpdater（启动检查 + 每小时轮询）、checkForUpdateMenuClick（手动检查，回传 UpdateCheckResultPayload）、requestForceAutoUpdate（强更，CE 不接线见 §1.5）。三处都可能触发 autoUpdater.checkForUpdates()，darwin 分支须同时覆盖前两者与第三者。 |
| packages/desktop/src/main/manifestUpdateProvider.ts                 | 一致。getElectronReleasePlatform 把 darwin 映到 osx；ManifestUpdateProvider 是自建 manifest 协议路径，本任务不动。                                                                                                                                                    |
| packages/ui/src/root/useRootPlatformEffects.ts                      | 一致。UpdateCheckResultPayload 按 kind 走 toast（i18n 族 update.toast.\*），新增 kind 只需加 case + 两条 locale 条目。                                                                                                                                                |
| packages/desktop/src/main/index.ts:2047-2062                        | 一致。CE 显式跳过远端强更门，requestForceAutoUpdate 在 CE 不可达；对它加 darwin 守卫是防御性的（注释须写明）。                                                                                                                                                        |
| packages/desktop/test/remoteAssetCdnSettingPriority.test.ts:8-12    | 一致，并给出测试形态约束：「会拉进 electron 的模块在 node:test 里必然失败」——判定逻辑必须抽成不导入 electron 的纯模块才能有可执行测试。                                                                                                                               |

## 1. 产品规则

1. macOS 上「不支持自动更新」是确定事实，不是故障。提示不得读成「检查失败请重试」：
   不复用 error / failed 通道，单独一个 payload kind + 单独 i18n 键，文案给出可操作动作
   （发行线发布未签名 macOS 包 ⇒ 引导从 GitHub Releases 下载，首次打开允许 Gatekeeper）。
2. 跳过范围精确到「darwin 正式包 + 未配置更新源覆盖」三个条件同时成立。其余形态行为完全不变：
   - win32 / linux 正式包：启动检查、轮询、手动检查、下载、安装链路逐行不动。
   - darwin 未打包 + ZCODE_AUTO_UPDATE_DEV：本地 manifest 验证链路（含 isDevSquirrelReadyError 那套 Squirrel 兜底）保持可用。
   - 任意平台 + ZCODE_UPDATE_FEED_URL 覆盖（镜像 / 自建 feed）：另一种部署形态，其 manifest 是否提供 macOS 包由部署方决定，不由本发行线的缺失反推禁用。
3. 跳过 = 不发请求、不报错、不展示失败。具体：initAutoUpdater 不注册事件、不启动 startup 检查、
   不起一小时轮询；菜单项保持「检查更新」可用（enabled），点击后给出确定性提示，而不是禁用后无解释。
4. 日志必须可排查：init 时一条 info，写明「darwin 正式包不支持自动更新、已跳过检查、
   请从 GitHub Releases 下载未签名安装包」，替代更新链路可能产生的请求失败噪音。
5. requestForceAutoUpdate 同样加守卫（复用既有 dev-skipped 通道回传原因）：CE 当前不接线强更门，
   此分支纯防御，避免将来接线启用时 macOS 上又回到请求失败循环。
6. macOS 发布策略（3.14.4-ce.2 起）：发行线发布未签名 macOS 安装包。
   - 目标平台与产物：darwin x64 + darwin arm64，各产出 .dmg 与 .zip
     （`ZCode-CE-<版本>-darwin-<arch>.dmg / .zip`）。
   - 签名：两个架构都在 mac runner 上 ad-hoc 签名（`codesign -f -s -`，无需 Apple 账号）。
     未签名的 arm64 二进制在 Apple Silicon 上完全无法启动；x64 同样 ad-hoc 保持一致。
   - 公证：不做（无 Apple ID）；首次打开需用户允许 Gatekeeper
     （右键打开，或 `xattr -dr com.apple.quarantine <path>` 去隔离属性）。
   - 自动更新：electron-updater 在 macOS 保持关闭——未签名包不具备自动更新链路所需的
     签名校验基础；darwin 客户端的新版本经 GitHub Releases 手动获取，自动更新只面向 win/linux 正式包。
   - 构建：macOS 安装包只能由 mac runner 产出（dmg 打包工具与 ad-hoc 签名都依赖 macOS），
     见 .github/workflows/release.yml 的 build 矩阵（x64 用 macos-13 runner、arm64 用 macos-14 runner）。

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

- zh-CN：macOS 暂不支持自动更新：从 GitHub Releases 下载未签名安装包（首次打开需允许 Gatekeeper）。
- en-US：Auto-update isn't available on macOS: download the unsigned installer from GitHub
  Releases (allow Gatekeeper on first launch).

## 5. 测试

两层，都进 CI（packages/desktop 已在 scripts/run-tests.mjs 的 TEST_PACKAGES 里）：

1. autoUpdateDarwinAvailability.test.ts（纯判定矩阵）：
   darwin+packaged+无 feed → true；darwin+packaged+feed → false；darwin+dev → false；
   win/linux+packaged → false；feed 为空白串按未配置处理。
   同时断言 { kind: "unsupported-platform" } 满足 UpdateCheckResultPayload，
   两个 locale 文件都有 update.toast.unsupportedPlatform 键且非空，
   且文案含「GitHub Releases」与「Gatekeeper」（护栏见该文件最后一个测试）。
2. autoUpdaterDarwinSkip.test.ts（ electron 桩集成）：用 node:module register 的 resolve 钩子
   把 electron / electron-updater重定向到测试桩，真实加载 autoUpdater.ts：
   - darwin+packaged：initAutoUpdater 后 checkForUpdates 调用数为 0，无 ipc handle 注册，
     checkForUpdateMenuClick 发回 { kind: "unsupported-platform" }；
   - linux+packaged：initAutoUpdater 后 checkForUpdates 调用数为 1（启动检查照常）；
   - darwin+packaged+feed 覆盖：判定不跳过，init 继续走完（setFeedURL 被调，provider 切 manifest）；
   - darwin+dev（未打包 + ZCODE_AUTO_UPDATE_DEV）：判定不跳过，启动检查照常。
3. scripts/test/releaseWorkflowMacMatrix.test.mjs（发布矩阵形状护栏，沿用 scripts/test/ 的既有
   workflow 护栏约定）：从 release.yml 现读矩阵与上传清单，断言 mac 条目恰好覆盖 darwin x64 +
   arm64（macos-13→x64、macos-14→arm64）且上传清单含 \*.dmg / \*.zip —— 少一行矩阵 = 该架构
   的 macOS 包静默失去发布入口（upload 步骤 if-no-files-found: warn，缺产物不红）。故意不断言
   publisher 顺序 / latest-mac.yml 覆盖：那是 electron-builder 的偶发行为，不是本项目的契约（见 §7）。

未验证项见 §7：未在真实 macOS 客户端验证，行为由上述测试钉住。

## 6. 文档同步

- docs/operations/release.md：发布维护者视角的平台支持与更新渠道表需与 3.14.4-ce.2 的发布事实一致
  （发布未签名 macOS dmg/zip、ad-hoc 签名、不公证、客户端不检查更新）。release.md 由发布维护者
  维护，其 macOS 条目以本文档 §1 产品规则为准。
- README.md：安装表 macOS 行发布未签名 .dmg/.zip 与 Gatekeeper 步骤（右键打开 / xattr 命令）；
  已知限制 macOS 条目保持「无自动更新」并说明新版本从 GitHub Releases 手动获取。
- .github/workflows/release.yml：build 矩阵新增 macos-13（darwin x64）与 macos-14（darwin arm64），
  复用既有 windows job 的结构；产物名 ZCode-CE-<版本>-darwin-<arch>.dmg/.zip。
- docs/development/backlog.md：issue #2 症状二一条状态更新为已完成（spec 136）。

## 7. 诚实边界（未验证项）

- 未验证最终产物：本机无 macOS，.dmg/.zip 的生成、ad-hoc 签名（`identity: "-"` 路径）与
  「装得上、打得开」只能由 ce.2 发版时的 CI mac job 验证。electron-builder 26.8.1 在非 macOS
  宿主上会跳过整个 macOS 签名步骤（macPackager.sign → isSignAllowed 仅在 darwin 上放行），
  故 ad-hoc 路径无法在本机复现。
- 未在真实 macOS 客户端验证 darwin 跳过行为：行为靠 §5 两层测试钉住；真实机器上可验证点为：
  帮助菜单点「检查更新」看到确定性提示 toast，且日志目录里无更新请求 error。
- darwin arm64/x64 未分别验证：判定只看 platform，不看 arch。
- latest-mac.yml 由 mac job 的 electron-builder publisher 上传，两个 arch 的 yml 顺序覆盖
  （后跑的 job 覆盖先跑的）。CE darwin 客户端整体跳过更新检查，不受影响（消费侧由 §5 第 2 项
  的「checkForUpdates 调用数为 0」断言钉住）；发布矩阵形状由 §5 第 3 项护栏守着，而 yml 覆盖
  关系本身不设护栏 —— 它是 publisher 的行为不是契约，只有自建 feed 或未来启用 macOS 自动更新时
  才需要按 arch 拆分 yml。
- 自托管 feed 在 darwin 上的端到端升级未验证（无自建 manifest 服务），仅钉住「不被本发行线禁用」。
