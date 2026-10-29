# 152 插件 UI 沙箱(plugin-sandbox)桌面纵向(F5,host/renderer/preload)

> 移植自上游 zai-org/ZCode v3.15.1(aac47556,Apache-2.0)。F5 协议契约(@zcode/shared/mcp-apps、@zcode/shared/gen-ui、bootstrap zcode-protocol/mcp-ui)属 task-1;packages/ui 界面属 ui-features-port;**本文档覆盖桌面进程纵向剩下的全部代码**:main host、renderer 受信 shell、preload 桥。
> 上游 CONTRACT.md(packages/desktop/src/main/pluginSandbox/CONTRACT.md)是本模块的权威契约,随代码照搬登记。

## 范围与搬运清单(逐字节搬运 + Modified by ZCode: 标记)

main(packages/desktop/src/main/pluginSandbox/,~1950 行实现 + 440 行测试):

- contract.ts(82)、csp.ts(115)、capture.ts(43)、genUiVendor.ts(51)、permissions.ts(132)、permissionGate.ts(143)、session.ts(143)、registry.ts(227)、protocol.ts(291)、guestPolicy.ts(215)、host.ts(307)、index.ts(16)、module.ts(11)
- 测试:capture.test.ts、clearOrder.test.ts、contract.test.ts、genUiProtocol.test.ts、genUiVendor.test.ts、hostLifecycle.test.ts;CONTRACT.md、contract.example.ts

renderer(packages/desktop/src/renderer/src/plugin-sandbox/):

- plugin-sandbox.html(38)、main.ts(79,shell DOM 接线)、relay.ts(144,纯转发 + iframe sandbox=allow-scripts allow-same-origin allow-forms + allow 白名单四 token)
- alias.ts(52)、aliasApi.ts(91)、aliasRuntime.ts(310,懒连接 + foreignApp 防撞请求 id)、openaiAlias.ts(61)、desktopPluginSandboxPlatform.ts(62)
- genUi.ts(206)、genUiTweakRuntime.d.ts(9) + genUiTweakRuntime.js(490,vendored 上游 JS,逐字节搬运 + 许可登记)、genUiTweakRuntime.test.ts(113)

preload(packages/desktop/src/preload/pluginSandbox/,Lead 已裁定归我):

- index.ts(35,guest preload:把 main 的 MessagePort 经 window.postMessage 转交 shell——contextBridge 会把 MessagePort 包成 Proxy 丢失原生方法)
- hostBridge.ts(45,contextBridge 暴露 zcodePluginSandbox 命名空间)
- retainedMoves.ts(28,主世界钩子:Electron 注册 webview 前给 webview 原型补 connectedMoveCallback;带 data-zcode-retained-sandbox 标记的实例跳过断开/重连)+ retainedMoves.test.ts

接线增量:

- index.ts:privileged scheme 注册(registerLocalMediaPreviewScheme(protocol, [PLUGIN_SANDBOX_PRIVILEGED_SCHEME])——需扩展 CE 该函数签名,目前只接受 protocol)、installPluginSandboxHost({ preloadPath, rendererDir, aliasDir, devServerUrl?, logger, registryMaxEntries? })、registerPlatformIpcHandlers.registerPluginSandbox、构建资源目录(out/plugin-sandbox 的 alias.js / vendor/manifest.json / gen-ui 资产)
- desktopWindowChrome.ts:will-attach-webview 的 pluginSandbox 分支(configureGuest)与 did-attach-webview 的 attachGuest 分派(pendingWebviewGuestKinds 队列)

## 依赖(Lead 已批准归属)

- npm:packages/desktop/package.json(归我)加 @modelcontextprotocol/client、@modelcontextprotocol/core、@modelcontextprotocol/ext-apps @2.0.0;packages/shared/package.json 加 @modelcontextprotocol/ext-apps(core-services-port)。CE 全仓此前 0 命中。lockfile 由 release-integrator 收口核对。
- 构建:packages/desktop/vite.config.ts(归我)增 plugin-sandbox renderer 入口(上游 244 行);alias 脚本独立输出到 out/plugin-sandbox(避免 vite emptyOutDir 清掉)。

## shared 符号依赖清单(给 core-services-port 对照)

- PlatformChannels:PluginSandboxDispose、PluginSandboxCopyImage、PluginSandboxConsumeUserGesture、PluginSandboxOwnerWebContentsId
- PluginSandboxChannels(含 Init)/ InternalChannels.PluginSandboxPorts
- HostIPC:PluginSandboxRegisterRequest / PluginSandboxRegisterResult(payload:PluginSandboxRegisterRequestPayload / PluginSandboxRegisterResultPayload)
- @zcode/shared/mcp-apps 导出:PluginSandboxHandle、PluginSandboxRegisterInput、PluginSandboxPlatformPort、PluginSandboxTransportPort、PluginSandboxPortsEvent、PluginSandboxCaptureRequest、McpAppsResourcePermission、McpAppCspRelaxations、McpToolUiCsp、McpAppsDownloadFileItem、normalizeCspOrigin、buildMcpAppsIframeAllow
- @zcode/shared/gen-ui 导出:GEN*UI*_ 常量/方法名 + genUiWidgetStateSchema、genUiFollowUpSchema、genUiTweak_ schema、GenUiWidgetState 类型

