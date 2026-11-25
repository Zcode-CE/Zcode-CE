# Credential security（凭据 v2，P1）

后端共享的异步加密适配层。Desktop Host、桌面内置 agent、独立 CLI 与独立 Server 使用同一格式与
同一套密钥解析；公开面是 `module.ts`，系统密钥不进入前端或通用 RPC。

## 格式

```text
enc:v2:<source>:<fingerprint>:<iv_b64url>.<tag_b64url>.<ct_b64url>
  source      ∈ {"os", "env"}   // os = 系统凭据库；env = 显式配置 / 显式文件 / 私有 credential-secret
  fingerprint = sha256(key) 的前 24 位 hex，仅用于区分「密钥不对」与「密文损坏」
```

写侧恒写 `enc:v2:`。读侧永久容忍明文与 `enc:v1:`（三个历史候选密钥：原字符串、trim 后、历史默认派生）；
未知 `enc:` 前缀一律明确报错 —— 按明文返回会把「密钥不对」伪装成「值就是这个字符串」。

## 密钥来源优先级

1. `ZCODE_CREDENTIAL_SECRET`（原字节，不 trim）
2. `ZCODE_CREDENTIAL_SECRET_FILE`（32–4096 字节，原字节）
3. 同目录私有 `credential-secret`（0600，已存在才用）
4. 系统凭据库条目（service `ZCode Credential Encryption`，account = sha256(规范化凭据文件绝对路径)）

凭据文件路径的唯一解析在 `../credentialPaths.ts`（`@zcode/shared/credential-paths`，浏览器安全）：
CLI 用 `resolveCredentialsFilePath(env)`，服务端用 `resolveCredentialsFilePathIn(getDataBaseDir())`。
系统条目名 = sha256(该绝对路径)，两侧一旦分叉就会给同一个文件造两把密钥。

① 与 ② 同时存在按 `config` 阶段拒绝。私有文件先于系统库，是为了「一次回退后永久稳定」——
否则同一目录会在「库恢复可用」与「文件已存在」之间来回切换来源，而已有密文离不开生成它的密钥。

系统库成功初始化时，在同一把密钥锁内原子写 `credential-source`（内容仅 `os`，不含密钥）固定来源。
Linux 固定 `secret-service`，不回退到重启即失的 kernel keyutils。

## 允许创建 vs 拒绝创建

| 形态                              | 入口                                                        | 未绑定目录且无密钥                                                                                 |
| --------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 桌面 Host / 内置 agent / 独立 CLI | `createSystemCredentialCipher`                              | 系统库可用则生成 32B 随机密钥；不可用则发布 0600 `credential-secret`                               |
| 独立 Server / 无头 npm / Docker   | `createServerCredentialCipher`（`allowKeyCreation: false`） | **拒绝就绪**并给出可操作错误（文件名、目录、字节范围、如何重连）。容器重建会静默丢密钥，不自动生成 |

「生成」与「读取」是两条路径：解密缺密钥的 v2 文件时禁止创建，否则会把「密钥丢失」误判成「首次使用」。

## 失败矩阵（P1）

| 情形                                              | 行为                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| 系统库不可用 + 目录未绑定 + 允许创建              | 回退私有文件（`onFallback` 回调一次，无密钥/路径载荷）                         |
| 系统库不可用 + 目录已有 v2 密文                   | `CREDENTIAL_SECURE_STORAGE_UNAVAILABLE`，**不清库、不换来源**（自动重置属 P2） |
| 系统库不可用 + 来源标记为 os 但文件无任何 v2 密文 | 只删来源标记 → 改用私有文件（「只解除绑定、不清库」）                          |
| 显式配置冲突/不可读/越界                          | `stage=config`                                                                 |
| 私有文件权限放宽、非文件、越界                    | `stage=managed`                                                                |
| 加密后写盘前代次变化                              | `ZCODE_CREDENTIAL_STORE_CHANGED`，不写盘，调用方重试一次                       |
| 新产生 `enc:v2:os:` 但无来源标记                  | 拒绝写盘（`stage=source`），磁盘字节不变                                       |

