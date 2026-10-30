# 插件 UI 沙箱（plugin-sandbox）

> 移植自上游 zai-org/ZCode v3.15.1（`aac47556`，Apache-2.0）。权威契约是随代码搬运的
> `packages/desktop/src/main/pluginSandbox/CONTRACT.md`；本文只记录 CE 的架构、边界与验证口径。

## 1. 范围

MCP App / UI 插件在独立沙箱中运行：main 进程持有登记与生命周期，renderer 提供 shell 与别名桥，
guest preload 把 MessagePort 转交给 shell；插件页面拿不到 Node、宿主 DOM 或其它实例的状态。

## 2. 状态所有者与事件顺序

```text
Host 进程（可信）──registerPluginSandbox(已校验 HTML+CSP+归属)──> main registry（模块级单例）
  register 幂等 key = owner + workspace + session + contentKind + pluginId + scopeId + serverName + token
  → handle { sandboxId, initId, shellUrl(zcode-sandbox://…), partition(persist:plugin-sandbox-v2-<sha256(appIdentity)>) }
  → 安装 protocol handler、webRequest 归属校验、权限闸门、禁下载、proxy direct

windowChrome will-attach-webview ──isPluginSandboxSrc(src)──> configureGuest（三匹配后硬化 webPreferences）
windowChrome did-attach-webview ──> attachGuest（pin、deny popup、导航白名单、console→main、input 手势、MessageChannel）
shell（renderer）──init 帧──> 建 iframe（插件 origin）──双向原样转发 JSON-RPC
插件 iframe ──alias.js / gen-ui runtime──> 宿主 AppBridge（packages/ui）
```

- **唯一所有者**：main 的 registry 单例；renderer/guest 都不持有可写登记。
- **分区**：按可信 App 身份派生，不接受页面自报来源；gen-ui 使用内存分区。
- **容量**：最多 64 个实例（测试可注入更小值）；满且全是活实例时抛配额错误，不淘汰活实例。
- **TTL / 手势**：实例 6h；guest pin 中不参与过期；用户手势 token 5s 且一次性。
- **撤销顺序**：先关端口 → 导航 `about:blank`（等文档真正卸载）→ close；不要假设 `guest.close`
  会清掉存储。IPC dispose 等同一个停止 Promise。
- **清除所有数据**：先阻止新登记、dispose owner、等所有 guest 停止，再清 storage/cache（覆盖新旧分区）；
  停止失败不能报清理成功。
- **CSP**：`default-src none`；域类按资源声明派生；`frame-ancestors` 只允许该 shell origin；
  `form-action none`；内联脚本放行，eval/wasm 按声明放宽。
- **权限**：camera/microphone/geolocation 需 main 原生确认（父窗口为宿主窗口，页面无法伪造）；
  clipboardWrite 按声明放行；同意记录内存内、按 partition 本次运行有效；macOS 走系统授权。
- **gen-ui vendor**：固定 CDN 脚本映射到随包 `vendor/manifest.json`（精确匹配），缺失直接失败，不回退网络。

## 3. 与上游的差异

- 不引入上游 rewards 等 CE 不存在的 guest 分支；`pendingWebviewGuestKinds` 只处理 pluginSandbox / browser / codingPlan。
- 无 ARMS 遥测，host 不引入遥测接线。
- `@modelcontextprotocol/ext-apps` 是 npm 依赖（MIT），不逐字节搬运；许可登记在 `third-party/copied-components.json`。

## 4. 验收与验证

- 不可信插件 HTML 无法获得 Node、无法跨实例访问；未声明权限一律拒绝；不存在未监听 `select-*` 的静默授权路径。
- 同凭证重复登记返回同一句柄（initId 不变）；HTML 内容变化必须换 token，否则拒绝。
- 宿主窗口关闭/崩溃 → 该 owner 名下登记全部释放，旧 MessagePort 失效。
- 页面自建官方 App 通信时别名不再握手（foreignApp 防撞请求 id）。
- 清除所有数据后分区存储与缓存确实清空。

自动化覆盖：main 的 6 个单测（capture / clearOrder / contract / genUiProtocol / genUiVendor / hostLifecycle）
与 renderer 的 relay/aliasRuntime/genUiTweakRuntime 单测；CE 额外验证 privileged scheme 重复注册与
非沙箱 src 不进沙箱分支。**真实 Electron 的 webview attach、MessagePort 握手、导航拦截与 console 转发
仍需 `pnpm dev:desktop` 人工过一遍**，单测覆盖不到。
