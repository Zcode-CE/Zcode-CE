# ZCode-CE v3.14.1-ce.1

**中文** · [English](#english)

基于官方 ZCode **3.14.1** 的社区版首个正式发布。

## 与官方发行版的差异

| 方面             | 说明                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **无遥测**       | 移除官方发行版中的遥测与监控组件（ARMS/RUM、OpenTelemetry、崩溃远端上报）                                                |
| **保留权益**     | 官方服务权益（套餐额度、限时赠送额度领取、额度重置）完整保留                                                             |
| **社区反馈**     | 反馈默认走本项目的 GitHub Issues，渠道可配置或关闭                                                                       |
| **开源文档能力** | Office 文档能力（Word / PowerPoint / Excel）由 MIT 许可的开源实现提供                                                    |
| **桌面自动化**   | Computer Use 由 MIT 许可的开源实现（[trycua/cua](https://github.com/trycua/cua)）提供，不依赖官方未标注许可的闭源 helper |

## 功能

- 模型列表支持隐藏内置模型与从供应商拉取（三种 API 格式）
- 手动领取套餐的验证码链路
- 国内加速配置（默认关闭）
- 补上社区插件市场入口（Superpowers、context7 等可安装）
- 补齐官方 3.14.1 的两项修复（引导重复弹出、折叠输入框丢内容）

## 发布

- 安装身份独立（`ZCode-CE` / `dev.zcode.app.ce`），可与官方版并存安装
- 更新渠道指向本项目的 GitHub Release，不执行远端强制升级检查
- GitHub Actions 自动构建（Linux + Windows）

## 平台

| 平台             | 产物                          | 说明                                                        |
| ---------------- | ----------------------------- | ----------------------------------------------------------- |
| **Linux**        | AppImage / deb / rpm / pacman | AppImage 需先 `chmod +x`                                    |
| **Windows**      | NSIS                          | 当前**未签名**，首次运行需在 SmartScreen 中选择「仍要运行」 |
| **Computer Use** | —                             | Windows 正式支持；Linux 实验性（默认关闭）                  |

**数据目录**：与官方 ZCode 共享 `~/.zcode/v2`，可并存安装但不建议同时运行。

**Windows 签名**：官方发行版使用 DigiCert 签发的组织验证（OV）证书签名。本项目作为社区项目无法申请同类证书，正在申请 [SignPath Foundation](https://signpath.org/) 的免费开源代码签名，通过后将消除 SmartScreen 提示。

## 文档

- [与官方发行版的差异](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/development/official-diff.md)
- [桌面自动化](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/development/computer-use.md)
- [遥测与隐私](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/development/telemetry.md)

---

## English

The first stable community release based on official ZCode **3.14.1**.

### Differences from the official distribution

| Area                       | Description                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No telemetry**           | Telemetry and monitoring components from the official distribution are removed (ARMS/RUM, OpenTelemetry, remote crash reporting)                            |
| **Entitlements preserved** | Official service entitlements (plan quotas, limited-time bonuses, quota resets) are fully retained                                                          |
| **Community feedback**     | Feedback goes to this project's GitHub Issues by default; the channel is configurable or can be disabled                                                    |
| **Open document skills**   | Office document capabilities (Word / PowerPoint / Excel) come from MIT-licensed open implementations                                                        |
| **Desktop automation**     | Computer Use comes from an MIT-licensed open implementation ([trycua/cua](https://github.com/trycua/cua)), not the official unlicensed closed-source helper |

### Features

- Hide built-in models and fetch model lists from providers (three API formats)
- Captcha flow for manually claiming plan bonuses
- China network acceleration setting (off by default)
- Community plugin marketplace entry (Superpowers, context7, and others are installable)
- Both official 3.14.1 fixes ported (onboarding re-prompting, composer content loss)

### Release

- Separate install identity (`ZCode-CE` / `dev.zcode.app.ce`); installs side by side with the official build
- Update channel points at this project's GitHub Release; no remote force-update gate
- GitHub Actions automated builds (Linux + Windows)

### Platforms

| Platform         | Artifacts                     | Notes                                                                                         |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| **Linux**        | AppImage / deb / rpm / pacman | AppImage needs `chmod +x`                                                                     |
| **Windows**      | NSIS                          | Currently **unsigned**; first launch requires choosing "Run anyway" in the SmartScreen prompt |
| **Computer Use** | —                             | Fully supported on Windows; experimental on Linux (off by default)                            |

**Data directory**: shared with the official ZCode at `~/.zcode/v2`. Both can be installed side by side, but running them simultaneously is not recommended.

**Windows signing**: the official distribution is signed with a DigiCert organization-validated (OV) certificate. As a community project we cannot obtain that class of certificate, and are applying for free open-source code signing from [SignPath Foundation](https://signpath.org/). Once approved, the SmartScreen prompt goes away.

### Documentation

- [Differences from the official distribution](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/development/official-diff.md)
- [Desktop automation](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/development/computer-use.md)
- [Telemetry and privacy](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/development/telemetry.md)
