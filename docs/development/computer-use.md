# Computer Use（开源实现）

ZCode 的 Computer Use 由 MIT 许可的开源驱动 [`@trycua/cua-driver`](https://www.npmjs.com/package/@trycua/cua-driver)
提供，上游是 [trycua/cua](https://github.com/trycua/cua)。它让模型通过 `node_repl` 里的
JavaScript 观察和操作本机桌面。

> 本文面向使用与二次开发的开发者。模块内部设计与实测记录见源码注释。

## 支持的平台

驱动以预编译二进制分发，六个目标三元组：

| 平台    | 三元组                               |
| ------- | ------------------------------------ |
| macOS   | `darwin-x64`、`darwin-arm64`         |
| Linux   | `linux-x64-gnu`、`linux-arm64-gnu`   |
| Windows | `win32-x64-msvc`、`win32-arm64-msvc` |

Linux 使用 glibc 变体；musl 发行版没有预编译产物。

## 启用条件

Computer Use 只在 **node_repl 被作为 Computer Use 宿主拉起**时可用。宿主通过
`ZCODE_CUA_NODE_REPL_HOST=1` 标识（取值严格等于 `"1"`，与
`plugin-host-command.ts` 一致）。没有该标识时运行时不会被创建 —— 普通 MCP 客户端、
CI 与测试因此不会拉起原生驱动。

桌面端与共享宿主会话会自动注入该标识；无需手工配置。

## 模型可见面

模型侧只看到 14 个 capability method，按 Codex 的 `cua` 形状定义（去掉 browser 半边）。
入口是 `agent.computerUse`，绑定式 API 为 `getApp` / `getAXState` / `click` 等；
低层工具面在 `agent.computerUse.computer` 下。

### 已实现

`list_apps`、`list_windows`、`get_app_state`、`left_click`、`left_click_drag`、
`type`、`scroll`、`set_value`、`key`、`request_access`、`stop_computer_control`

### 不实现

开源驱动没有下列能力的等价原语，调用返回 `ACTION_UNAVAILABLE`（不可重试）：

| method           | 原因                                               |
| ---------------- | -------------------------------------------------- |
| `select_text`    | 驱动没有按内容选区的原语                           |
| `perform_action` | 驱动没有通用的「调用元素动作」工具                 |
| `paste`          | 驱动没有剪贴板粘贴原语；改用 `type` 或 `set_value` |

模型收到 `ACTION_UNAVAILABLE` 时应改走元素索引或键盘路径，不要重试同一调用。

## 安全语义

这三条是硬约束，改动适配层时必须保留：

**后台投递优先，拒绝不等于可以改用前台重投。**
默认走后台投递（不激活目标窗口、不抢用户焦点）。当环境不支持免焦点输入
（典型是 Wayland 合成器），驱动返回 `background_unavailable`，适配层把它映射成
`FOREGROUND_REQUIRED` 交给模型 —— **不会**自动改成前台重投。模型应改用元素索引
或键盘路径。

**动作下发成功不等于结果达成。**
驱动的动作收据（`delivery` / `effect` / `route`）原样回传，由模型从**新的观察**
确认结果。适配层不做成功判定。

**取消后已完成的输入不会回滚。**
`actionSent` 只在收据明确说下发过时才为 true，并带 `possibly_sent`。
此时重试前必须先观察当前状态。

另外 `stop_computer_control` 是**按会话**生效的 kill switch：本会话后续调用一律被拒
（`CONTROLLER_BUSY`），其他会话不受影响。会话结束（`closeSession`）后解除。

## 环境变量

| 变量                           | 归属  | 说明                                             |
| ------------------------------ | ----- | ------------------------------------------------ |
| `ZCODE_CUA_NODE_REPL_HOST`     | ZCode | 由宿主注入；`"1"` 表示本进程是 Computer Use 宿主 |
| `CUA_DRIVER_RS_ENABLE_WAYLAND` | 驱动  | 启用驱动的原生 Wayland 后端                      |

`CUA_DRIVER_RS_ENABLE_WAYLAND` **不是 ZCode 的配置项**，是驱动自己的开关。
上游把原生 Wayland 后端标为 experimental 并默认关闭；关闭时 `list_windows` 恒返回 0 行，
Computer Use 直接不可用。适配层在检测到 Wayland 会话且该变量未设置时自动开启，
已有显式设置时保持用户/上游的选择。

## 平台注意事项

### Linux / Wayland

- 需要开启驱动的 Wayland 后端（见上），否则枚举不到窗口。
- **按窗口截图不可用**：Wayland 合成器无法证明像素属于某个窗口，驱动返回
  `surface_identity_unproven`。可访问性树路径不受影响，元素索引动作正常工作。
  适配层会把失败原因作为 `[screenshot unavailable: …]` 文本块回传。
- 免焦点输入取决于合成器是否提供 libei/xdg-desktop-portal 后端。缺失时输入类动作
  返回 `FOREGROUND_REQUIRED`（见「安全语义」）。

### Linux / X11

X11 会话下窗口枚举与输入注入走 XTEST/XSendEvent，不需要 Wayland 开关。

### macOS

首次使用需要在系统设置里授予辅助功能与屏幕录制权限；
`request_access` 返回这两项的状态。

### Windows

使用 `win32-*-msvc` 预编译产物。

## 打包

驱动是**原生模块**，esbuild 无法 bundle（uniffi 的 `.node` 依赖是运行时解析的）。
打包链路把驱动及其依赖按目标平台 stage 到
`resources/glm/packages/node-repl-host/node_modules/`，并在出包前做机械校验。

需要的包：`@trycua/cua-driver`、对应平台的 `@trycua/cua-driver-*` 原生包、
`@ubjs/core`、`@ubjs/node` 及对应平台的 `@ubjs/node-*`。
只 stage 目标平台 —— 驱动与 `@ubjs` 的平台包都是 optionalDependencies 全集，
全拷会把六个平台的二进制一起打进安装包。

### 为什么不能放在 `glm/node_modules`

electron-builder 对**源根直属**的 node_modules 有硬编码丢弃
（`app-builder-lib/out/util/filter.js` 的 `if (relative === "node_modules") return false`），
判定发生在 filter 之前，`walk` 不会下钻 —— 写任何 filter 都无效。
放进 `node-repl-host` 子目录既绕开该规则，又正好落在 bundle 的祖先解析链上。

### 体积

Linux x64 的原生部分约 42 MiB（未压缩），进安装包后被压缩。实测增量：

| 产物     | 增量               |
| -------- | ------------------ |
| AppImage | +13.3 MiB（+7.5%） |
| deb      | +9.4 MiB（+7.1%）  |

## 许可

| 包                              | 许可            |
| ------------------------------- | --------------- |
| `@trycua/cua-driver`            | MIT             |
| `@trycua/cua-driver-<platform>` | MIT AND MPL-2.0 |
| `@ubjs/core`、`@ubjs/node`      | MPL-2.0         |

MPL-2.0 是弱 copyleft：允许链接与分发，未修改时只需保留许可声明。
在本项目的驱动包中，MPL-2.0 覆盖的是 N-API 运行时垫片 `cua_driver_node_runtime.node`
（派生自 `uniffi-bindgen-react-native`），Rust SDK 本体是 `libcua_driver_sdk.so`。
许可声明见仓库根目录 `THIRD-PARTY-NOTICES.md`。
