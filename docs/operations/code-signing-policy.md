# Code signing policy

**Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).**

本页说明 ZCode-CE 的代码签名政策，以及谁有权批准一次发布被签名。

## 为什么要签名

Windows 安装包未签名时，用户首次运行会看到 SmartScreen 警告，需要手动选择「仍要运行」。
签名让用户能确认「这个二进制确实由本项目的仓库构建」，而不是被第三方替换过的版本。

本项目作为社区项目无法申请官方的组织验证（OV）证书 —— 官方发行版使用 DigiCert 签发的 OV
证书，那需要企业主体。因此我们申请 SignPath Foundation 为开源项目提供的免费代码签名。

**签名证书签发给 SignPath Foundation，不是本项目。** 用户看到的签名者是 SignPath
Foundation；它的含义是「SignPath Foundation 验证过这个二进制由本项目的仓库构建」。

## 团队角色

按 SignPath 的要求，签名需要三类角色，分别对应本组织的三个 GitHub 团队：

| 角色          | 职责                   | 团队                                                                    |
| ------------- | ---------------------- | ----------------------------------------------------------------------- |
| **Authors**   | 可以直接修改源码       | [@Zcode-CE/authors](https://github.com/orgs/Zcode-CE/teams/authors)     |
| **Reviewers** | 审查非提交者提出的改动 | [@Zcode-CE/reviewers](https://github.com/orgs/Zcode-CE/teams/reviewers) |
| **Approvers** | 批准一次发布被签名     | [@Zcode-CE/approvers](https://github.com/orgs/Zcode-CE/teams/approvers) |

**每一次签名都需要 Approvers 中的成员人工批准**，没有全自动签名。

所有团队成员均启用多因素认证（MFA）。

## 构建与签名的可验证性

签名对象是 CI 构建的产物，构建过程可复现、可审查：

| 项目         | 位置                                                                |
| ------------ | ------------------------------------------------------------------- |
| 构建定义     | [`.github/workflows/release.yml`](../.github/workflows/release.yml) |
| 发布流程说明 | [`docs/operations/release.md`](operations/release.md)               |
| CI 说明      | [`docs/operations/ci.md`](operations/ci.md)                         |

构建在 GitHub Actions 上执行（`ubuntu-latest` 与 `windows-latest`），产物上传到本仓库的
GitHub Release。签名的二进制来自这些 Release 产物，不来自开发者本机。

## 隐私政策

**本程序不会向其他网络系统传输任何信息，除非用户或安装/操作本程序的人明确要求。**

具体说明：

| 行为         | 说明                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| **遥测**     | 已移除官方发行版中的遥测与监控组件。使用自带 API 时，不产生与官方服务相关的后台上报 |
| **模型请求** | 仅在用户发起对话时，向用户配置的模型服务发送请求                                    |
| **更新检查** | 从本项目的 GitHub Release 检查更新，可关闭                                          |
| **反馈**     | 仅在用户主动点击反馈时打开外部地址；渠道可配置或关闭                                |
| **强制升级** | 不执行远端强制升级检查                                                              |

第三方组件与服务的隐私政策见 [NOTICE.md](../NOTICE.md) 与
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。详细的遥测说明见
[`docs/development/telemetry.md`](development/telemetry.md)。

## 相关文档

- [与官方发行版的差异](development/official-diff.md)
- [发布流程](operations/release.md)
- [NOTICE.md](../NOTICE.md) —— 功能说明与风险提示
