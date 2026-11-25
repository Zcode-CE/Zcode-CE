<!-- 草稿：未发版，发版前删除本行 -->

## 新增功能

- **登录凭据存进系统钥匙串**：macOS 钥匙串、Windows 凭据管理器、Linux Secret Service 可用时，登录凭据由系统保管；钥匙串不可用时退回本机加密文件，并在设置里能看到当前用的是哪一种。
- **读不出来的会话数据不再让整段会话打不开**：单条数据损坏或来自更新版本时，只把那一行显示为占位并说明是「可能来自更新版本」还是「数据可能已损坏」，其余内容照常可用。
- **多段消息按原样分段显示**：一条消息里的多段文字不再被拼成一句。
- **打开可执行类文件前先确认**：在终端中打开、或用指定应用打开脚本/快捷方式这类文件时会先询问，默认与 Esc 都是取消。

## 体验优化

- **会话启动不再长时间卡住**：等待文件系统准备的通用步骤有了上限，超时按降级处理而不是一直等。
- **恢复会话后不再出现「内容块绑定到了不同会话」的服务商报错**，同一轮里的文字与工具调用顺序保持稳定。
- **长时间对话的流式回复更少卡顿**：已发送过的系统提示按原样复用，不再每次重建。

## 问题修复

- **安全**：工作流脚本无法再逃出沙箱拿到宿主机权限；网页内容与 Mermaid 图里的链接不再能把主窗口导航到外部地址；自定义 CA 只接受完整证书链；`adb` 只采用系统路径里的可执行文件，工作区内同名的 `adb` 不会被使用；项目里换掉钩子脚本后不再沿用旧的信任状态；插件的敏感选项不再写入通用配置文件。
- **数据完整性**：配置合并不再把「工具与权限」「网络」「存储」里的用户设置重置为默认；导出日志与应用内反馈不再带出凭据；登录资料刷新不再把账号身份指向另一个账号；会话数据库升级到最新结构。
- **其他**：MCP 服务的错误日志在截断后不再泄露密钥片段；不可读的会话行不再导致会话永久打不开。

## 升级须知（行为变化）

- **使用脚本入口的工作区钩子需要重新信任一次**：信任摘要现在包含脚本内容，所以脚本变化的钩子不会再被当作已信任。没有脚本入口的钩子不受影响。
- **登录凭据换用新的加密格式，不支持回退到旧版本**：旧版本读不了新格式的密文。如果可能需要回退，请先记下当前登录方式并准备重新登录。
- **会话数据库会升级到最新结构**：如果这个数据库已被更新版本的官方客户端升级过，本版会明确拒绝写入并提示，而不是尝试混用。
- **首次打开可执行类文件会多一次确认**：确认框中默认按钮与 Esc 都是取消。

## 同步上游

| 条目                                                                                                                                                           | 上游版本 | 来源     | 依据     | 同步情况                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- | -------- | --------------------------------------------------------------------------------------- |
| 工作流脚本沙箱加固、只读命令判定收紧、会话行逐行降级、内容块顺序、系统提示快照、会话库结构调整、登录资料只更新展示字段                                         | 3.18.x   | 开源仓库 | 源码比对 | 已跟进                                                                                  |
| 主窗口导航限制、插件敏感选项隔离、`adb` 只允许系统路径、钩子脚本内容纳入信任、文件监听原语、可执行文件打开确认、日志脱敏、自定义 CA 整链校验、配置合并逐项保留 | 4.0.0    | 开源仓库 | 源码比对 | 已跟进                                                                                  |
| 请求签名器、验证码分流、官方端点路由、官方遥测上报                                                                                                             | 4.0.0    | 闭源包   | 逆向分析 | 不适用（查过：本版不引入签名器与验证码分流，也不上报遥测）                              |
| 预装工具链（随官方 CDN 下发的办公引擎）、扩展宿主（Extension Host）                                                                                            | 4.0.0    | 开源仓库 | 源码比对 | 未跟进（有意）：与本版「办公能力零外部依赖」的边界冲突，且会引入上百 MB 的原生引擎      |
| 项目与宿主分离的数据模型                                                                                                                                       | 4.0.0    | 开源仓库 | 源码比对 | 未跟进（有意）：本版的项目身份就是工作区路径，换成宿主+项目两套标识会打断现有工作区数据 |

## 已知限制

- 打开可执行文件的确认按扩展名判断，**没有扩展名的可执行文件不会触发确认**；这是为了不对普通源码文件反复打扰。
- 不可读会话行的占位只给分类提示（更新版本 / 数据损坏），不展示原始内容。

## 本版尚未验证

- **Windows 与 macOS 安装包的启动与界面交互未在真机逐项执行**；本期改动里的平台相关部分只在 Linux 上验证。
- **系统钥匙串只在 Linux 上验证过**：macOS 钥匙串、Windows 凭据管理器，以及安装包形态（AppImage / deb / 系统包 / 安装器）下的原生模块加载，都还没有真机结论。
- **`rpm` 安装包未在本地产出**（本机缺少打包工具），由 CI 产出；`AppImage` 与 `deb` 已本地产出并核对。
- **真实服务商下的冷恢复没有端到端验证**：系统提示复用与内容块顺序只有本地用例覆盖。
- **桌面端与网页端的新界面没有逐项点检**：可执行文件确认框、不可读行占位、钩子信任提示都只做了类型与文案核对。
- **与官方客户端共用同一数据目录时的互开没有验证**：本版遇到更高版本的会话库会拒绝写入，反向（官方读本版升级后的库）没有实测。

