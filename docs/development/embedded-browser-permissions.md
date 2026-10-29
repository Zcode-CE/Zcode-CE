# 150 内置浏览器权限治理(F9 + X4)

> 移植自上游 `zai-org/ZCode` v3.15.1(`aac47556`,Apache-2.0):spec 原文 `docs/browser-use/2026-10-08-embedded-browser-permission-governance-spec.md` 与五个 `embeddedBrowser*` main 模块 + `desktopBrowserDataIpc.ts` 增量。
> 搬运文件(需加 `Modified by ZCode:` 标记):embeddedBrowserPermissionPolicy.ts(398)、embeddedBrowserSitePermissions.ts(92)、embeddedBrowserSitePermissionStore.ts(52)、embeddedBrowserPermissionUiBridge.ts(282)、embeddedBrowserDeviceOptions.ts(30)、embeddedBrowserBluetoothGuard.ts(107),及 desktopBrowserDataIpc.ts / desktopWindowChrome.ts / index.ts 的接线增量。
> X4(权限默认放行的安全隐患)与 F9 是同一治理的两个公告条目,一并在此实现。

## 背景与现状(2026-10-13 实测)

- CE 内置浏览器为 Electron `<webview>`,session 为持久分区 `persist:zcode-embedded-browser`(`packages/desktop/src/main/browserDataManager.ts:30` 的 `EMBEDDED_BROWSER_PARTITION`)。
- 该 partition **未注册任何** `setPermissionRequestHandler` / `setPermissionCheckHandler` / `setDevicePermissionHandler`;Electron 默认自动批准全部权限请求,恶意页面可静默拿到摄像头/麦克风/剪贴板读取/地理位置。
- 设备类(WebHID/WebUSB/WebSerial/蓝牙)在未监听 `select-*` 时 Electron 静默授权第一个匹配设备;屏幕共享在未注册 `setDisplayMediaRequestHandler` 时请求直接失败。
- `desktopWindowChrome.ts` 的 `will-attach-webview` 只做进程隔离(sandbox / contextIsolation / 协议白名单 / 开窗路由),不做能力闸门。

## 目标

- partition 所有权限请求默认不自动放行:无害白名单静默放行,敏感能力经产品级弹窗由用户决策,其余 fail-closed。
- 三类弹窗:确认气泡(四态:访问此网站时允许 / 仅本次允许 / 不允许 / ✕ 与 20s 超时)、屏幕共享源选择器、设备选择器。
- 持久站点同意记录(`userData/embedded-browser-site-permissions.json`,原子写)+ 「网站权限」设置入口(UI 属 ui-features-port)。
- 每条决策输出审计日志(`[embedded-browser-permission] decision=granted|denied origin=… permission=… source=…`,info 级低频)。
- 复用 CE 既有 webview 布线:`agent browser-use`(CDP 截图、虚拟剪贴板)零影响。

## 权限分级表(照搬上游)

| 级别              | 权限                                                                                                                                                                                         | 记忆策略       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 静默放行          | clipboard-sanitized-write、fullscreen、pointerLock、mediaKeySystem                                                                                                                           | 无             |
| 弹窗 A 确认气泡   | media、clipboard-read、geolocation、notifications、midi、midiSysex、idle-detection、speaker-selection、window-management、storage-access、top-level-storage-access、keyboardLock、fileSystem | 四态           |
| 弹窗 B 源选择器   | display-capture                                                                                                                                                                              | 每次询问不记住 |
| 弹窗 C 设备选择器 | hid / usb / serial / 蓝牙                                                                                                                                                                    | 每次询问不记住 |
| 显式拒绝          | openExternal(已有独立开窗路由)、unknown、deprecated-sync-clipboard-read 等                                                                                                                   | —              |

未在上表的 permission 字符串一律显式拒绝 + warn(fail-closed,防 Electron 新增枚举绕过白名单)。

## 架构与状态所有者

```
guest 页面发起请求
  ├─ permission request ──► EmbeddedBrowserPermissionPolicy.setPermissionRequestHandler
  │     ① 白名单 → 放行;② 持久记录/sessionAllow → 按记录;③ 无记录 → UiBridge 弹窗 A
  ├─ getDisplayMedia ──► setDisplayMediaRequestHandler → UiBridge 源选择器(desktopCapturer)
  ├─ requestDevice(hid/usb/serial) ──► session.on("select-*") → UiBridge 设备选择器
  ├─ requestDevice(蓝牙) ──► guest webContents.on("select-bluetooth-device") → UiBridge 设备选择器
  └─ permission check ──► setPermissionCheckHandler(同步读内存记录,与 request 口径一致)
```

