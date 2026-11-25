# 数据与配置

> 面向需要判断数据存放位置、升级或改名会不会丢数据、以及如何备份与恢复的部署方。
> **数据目录的布局、身份影响与备份恢复以本文为准**（`~/.zcode/v2` 与 Electron `userData` 两条路径，
> 含容器形态的落点）。其余文档提到数据目录时只作指路，不复述完整清单。

## 数据目录

| 路径                           | 内容                                                      | 是否随产品身份变化                               |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------------------ |
| `~/.zcode/v2/`                 | **全部业务数据**：会话、凭据、任务索引、`deviceMid`、设置 | **否**（路径硬编码 `.zcode`，见下）              |
| `~/.config/ZCode-CE/`（Linux） | Electron 运行时状态：`session/`、`SingletonLock`、缓存    | **是**（由 `runtimeApplicationName` 决定，见下） |

### 业务数据目录：硬编码，不随身份变化

业务数据的路径由 `packages/services/src/paths.ts` 的 `getAppConfigDir()` 决定，返回 `{homedir}/.zcode/v2`。该路径**硬编码 `.zcode`**，与 `appId`、`productName`、包名均无关。

因此，社区版使用 `ZCode-CE` 作为产品身份**不会改变业务数据路径，也不会导致数据丢失**，无需任何迁移。

> **这句"无需任何迁移"的准确范围**（别读成"我们提供迁移能力"）：它说的是**改产品身份不影响数据路径**。
> 本仓库**不提供**跨机器的导出/导入、服务端同步，也**不提供**跨版本迁移（数据库迁移是单向的）。
> 容器形态的备份/恢复配方与"备份不可移植到另一台机器"这个坑，见
> [Docker 文档的 §4](headless-server-docker.md)。

可用 `ZCODE_DATA_BASE_DIR` 环境变量或设置项替换数据根目录；优先级为
`setDataBaseDir()` > `ZCODE_DATA_BASE_DIR` > `homedir()`。

### Electron 运行时目录：由运行时应用名决定，不由 `productName` 决定

Electron 的 `userData` 目录**不是**直接取打包配置里的 `productName`，而是由 main 进程启动时显式设置的运行时应用名决定：

