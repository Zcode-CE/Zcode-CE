# ZCode-CE 文档

面向 ZCode-CE 的开发者、贡献者与运维者。上游官方文档不随本仓库分发，本目录是社区版自己的文档入口。

## 目录

### `development/` — 开发

| 文档                                                                     | 内容                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| [架构与模块边界](development/architecture.md)                            | 仓库结构、包职责、依赖方向、跨包导入规则                   |
| [与上游的差异](development/upstream-diff.md)                             | 相对官方 ZCode 改了什么、为什么改、如何同步                |
| [与官方发行版的差异](development/official-diff.md)                       | 官方有哪些能力、我们补了什么、哪些做不了及原因             |
| [Computer Use](development/computer-use.md)                              | 开源桌面自动化实现的平台、能力面与安全语义                 |
| [办公插件](development/office-plugins.md)                                | 办公三件套的来源标注规范、逐文件归属、上游跟进             |
| [PDF 插件](development/pdf-plugins.md)                                   | PDF 能力的载荷构成、注册闸门、校验器契约与降级边界         |
| [模型列表](development/model-list.md)                                    | 内置模型隐藏与从供应商拉取模型列表                         |
| [本地开发](development/local-setup.md)                                   | 环境准备、构建、调试、测试入口                             |
| [网页远控（无头服务器 + 浏览器面板）](development/web-remote-control.md) | 自托管网页远控：启动方式、安全默认值、手机使用、未测边界   |
| [远程工作区（SSH / Docker / WSL）](development/remote-workspace.md)      | 远程工作区的默认行为、自建发布点、验收与排障               |
| [工具与权限：按资源/工具精细启停](development/tool-policy.md)            | 危险命令判定、MCP 单工具启停、持久授权策略                 |
| [遥测与隐私](development/telemetry.md)                                   | 本版移除遥测的范围、保留的能力边界、验证方法               |
| [工作区可见性](development/workspace-registry.md)                        | 可见工作区的真相源、能全看不默认全看、未启动态             |
| [文案与格式纪律](development/copy-and-format.md)                         | UI 文案 / 注释 / 文档三面的 markdown 强调规则与护栏        |
| [上游同步台账](development/upstream-sync.md)                             | 每个上游版本同步了什么、有意未同步什么、确认过不存在的结论 |
| [欠账台账](development/backlog.md)                                       | 未做 / 排后续 / 有意不做的**唯一汇总处**（防散落与遗漏）   |

### `community/` — 社区

| 文档                                  | 内容                                 |
| ------------------------------------- | ------------------------------------ |
| [贡献指南](community/contributing.md) | 提交流程、代码规范、审查要点         |
| [反馈与诊断](community/feedback.md)   | 反馈渠道配置、诊断信息范围、脱敏说明 |

### `operations/` — 运维与发布

| 文档                                                              | 内容                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| [发布流程](operations/release.md)                                 | 版本号、构建产物、更新渠道、平台支持                   |
| [持续集成](operations/ci.md)                                      | CI 校验项、发布矩阵、打包命令与常见失败原因            |
| [数据与配置](operations/data-layout.md)                           | 数据目录布局、身份变更的数据影响、备份                 |
| [无头服务器发行包](operations/headless-server.md)                 | 自包含 `zcode` 包：运行、旋钮、安全边界、平台支持      |
| [无头服务器：Docker](operations/headless-server-docker.md)        | 本地构建容器形态：卷与备份、令牌与轮换、局域网访问     |
| [无头服务器反代部署](operations/headless-server-reverse-proxy.md) | 反代/TLS 之后的三件事：Host 白名单、挂域名根、可信代理 |
| [CJK 字体供给](operations/font-provisioning.md)                   | 字体策略：用系统已装字体、不下载不打包                 |
| [GitHub 加速配置](operations/github-mirror.md)                    | 国内网络下的镜像/加速配置与验证方式                    |
| [发布设计](operations/release-design.md)                          | 包名、构建产物与更新渠道的设计与决策记录               |
| [远程资产 CDN](operations/remote-assets-cdn.md)                   | R2 发布点运维：认证、发布、排障、红线                  |
| [Code signing policy](operations/code-signing-policy.md)          | 代码签名政策、团队角色、隐私政策                       |

## 文档边界

本仓库区分**公开文档**与**私有工作记录**，两者不混放：

|          | `docs/`（本目录）          | 私有工作记录                 |
| -------- | -------------------------- | ---------------------------- |
| 是否入库 | ✅ git 追踪                | ❌ 本地忽略                  |
| 读者     | 外部开发者、贡献者         | 项目维护者                   |
| 内容     | 稳定的架构说明、流程、规范 | 过程记录、决策讨论、调研笔记 |
| 语气     | 客观陈述，面向陌生读者     | 可以是草稿、疑问、待验证     |

**写作规则**：

- 本目录**不引用**仓库外或本地忽略的路径 —— 外部读者看不到它们
- 结论若源自私有调研，应**整理成自洽的说明**写进本目录，而不是链接过去
- 过程性、临时性、未定论的内容留在私有记录里，不进本目录

## 与仓库根文档的分工

本仓库根目录另有几份面向**编码代理**的约定文件，它们不是人类开发者的入门文档：

| 文件                        | 定位                                           |
| --------------------------- | ---------------------------------------------- |
| [AGENTS.md](../AGENTS.md)   | 编码代理的工作规则（命令、架构约束、验证要求） |
| [CONTEXT.md](../CONTEXT.md) | 插件商店领域词汇表                             |
| [DESIGN.md](../DESIGN.md)   | UI 设计规范                                    |
| [NOTICE.md](../NOTICE.md)   | 功能说明与第三方组件声明                       |

## 许可与归属

ZCode-CE 基于 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）。本仓库的分发与署名要求见根目录 [LICENSE](../LICENSE) 与 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。