## 架构(状态所有者与事件顺序)

```
Host 进程(可信)──registerPluginSandbox(已校验 HTML+CSP+归属)──> main registry
  register 幂等 key(owner+workspace+session+contentKind+pluginId+scopeId+serverName+instance.token)
  → handle{ sandboxId, initId, shellUrl(zcode-sandbox://shell-<appIdentity>/instance/<id>/), partition(persist:plugin-sandbox-v2-<sha256(appIdentity)>) }
  → preparePluginSandboxSession:装 protocol handler、webRequest.onBeforeRequest 归属校验、权限闸门、禁下载、proxy direct

windowChrome will-attach-webview ──isPluginSandboxSrc(src)──> configureGuest(三匹配:src=shellUrl / partition / owner;硬化 webPreferences)
windowChrome did-attach-webview  ──> attachGuest(pin、deny popup、导航白名单、console→main 日志、input-event 记手势、
                                          did-start-navigation 撤旧登记、dom-ready 建 MessageChannel:port2→宿主 renderer,port1→guest preload→shell)
shell(main.ts)            ──init 帧{ sandboxId, initId, allow }──> 建 iframe(plugin origin)──双向原样转发 JSON-RPC
插件 iframe               ──alias.js(window.zcode/openai 薄封装,懒连接)或 gen-ui runtime──> 宿主 AppBridge(packages/ui)
```

- 唯一所有者:main registry(模块级单例 getPluginSandboxHost,main 进程单实例无并发写竞争)。
- partition 按可信 App 身份派生(不接受页面自报来源);gen-ui 用内存分区 gen-ui-<appIdentity>。
- 容量上限 64(registryMaxEntries 可注入,e2e 用 1 验证配额拒绝);满且全是活实例抛 PluginSandboxQuotaError,不淘汰活实例。
- TTL 6h;guest pin 中(pinned>0)不参与过期;用户手势 token 5s 一次性(PLUGIN_SANDBOX_USER_GESTURE_TTL_MS)。
- 撤销:先关端口 → 导航 about:blank(等文档真正移除;Electron 41 的 guest.close 只销毁包装对象)→ close;IPC dispose 等同一个停止 Promise。
- 清除所有数据(clearBrowserData):先阻止新登记、disposeOwner、等所有 guest 停止(含已在 dispose 的),再 clearStorageData/clearCache,覆盖新旧 v1/v2 分区;停止失败不能报清理成功。
- CSP:default-src none;域类按资源声明派生;frame-ancestors 只允许该 shell origin;form-action none;'unsafe-inline' 放行(内联脚本普遍),'unsafe-eval'/'wasm-unsafe-eval' 按资源声明放宽。
- 权限:camera/microphone/geolocation 需确认(main 原生 dialog,父窗口为宿主窗口,页面无法伪造);clipboardWrite 按声明放行;同意记录内存(按 partition)本次运行有效;macOS 走 askForMediaAccess。
- gen-ui vendor:固定 CDN 脚本 URL(floating-ui/lucide/d3)映射到随包文件(vendor/manifest.json 精确匹配),缺失失败不回退网络。

## 与上游的差异(CE 改写点)

- CE 不引入上游 rewards 等 CE 不存在的 guest 分支;desktopWindowChrome.ts 的 pendingWebviewGuestKinds 队列只需 pluginSandbox + browser + codingPlan(CE 既有)三种。
- CE 无 ARMS 遥测,host.ts 不引入遥测接线。
- MIT 的 @modelcontextprotocol/ext-apps 是 npm 依赖,不是逐字节搬运;登记交 release-integrator 汇总。

## 验收场景

- 不可信插件 HTML 无法获得 Node、无法跨实例访问、未声明权限一律拒绝、未监听 select-\* 的静默授权路径不存在。
- 同凭证重复登记返回同一句柄(initId 不变);HTML 内容变化必须换 token,否则被拒绝。
- 宿主窗口关闭/崩溃 → 该 owner 名下登记全部释放,旧 MessagePort 失效。
- 页面自建官方 App 通信时别名不再握手(foreignApp 防撞请求 id)。
- 清除所有数据后分区存储与缓存确实清空。

## 测试要求

- 照搬上游 6 个 pluginSandbox 单测 + 3 个 renderer 单测(relay init/allow 过滤、aliasRuntime 懒连接、genUiTweakRuntime)。
- CE 增补:privileged scheme 注册两次不互相覆盖、windowChrome 非沙箱 src 不进沙箱分支。
- 真实 Electron 验证(单测无法覆盖 webview attach):dev:desktop 跑一次,登记沙箱后确认 MessagePort 握手、导航拦截、console 转发日志存在。

## 实施顺序(可分步提交)

1. 依赖 + 构建入口 + shared 符号就绪后,先搬运 main/pluginSandbox 全量 + 单测(不接线)。2. index.ts/windowChrome 接线 + privileged scheme。3. preload + renderer shell + alias。4. gen-ui 纵向 + vendored 资产。5. 真实 Electron 联调。
