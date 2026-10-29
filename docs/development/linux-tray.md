# 151 Linux 关闭窗口驻留托盘(F10)

> 移植自上游 `zai-org/ZCode` v3.15.1(`aac47556`,Apache-2.0):新增 `desktopTraySupport.ts`(241 行)、上游 spec `docs/desktop/linux-close-to-tray.md`,及 `desktopTray.ts` / `desktopWindowLifecycle.ts` / `index.ts` 的接线增量。
> 搬运文件(加 `Modified by ZCode:` 标记):desktopTraySupport.ts(整文件);修改:desktopTray.ts(createWindowsDesktopTray → createDesktopTray + 平台参数 + Linux PNG 图标 + 菜单项 ClearAllData→ExportLogs)、desktopWindowLifecycle.ts(closeToTrayOnWindows → closeToTray + closeToTraySupported 合并裁决)、index.ts(tray 创建/能力查询/设置迁移接线)。

## 背景与现状(2026-10-13 实测)

- CE 已有 Windows 版驻留:`closeToTrayOnWindows` 设置(shared protocol.ts:287 / validationAppSettings.ts:275/522),默认开;`desktopTray.ts` 的 `createWindowsDesktopTray` 仅 win32;`desktopWindowLifecycle.ts:385` 的隐藏分支条件为 `platform === "win32" && closeToTrayOnWindows`。
- Linux 现状:关窗即走「确认退出 → app.quit()」。
- 共享只读产物已确认上游 3.15.1 把能力扩展到 Linux,key 保留 `closeToTrayOnWindows`(存量兼容),新增 `closeToTrayLinuxMigrationInitialized`(schema default false)。

## 目标

- Linux 对齐 Windows 托盘模式:设置开 + 托盘可用时关窗隐藏驻留;托盘不可用时置灰锁定为关,降级到现有确认退出路径(永不失联)。
- macOS 不变(系统 Dock 模型)。

## 行为矩阵(照搬上游)

| 平台/环境          | 设置开关         | 默认值 | 关窗行为           | 托盘               |
| ------------------ | ---------------- | ------ | ------------------ | ------------------ |
| Windows            | 可操作(现状)     | 开     | 隐藏驻留           | 常驻               |
| Linux + 托盘可用   | 可操作           | **关** | 用户开启后隐藏驻留 | 能力检测通过后创建 |
| Linux + 托盘不可用 | **置灰锁定为关** | —      | 现有确认退出路径   | 不创建             |
| macOS              | 不显示           | —      | 系统默认           | 无                 |

## 能力检测(零新增依赖)

- 信号:session DBus 上 `org.kde.StatusNotifierWatcher` 是否有 owner。依次尝试 gdbus → busctl → qdbus(各自输出格式解析:`(true,)` / `b true` / `true`);任一明确结果即返回,工具缺失/超时(1.5s)按不可用(安全默认)。
- `XDG_CURRENT_DESKTOP` 含 gnome(不区分大小写)→ `gnomeLikeWithoutTray`,仅用于设置页置灰文案追加「安装 AppIndicator 扩展」提示;不维护桌面环境硬编码名单。
- **缓存 monitor**(`createCloseToTrayCapabilityMonitor`):关窗分支是同步回调不能 await;getSync 返回缓存(启动后首次探测未完成返回 null,按不可用),refresh 在 stale(10s)后重探。刷新时机:app ready 首次、设置页 IPC 查询。不做周期轮询。
- **CR-01 合并裁决**(`resolveCloseToTraySupported`):win32 = trayReady;linux = trayReady ∧ 能力探测通过;其它不可隐藏。DBus watcher 存在只证明桌面可能有 host,`new Tray()` 仍可能因图标缺失/会话未就绪抛错(静默失败),隐藏前必须验证最终用户入口真实存在。关窗分支与设置页能力查询都读同一合并结果。

## 托盘创建

- Windows:app ready 后创建,`desktopTrayReady` 由创建结果置位。
- Linux:`ensureLinuxDesktopTray()`:能力探测通过后才创建(避免注册无人渲染的 DBus name);设置页查询时若能力可用而托盘未建则补建。托盘创建跟随能力而非设置开关(与 Windows 语义一致:设置只控制关窗是否驻留)。
- Linux 图标只用 PNG(dev `build/icon.png`;打包态 `resources/icon.png`,extraResources 已无条件打包);Windows 继续用 `tray_icon.ico`。
- 托盘右键菜单:上游把 `helpClearAllData` 换成 `helpExportLogs`(避免右键菜单暴露清空全部数据,复用应用菜单导出命令)——一并搬运。

## 关窗路径

`desktopWindowLifecycle.ts` 隐藏分支泛化为:`(win32 或 (linux 且 closeToTraySupported)) && closeToTray && !forceQuit && !explicitQuitRequested` → `win.hide()`;`window-all-closed` 无需改动(hide 不销毁窗口)。

## 设置项与迁移(shared 字段依赖 task-1)

- 保留 `closeToTrayOnWindows` key 与 schema;内部命名改语义中性的 `closeToTray`。
- 新增 `closeToTrayLinuxMigrationInitialized`(default false):Linux 首次启动(`!initialized`)强制归位 false 并写 initialized=true;持久化**必须 await** 完成(在窗口/renderer 读设置之前);写入失败(CR-02,`resolveCloseToTrayRuntimeValue`)内存值回退为文件当前值,维持「文件是唯一可信来源」,下次启动重试。
- 能力查询 IPC(`GetCloseToTrayCapability`)返回 `{ supported, gnomeLikeWithoutTray }`;preload bridge 与 SettingsPage UI 属 ui-features-port,本文档只定义 main 侧 DTO。

## 接线点(CE index.ts)

- 顶部:`createCloseToTrayCapabilityMonitor({ platform, env })`(模块级)。
- bootstrap 读设置后:Linux 迁移(`resolveCloseToTrayBootstrapValue` + 持久化 + `resolveCloseToTrayRuntimeValue`)。
- 托盘装配:win32 立即创建;linux 走 `ensureLinuxDesktopTray`(失败只 warn)。
- `registerPlatformIpcHandlers` 增 `refreshCloseToTrayCapability: () => monitor.refresh() → resolveCloseToTraySupported(...)`(供设置页查询)。
- 关窗 handler(`handleDesktopWindowCloseRequest`)取 `resolveCloseToTraySupported({ platform, desktopTrayReady, capabilitySupported: monitor.getSync()?.supported })`。

## 验收与测试

- 单测:detectDesktopCloseToTrayCapability(mock executor:gdbus/busctl/qdbus 输出解析、工具缺失、超时、非 Linux 直通)、parseStatusNotifierOwnerOutput、isGnomeLikeDesktop、resolveCloseToTraySupported(平台×trayReady×capability 矩阵)、resolveCloseToTrayBootstrapValue/RuntimeValue(未初始化/已初始化/非 Linux/持久化失败)。
- 关窗分支:在 desktopWindowLifecycle 既有单测增补 linux + supported/unsupported × 设置开/关 矩阵。
- monitor:缓存刷新、stale 语义、pending 合并。
- 真机验证项(CI 容器无桌面会话无法覆盖,KDE/XFCE 交互、GNOME 装扩展前后、AppImage/deb/rpm 四包格式)列待验证。

## 移植分类

A(直接搬运 + CE 接线适配)。shared 侧两处字段(protocol.ts / validationAppSettings.ts)由 task-1 落地,本 spec 依赖其完成。