---

<!-- English -->

## New features

- **Sign-in credentials in the system keychain**: when the macOS Keychain, Windows Credential Manager, or Linux Secret Service is available, credentials are kept there; otherwise they fall back to an encrypted local file. Settings shows which source is in use.
- **One unreadable row no longer breaks a whole conversation**: a damaged row, or one written by a newer version, is shown as a placeholder that says whether it likely comes from a newer version or from damaged data. The rest of the conversation stays usable.
- **Multi-part messages keep their paragraphs** instead of being joined into one line.
- **Opening an executable file asks first**: opening scripts and shortcuts in the terminal or with a chosen app shows a confirmation; the default button and Esc both cancel.

## Improvements

- **Session startup no longer hangs**: the generic step that waits for the file system now has a deadline and degrades instead of waiting indefinitely.
- **Restored sessions no longer hit the provider error about content blocks bound to a different conversation**, and text and tool calls in a turn keep their order.
- **Less streaming jank in long conversations**: the system prompt that was already sent is reused instead of being rebuilt each turn.

## Fixes

- **Security**: workflow scripts can no longer escape their sandbox to reach host privileges; links in page content and Mermaid diagrams can no longer navigate the main window to an external address; a custom CA is only accepted as part of a complete chain; `adb` is only taken from the system path, never a same-named file inside the workspace; changing a workspace hook script no longer keeps the old trust state; sensitive plugin options are no longer written to the shared config file.
- **Data integrity**: merging configs no longer resets your tools-and-permissions, network, or storage settings to defaults; exported logs and in-app feedback no longer carry credentials; refreshing your profile no longer points the account identity at a different account; the session database is upgraded to the current structure.
- **Other**: truncated MCP error logs no longer leak credential fragments; an unreadable conversation row no longer makes the conversation permanently unopenable.

## Upgrade notes (behaviour changes)

- **Workspace hooks with a script entry need to be trusted again once**: the trust digest now includes the script contents, so a hook whose script changed is not treated as trusted. Hooks without a script entry are unaffected.
- **Credentials use a new encryption format and cannot be rolled back**: older versions cannot read the new ciphertext. If you may need to roll back, note how you sign in and be ready to sign in again.
- **The session database is upgraded to the current structure**: if that database was already upgraded by a newer official client, this build refuses to write and tells you instead of mixing formats.
- **Opening an executable file asks once more**: the confirmation's default button and Esc both cancel.

## Upstream sync

| Item                                                                                                                                                                                                                                                      | Upstream version | Source                 | Basis               | Status                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow sandbox hardening, read-only command tightening, per-row conversation degradation, content block order, system prompt snapshot, session database structure, profile refresh limited to display fields                                            | 3.18.x           | Open-source repository | Source comparison   | Followed                                                                                                                                                                |
| Main-window navigation guard, plugin sensitive option isolation, `adb` restricted to the system path, hook script contents in trust, file-watch primitive, executable open confirmation, log redaction, full custom CA chain, config merge field by field | 4.0.0            | Open-source repository | Source comparison   | Followed                                                                                                                                                                |
| Request signer, captcha routing, official endpoint routing, official telemetry                                                                                                                                                                            | 4.0.0            | Closed-source package  | Reverse engineering | Not applicable (checked: this build uses neither a signer nor captcha routing, and reports no telemetry)                                                                |
| Preinstalled toolchain (document engines fetched from the official CDN), extension host                                                                                                                                                                   | 4.0.0            | Open-source repository | Source comparison   | Not followed (deliberate): conflicts with this build's zero-external-dependency stance for document work and would add a native engine of well over a hundred megabytes |
| Separate host and project data model                                                                                                                                                                                                                      | 4.0.0            | Open-source repository | Source comparison   | Not followed (deliberate): this build's project identity is the workspace path; two identifiers would break existing workspace data                                     |

## Known limitations

- The executable-open confirmation is based on file extensions, so an **executable without an extension does not trigger it**. This avoids nagging on ordinary source files.
- The placeholder for an unreadable row only gives a category (newer version or damaged data), not the original content.

## Not verified in this release

- **Windows and macOS installers were not exercised on real machines**; the platform-specific parts of these changes were verified on Linux only.
- **The system keychain was verified on Linux only**: the macOS Keychain, Windows Credential Manager, and loading the native module from installer packages (AppImage / deb / system package / installer) have no real-device conclusion yet.
- **The `rpm` package was not produced locally** (the packaging tool is missing on the build host); CI produces it. `AppImage` and `deb` were produced and inspected locally.
- **Cold restore against a real provider is not end-to-end verified**: prompt reuse and content block order are covered by local tests only.
- **The new desktop and web surfaces were not walked through**: the executable confirmation, the unreadable-row placeholder, and the hook trust prompts were checked by types and copy only.
- **Sharing a data directory with the official client was not verified**: this build refuses to write to a newer session database, but the reverse direction (an official client reading the upgraded database) was not tested.
