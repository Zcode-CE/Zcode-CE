# 数据与配置

> 状态：草稿 · 待补充备份与迁移细节

## 数据目录

| 路径                        | 内容                                                      | 是否随产品身份变化                               |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `~/.zcode/v2/`              | **全部业务数据**：会话、凭据、任务索引、`deviceMid`、设置 | **否**（路径硬编码 `.zcode`，见下）              |
| `~/.config/ZCode/`（Linux） | Electron 运行时状态：`session/`、`SingletonLock`、缓存    | **否**（由 `runtimeApplicationName` 决定，见下） |

### 业务数据目录：硬编码，不随身份变化

业务数据的路径由 `packages/services/src/paths.ts` 的 `getAppConfigDir()` 决定，返回 `{homedir}/.zcode/v2`。该路径**硬编码 `.zcode`**，与 `appId`、`productName`、包名均无关。

因此，社区版使用 `ZCode-CE` 作为产品身份**不会改变业务数据路径，也不会导致数据丢失**，无需任何迁移。

### Electron 运行时目录：由运行时应用名决定，不由 `productName` 决定

Electron 的 `userData` 目录**不是**直接取打包配置里的 `productName`，而是由 main 进程启动时显式设置的运行时应用名决定：

```
packages/desktop/src/main/desktopRuntimeEnv.ts
  runtimeApplicationName = ZCODE_DESKTOP_APPLICATION_NAME ?? (开发态 "ZCode Dev" / Preview "ZCode Preview" / 正式 "ZCode")
  runtimeUserDataPath    = ZCODE_DESKTOP_USER_DATA_DIR ?? join(app.getPath("appData"), runtimeApplicationName)

packages/desktop/src/main/index.ts
  app.setName(runtimeApplicationName)
  app.setPath("userData", runtimeUserDataPath)
```

这是一个**独立于打包身份的字符串**，当前取值为：

| 运行态          | `runtimeApplicationName` | Electron `userData`          |
| --------------- | ------------------------ | ---------------------------- |
| 正式（打包）    | `ZCode-CE`               | `~/.config/ZCode-CE`         |
| Preview（打包） | `ZCode-CE Preview`       | `~/.config/ZCode-CE Preview` |
| 开发（未打包）  | `ZCode Dev`              | `~/.config/ZCode Dev`        |

也可用 `ZCODE_DESKTOP_APPLICATION_NAME` 环境变量显式覆盖。

**为什么要用 `ZCode-CE` 而不是 `ZCode`**：

1. **并存安装**：Electron 用应用名做 `requestSingleInstanceLock` 的身份。若与官方版同名，先启动的那个会拦下另一个，两者无法同时运行。
2. **数据安全**：`userData` 里只有 Electron 运行时状态（`session/`、`SingletonLock`、缓存），**业务数据在 `~/.zcode/v2`**（硬编码，见上），所以改应用名**不会丢用户数据**。

> 修改 `desktop-product-identity.mjs` 的 `productName` / `appId` **不会**自动改变 `~/.config/<name>` 的取值 —— 那由 `desktopRuntimeEnv.ts` 的 `runtimeApplicationName` 单独决定。两者需要一起改。

（待补充：建议备份 `~/.zcode/v2/` 的哪些内容，以及 `tasks-index.sqlite` 的 WAL 注意事项。）
