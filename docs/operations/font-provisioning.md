# CJK 字体供给设计

> 状态：**设计稿**（未实施）· 2026-09-21
> 决策：用户确认「首次下载」方案

## 一、背景

Office 文档能力（docx/pptx/xlsx）生成中文文档时需要 CJK 字体。官方插件从 CDN 下载 **80 个字体**。

## 二、官方做法（实测）

`/usr/lib/zcode/glm/packages/documents-plugin/skills/docx/env_setup/setup_mac_linux.sh`：

```bash
FONT_CDN_BASE="https://z-cdn.chatglm.cn/office-skill/fonts"
# 逐个下载 font_list.txt 里的 80 个路径
curl -fSL -o "$USER_FONT_DIR/$fname" "$FONT_CDN_BASE/$encoded"
# 装到 ~/.local/share/fonts（Linux）/ ~/Library/Fonts（macOS）
# marker 文件防重复：.office-skill-fonts-installed
fc-cache -f "$USER_FONT_DIR"   # Linux 刷新字体缓存
```

**⚠️ 但官方 CDN 已不可用**（Lead 实测）：

| 探测                                                 | 结果            |
| ---------------------------------------------------- | --------------- |
| `https://z-cdn.chatglm.cn/office-skill/fonts/`       | 200（目录存在） |
| `.../fonts/truetype/chinese/SarasaMonoSC-Italic.ttf` | **404**         |
| `.../fonts/chinese/NotoSansSC-Regular.ttf`           | **404**         |
| `.../fonts/font_list.txt`                            | **404**         |

**所有具体字体文件都是 404。** 因此**不能依赖官方 CDN**。

## 三、字体构成与许可（全部开源）

官方 80 个字体全部是开源许可：

| 字体              | 数量 | 上游                                        | 许可                     |
| ----------------- | ---- | ------------------------------------------- | ------------------------ |
| Sarasa Mono SC    | 10   | github.com/be5invis/Sarasa-Gothic           | OFL-1.1                  |
| Noto Sans SC      | 13   | github.com/notofonts/noto-cjk               | OFL-1.1                  |
| Noto Serif SC     | 9    | github.com/notofonts/noto-cjk               | OFL-1.1                  |
| LXGW WenKai       | 6    | github.com/lxgw/LxgwWenKai                  | OFL-1.1                  |
| WenQuanYi Zen Hei | 1    | github.com/anthonyfok/fonts-wqy-zenhei      | GPL-2.0 + font exception |
| DejaVu            | 8    | github.com/dejavu-fonts/dejavu-fonts        | Bitstream Vera           |
| Liberation        | 12   | github.com/liberationfonts/liberation-fonts | OFL-1.1                  |
| GNU FreeFont      | 12   | github.com/gnu-freefont                     | GPL-3.0 + font exception |
| Tinos             | 8    | github.com/liberationfonts                  | OFL-1.1                  |
| OpenSymbol        | 1    | LibreOffice                                 | OFL-1.1                  |

**三个上游仓库均可访问**（实测 200）：Sarasa-Gothic / LxgwWenKai / noto-cjk 的 releases 页。

## 四、体积问题（关键约束）

**实测单个 CJK 字体的体积**（本机已装字体）：

| 字体                  | 体积        |
| --------------------- | ----------- |
| LXGWWenKai Mono Light | **27.0 MB** |
| LXGWWenKai Light      | 27.0 MB     |
| NotoSerifCJK Bold     | 26.1 MB     |
| NotoSansCJK 系列      | ~25 MB/个   |

**估算**：
| 方案 | 体积 |
| --- | --- |
| 官方 80 个字体全量 | **300-500 MB** |
| 只取 4-5 个常用中文字体 | **50-60 MB** |
| 只取 2 个（Sans + Serif 各一） | **~30 MB** |

→ **全量下载不现实**（用户首次使用时下载 300-500 MB 体验很差）。

## 五、设计方案

### 5.1 分层策略

| 层级     | 内容                                             | 体积   | 时机                       |
| -------- | ------------------------------------------------ | ------ | -------------------------- |
| **基础** | 系统已有字体                                     | 0      | 直接使用                   |
| **推荐** | 2 个中文字体（Noto Sans SC + Noto Serif SC）     | ~30 MB | 首次生成中文文档时提示下载 |
| **可选** | 其余字体（LXGW WenKai / Sarasa Mono / 拉丁字体） | 按需   | 设置页手动勾选             |

**核心原则**：**优先用系统字体**（DSH skill 已要求「Local-font-first」），只在缺失时提示下载。

### 5.2 字体源

**方案 A（推荐）：GitHub Release 托管**

在 `Zcode-CE/Zcode-CE` 的 Release 里附一个字体包：

- 名称：`zcode-ce-fonts-<version>.tar.zst`
- 内容：精选字体（不是全量 80 个）
- 许可：随包附各字体的 LICENSE 文件
- **优点**：与更新渠道同一来源，可控；国内可访问（GitHub 时好时坏，但比官方 CDN 已死好）

**方案 B：直接从各字体上游下载**

- 从 `github.com/notofonts/noto-cjk/releases` 等拉取
- **缺点**：需要处理 3-4 个不同上游的 URL 与命名差异

**方案 C：不下载，只用系统字体**

- 零体积、零网络
- **缺点**：Linux 精简环境可能没有中文字体，生成的文档会缺字

**建议**：**A 为主 + C 兜底**。系统有字体就用系统；没有则提示从我们的 Release 下载。

### 5.3 实现要点

| 项              | 说明                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------- |
| **marker 文件** | 沿用官方的 `.zcode-office-fonts-installed`（防重复下载）                                            |
| **安装位置**    | Linux `~/.local/share/fonts`（用户级，不需 root）；Windows `%LOCALAPPDATA%\Microsoft\Windows\Fonts` |
| **字体缓存**    | Linux 需 `fc-cache -f`；Windows 需注册表或 `AddFontResource`                                        |
| **失败降级**    | 下载失败**不阻断**文档生成，只提示「未安装中文字体，可能缺字」                                      |
| **体积提示**    | 下载前告知用户体积（官方脚本没做，我们要做）                                                        |
| **进度反馈**    | 大文件下载需要进度（官方用 curl 无进度）                                                            |

### 5.4 与 skill 的集成

DSH skill 的 `SKILL.md` 已要求：

> Local-font-first. Inspect fonts available in the user's local environment and prefer a suitable installed font. Use bundled or downloaded fonts only as fallbacks; **do not install fonts without the user's confirmation**.

→ **必须在用户确认后才下载**，不能静默安装。

## 六、未决问题

1. **字体包内容**：精选哪些？（建议：Noto Sans SC + Noto Serif SC + LXGW WenKai，覆盖正文/标题/手写风格）
2. **是否需要 Latin 字体**：DejaVu / Liberation 在多数系统已有，可能不需要
3. **Windows 的字体安装机制**：用户级安装（不需管理员）的实现方式待确认
4. **是否需要镜像加速**：国内用户从 GitHub 下载可能慢，是否提供镜像（如 jsDelivr / 国内 CDN）