- **唯一所有者**:`embeddedBrowserSitePermissions.ts` 的模块级单例管理站点同意记录(内存为同步读来源,store 异步落盘)。设置页「网站权限」与「清除浏览器数据」经同一模块读写。
- **弹窗桥所有者**:`embeddedBrowserPermissionUiBridge.ts` 的模块级 `activeBridge`(`setActiveEmbeddedBrowserPermissionUiBridge`),index.ts 启动时装配一次,windowChrome 直接取用,避免多层 options 透传。
- **超时**:20s 无响应按 dismiss/cancel 结算(面板不可见或 agent 后台场景自然拒绝)。
- **inflight 去重**:同 origin+permission 并发请求共享一个弹窗(与 pluginSandbox permissionGate 同款模式)。
- 设备选择器:同权限全局只开一个;select-\* 连续 fire(蓝牙/USB 渐进枚举)只热更新列表;必须 `event.preventDefault()` 否则 Chromium 立即以未选择取消。

## 接口(对 shared 的依赖,task-1 提供)

- `PlatformChannels`:EmbeddedBrowserPermissionPrompt、EmbeddedBrowserPermissionResolve、GetEmbeddedBrowserSitePermissions、SetEmbeddedBrowserSitePermission、ClearEmbeddedBrowserSitePermissions、ResetEmbeddedBrowserSitePermission。
- 类型(`@zcode/shared`):`EmbeddedBrowserPermissionDeviceOption`、`EmbeddedBrowserPermissionPromptEvent`、`EmbeddedBrowserPermissionResolveRequest`、`EmbeddedBrowserSitePermissionUpdateRequest`。
- main 内部接口全部自持(policy/store/logger/prompt/devicePicker/onDisplayMediaRequest 注入),无需新增 CE 协议。

## 接线点(CE)

1. `index.ts` app ready 后、`applyDesktopChromiumNetworkPolicies` 之后、任何 guest attach 之前:创建 bridge(`createEmbeddedBrowserPermissionUiBridge({ logger })`)+ `registerResolveListener()` + `setActiveEmbeddedBrowserPermissionUiBridge`,再 `applyEmbeddedBrowserPermissionPolicy(session.fromPartition(EMBEDDED_BROWSER_PARTITION), { logger, prompt, devicePicker, onDisplayMediaRequest, store: createEmbeddedBrowserSitePermissionStore(join(app.getPath("userData"), "embedded-browser-site-permissions.json")) })`;bootstrap 失败只 warn,不阻断启动(与上游一致)。
2. `desktopWindowChrome.ts`:`did-attach-webview` 的 browser guest 分支安装 `installEmbeddedBrowserBluetoothGuard(guest, logger.warn, { devicePicker: getEmbeddedBrowserDevicePicker(), hostWebContentsId })`(蓝牙事件挂在 guest WebContents 而非 Session)。
3. `desktopBrowserDataIpc.ts`:新增 4 个 IPC handler(Get/Set/Clear/ResetEmbeddedBrowserSitePermission),设置页唯一数据源;保留对 `clearEmbeddedBrowserData` 的既有接线(site permission 清理由设置页「清空数据」调用 `clearEmbeddedBrowserSitePermissions` 联动)。

## 与上游的差异(CE 改写点)

- 上游 spec 提到的「设置页不再提供网站权限区块」属 UI 侧(ui-features-port);main 侧行为与上游一致。
- CE 无 rewards/codingPlan 等上游 guest 类型,windowChrome 的接线只取 browser guest 分支。
- 其余逐字节搬运,仅删减对 CE 不存在模块的引用(无)。

## 验收场景

- 任意网页无用户确认无法获得摄像头/麦克风/剪贴板读取/地理位置/通知/MIDI/设备/屏幕共享。
- 白名单不产生功能故障:网页复制按钮、全屏、DRM 播放正常。
- agent browser-use 回归(CDP 截图、虚拟剪贴板粘贴、tab 生命周期)不受影响。
- 决策表全枚举单测:白名单 / 持久记录命中 / 无记录无弹窗时拒绝 / 未知权限 fail-closed;check 与 request 一致性;原子写;sessionAllow 生命周期;inflight 去重;20s 超时;select-\* 与 displayMedia 的拒绝回调。

## 测试要求

- 新增单测:决策表枚举、store 读写与原子写、bridge 超时与 resolve 校验(`parseEmbeddedBrowserPermissionResolveRequest` 拒绝畸形 payload)、蓝牙守卫取消语义、deviceOptions 映射。
- desktop 既有测试回归:browserDataManager、desktopWindowChrome 的 webview attach。
- e2e(如 CE 有 desktop e2e 框架)按上游 spec 的确认气泡三按钮 + ✕ + 重启持久化补齐;CI 容器无摄像头设备时以负向断言(未选择设备不静默授权)为主。

## 实施顺序(可分步提交)

1. main 策略模块 + 全部 handler + select-\*/displayMedia 监听(弹窗未注入时敏感项一律拒绝 + 日志——安全闭环,可单独堵漏)。
2. 弹窗桥 + IPC(含站点权限 4 个 handler)。
3. windowChrome 蓝牙守卫接线 + 单测。