错误码必须互相区分（存储不可用 ≠ 密文解不开 ≠ 登录失效），否则既有 OAuth 恢复逻辑会误删登录。

## 不变式

- I1 不静默降级：任何路径都不得回落到 v1 派生密钥去解 v2 密文。
- I2 不生成替代密钥：已有来源标记或 v2 密文时条目缺失即拒绝，不清库、不换来源。
- I3 存储错误 ≠ 登录失效：三个错误码互不冒充。
- I4 同一进程同一路径只加载一次（含失败）；未取得密钥锁的失败不缓存。
- I5 缓存属于加载时代次；代次变化即丢弃缓存后重载。

## 锁序与并发

锁序恒为「凭据文件锁 → 密钥锁」（`<credentials.json>.keyring`），任何路径都不得反序。
首次并发生成由密钥锁串行化，后到者读到同一把密钥；私有文件用 `wx` + `link` 排他发布，绝不覆盖。

## 批量读写（SPEC §7）

批量语义只有一处实现：`credentialBatchStore.ts`（读多键、整组 CAS、条件删）与
`credentialGenerationScope.ts`（代次作用域）。Host 凭据服务与 CLI store 只做键值校验与变更通知。

| 入口                               | 语义                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `loadManyCredentialValues`         | 一次读多键；`null` 只表示键不存在（空串表示存在且为空）；读取前后复核代次                        |
| `updateCredentialValuesMany`       | 整组 CAS：`expected` 全部相等才应用 `changes`（`null` = 删除）；不匹配返回 `false` 且不写盘      |
| `deleteUnreadableCredentialValues` | 只删锁内仍解不开的键，可附带 `removeKeys` 与 `replacements`；返回受影响键集合或 `null`（未提交） |
| `saveCredentialValueIfAbsent`      | 锁内「没有才写」，返回实际值；并发收敛到先写入者                                                 |
| `deleteCredentialValueIfEquals`    | 只删仍等于期望明文的值；解不开按不等处理（不删）                                                 |
| `recoverUnreadableCredentialValue` | 可读则返回原值、不可读则删除该键；`assertCurrent` 在锁内执行                                     |
| `captureCredentialGuard`           | 把读-改-写包成一个代次作用域；作用域内写入口用事务起始代次                                       |

四条不变量：CAS 是整组的（不是逐键删除）；比较在锁内、解密后（密文解不开 = 不等，密钥不可用 = 上抛）；
加密在领取代次之后、文件锁之外完成；变更通知由调用方在锁外发送（锁内通知会让监听器派生的任务沿用本次代次）。

## 变更通知载荷

`onDidMutate` 的载荷是 `{ operation: "save" | "delete" | "batch" | "recover", keys: readonly string[] }`：
批量提交只发一个事件且键已去重，单键操作恒为长度 1。`recover` 由单键恢复（`recoverUnreadable`）
与 P2 的整库恢复共用，消费点必须逐键判定而不是只看第一个键。

## 本期未做（P2 / P3）

自动重置、失败诊断全集与进程级观察者、`inspectStore/recoverStore`、Main 私有桥、
`prepareServerCredentialStorage`（Desktop 远程启动准备）。

原生 `@napi-rs/keyring`（2.1.2，精确版本）已随桌面内置 agent 分发：`asarUnpack` 只解目标平台变体的 `.node`，
`desktop-native-package-policy.mjs` prune 非目标变体并在产物校验里报「非目标变体 / 缺目标变体 / 缺 .node / 缺主包」四类违规。
无头分发包**不带**该模块（无头本就 `allowKeyCreation:false`，只接受显式配置密钥）⇒ 运行时 `stage=load` 并按上表回退或报错。