```
packages/desktop/src/main/desktopRuntimeEnv.ts
  runtimeApplicationName = ZCODE_DESKTOP_APPLICATION_NAME ?? (开发态 "ZCode Dev" / Preview "ZCode-CE Preview" / 正式 "ZCode-CE")
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

## `~/.zcode/v2/` 内容清单

| 路径                                           | 内容                                                                                      | 可重建 | 备份优先级     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ | -------------- |
| `credentials.json`                             | 账号凭据与 OAuth token（**权限 600**，值为 `enc:v2:` 密文；主密钥**不在本文件里**）       | 否     | **最高**       |
| `credential-secret`                            | 本机主密钥兜底（**权限 600**；只有系统凭据库不可用时才生成，43 字符）                     | 否     | **与凭据同批** |
| `credential-source`                            | 密钥来源标记（内容仅 `os`，不含密钥；删除它等于让该目录改用文件密钥）                     | 是     | 低             |
| `setting.json`                                 | 应用设置（含代理、镜像前缀、模型选择等）                                                  | 否     | **高**         |
| `tasks-index.sqlite`                           | 任务索引（会话列表、分组、置顶、闲时任务）                                                | 否     | **高**         |
| `config.json`                                  | Provider 配置（连接信息、模型映射）                                                       | 否     | **高**         |
| `model-providers.json`、`provider_config.json` | 模型供应商配置与凭据                                                                      | 否     | **高**         |
| `onboarding-record.json`                       | 引导记录（设备锚点 + 用户条目）                                                           | 否     | 中             |
| `telemetry-state.json`                         | **设备身份**（`deviceMid`）。文件名是历史命名，只承载设备身份                             | 否     | **高**         |
| `sessions/`                                    | 旧版任务快照（`{workspaceHash}/{taskId}.json`）。仅遗留路径仍在使用，新装机器上可能不存在 | 否     | 中             |
| `checkpoints/`                                 | 会话检查点与工具输出（体积最大，本机实测 78 MB）                                          | 是     | 低             |
| `logs/`                                        | main / host 日志，按日切分（本机实测 62 MB）                                              | 是     | 低             |
| `crash/`                                       | 崩溃本地归档（`live/` 暂存、`archive/` 归档）                                             | 是     | 低             |
| `runtime/`、`locks/`、`certs/`                 | 运行时状态、文件锁、自签 CA                                                               | 是     | 低             |
| `acp-auth/`、`acp-config/`                     | ACP 客户端认证与配置                                                                      | 否     | 中             |

`deviceMid` 的**文件名必须保持 `telemetry-state.json`**：CLI、Desktop、远端 server 三端共用同一
路径与字段，改名等于重置设备身份，`X-Device-Mid` 计费头随即丢失、权益领取失败。该文件由
`packages/services/src/device/deviceMid.ts` 用文件锁保护，**不要手工编辑**。

## 系统凭据库原生模块的随包边界

密钥由 `packages/shared/src/credential-security/nativeKeyring.ts` 惰性 import 的
`@napi-rs/keyring`（2.1.2，原生 NAPI）读写。它随哪些产物分发，决定了同一台机器上谁能解出
`enc:v2:os:` 密文：

| 产物                               | 原生模块                                                             |
| ---------------------------------- | -------------------------------------------------------------------- |
| 桌面安装包（main / Host）          | 主包在 `app.asar`，只有目标平台变体的 `.node` 在 `app.asar.unpacked` |
| 桌面内置 agent（`resources/glm`）  | 主包 + 目标平台变体，落 `resources/glm/node_modules/@napi-rs/`       |
| 无头分发包（npm `zcode-ce`、远端） | 不带（无 `node_modules` 落点）→ `stage=load`，只能靠显式配置的密钥   |

内置 agent 必须带同一份模块：Host 把目录绑定到系统凭据库后，agent 若加载不到它就只能报
`CREDENTIAL_SECURE_STORAGE_UNAVAILABLE`，不会回退到文件密钥。安装包里只保留目标平台变体
（prune 与 asarUnpack 规则见 `packages/desktop/scripts/desktop-native-package-policy.mjs`）。

Linux 固定 `secret-service`。没有 DBus 会话（典型的无头/SSH 场景）时原生调用失败被归到
`stage=load`，由失败矩阵决定回退还是拒绝，而不是让进程崩溃。

## 备份

### 推荐做法

**先退出应用**，再整体复制数据目录：

```bash
# 退出 ZCode-CE（含后台 Host 进程）后执行
cp -a ~/.zcode/v2 ~/.zcode/v2.backup-$(date +%F)
```

`-a` 保留权限位 —— `credentials.json` 与 `credential-secret` 都是 600，普通复制会让凭据变成全局可读。

**凭据副本本身不足以恢复登录**：token 用 32 字节随机主密钥加密，密钥存在系统凭据库（macOS Keychain /
Windows Credential Manager / Linux Secret Service）或同目录 `credential-secret`。所以：

- 只备份 `credentials.json` ⇒ **换机/重装后解不开**（系统凭据库里的密钥不随文件走），只能重新登录。
- 同目录 `credential-secret` 也要一起备份才能在新机器上恢复；它同样是秘密，按凭据对待。
- 这不是缺陷而是 P1 的目标：拿到 `credentials.json` 副本不再等于拿到 token。

**不要只备份 `tasks-index.sqlite` 单个文件**。它运行在 WAL 模式（见下），最新提交可能还在
`-wal` 里，单文件副本会丢失最近的会话列表变更。要么整体复制目录，要么用 SQLite 自身的一致性导出：

```bash
sqlite3 ~/.zcode/v2/tasks-index.sqlite "VACUUM INTO '/path/to/tasks-index.backup.sqlite'"
```

`VACUUM INTO` 产出的是**已整理的一致性快照**（不含 `-wal`），可在应用运行时执行，适合做定期备份。
本机实测：2.9 MB 库导出为 2.8 MB，表结构与行数完整。

### 恢复

1. 退出应用
2. 备份当前目录（防止覆盖掉可用的数据）
3. 把备份目录复制回 `~/.zcode/v2`
4. 确认权限：`chmod 600 ~/.zcode/v2/credentials.json`

### 不要备份的内容

`checkpoints/` 与 `logs/` 通常占目录总体积的绝大部分（见上表的实测体积），且都是可重建的中间产物。
如果只关心配置与凭据，跳过这两个目录即可。

> 应用内置了「资源管理器」的存储视图，按类别列出占用并标注可清理性
> （`packages/services/src/storage/domain/storageCatalog.ts`）。`setting.json`、
> `credentials.json` 等被显式标记为受保护路径，不会被清理流程删除。

## `tasks-index.sqlite` 的 WAL 注意事项

任务索引库使用 **WAL（write-ahead log）** 模式，由
`packages/services/src/session/tasksDatabase/startup.ts` 在启动时设置：

```
PRAGMA journal_mode = WAL
PRAGMA synchronous = NORMAL
PRAGMA foreign_keys = ON
PRAGMA busy_timeout = 25ms（启动迁移期；各 Repo 另设更长超时）
```

三个实际影响：

**1. 会看到 `-wal` / `-shm` 伴随文件。** 应用运行时 `tasks-index.sqlite-wal` 可能达到与主库相当
的体积，这是正常的。复制这三个文件时**必须一起复制**，且要在应用退出后 —— 运行中复制会得到
撕裂的快照。正常关闭后 SQLite 会自动清理这两个文件。

**2. 多进程并发写入。** 桌面多窗口场景下，每个窗口的 Host 会打开同一个库。写事务与首次
schema 升级**短暂等待锁**而不是立刻报 `SQLITE_BUSY`。这意味着启动瞬间可能出现
`waiting_for_lock` 阶段，属预期行为，不是卡死。

**3. 不要把库放在网络盘或同步目录。** WAL 依赖共享内存（`-shm`）与文件锁，NFS/SMB、
网盘同步客户端、容器 bind mount 都可能破坏这些语义，导致锁失效或库损坏。同理，
`ZCODE_DATA_BASE_DIR` 也不要指向这类位置。

> 若怀疑库损坏，**不要删除主库**（会丢掉全部会话索引）。先做一份整体备份，再用
> `sqlite3 <db> "PRAGMA integrity_check"` 确认。
