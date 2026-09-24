# 贡献指南

> 面向提交 PR 或反馈问题的贡献者：这里给出改动前要跑的命令、必须达到的标准，以及评审会关注什么。

## 提交前

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm fmt:check
pnpm architecture:check --changed
```

涉及 desktop main/renderer 改动时，额外跑 `bash scripts/desktop-typecheck-baseline.sh diff`。

> `pnpm typecheck` 的工程列表**不含** desktop 的 main / renderer 子工程（见
> [与上游的差异](../development/upstream-diff.md) 的技术债 #2）。这两个子工程有既有的类型错误，
> 因此用上面的基线脚本做**增量**判断：只关心「有没有新增」，不要求清零存量。

## 代码规范

- 新增或修改行为前，先更新对应 spec
- 单个源文件默认不超过 **400 行**，超过时按高内聚低耦合拆分
- 字符串、数字等常量提取为命名变量，不在业务逻辑中散落字面量
- 修复 bug 时用注释说明**原因和修复依据**
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序

## 日志

| 场景                                 | 用法                                              |
| ------------------------------------ | ------------------------------------------------- |
| UI                                   | `packages/ui/src/logger.ts`（不用 `console.log`） |
| Agent/session/runtime 服务           | `createServiceLogger(scope)`                      |
| 高频诊断（协议原始数据、流式 chunk） | `debug`，生产不落盘                               |
| 进程与会话生命周期、权限结果         | `info`                                            |
| 可恢复异常                           | `warn`                                            |
| 崩溃、握手失败、鉴权丢失             | `error`                                           |

不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。

## 第三方代码

引入第三方代码、文档、提示词或素材前，确认来源、许可证与使用权限，按适用许可**保留版权、署名及修改说明**。登记格式见 `third-party/copied-components.json`。

## 提交粒度

每个功能级别的变更创建一个独立提交；不把无关的功能、重构、依赖更新和格式调整混在同一提交。
