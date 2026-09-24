# CJK 字体供给

> 状态：已定方案 · 2026-09-21
> 结论：跟随官方的 Local-font-first 策略，不自建字体分发。

## 一、结论先行

**不下载、不打包、不自建字体源。** 优先使用用户系统已安装的字体；缺失时提示用户自行安装。

理由见下。

## 二、官方策略（实测确认）

官方 `documents-plugin/skills/docx/SKILL.md` 明确要求：

> **Local-font-first.** Inspect fonts available in the user's local environment and prefer a suitable
> installed font. Use bundled or downloaded fonts only as fallbacks; **do not install fonts without the
> user's confirmation**.

证据链：

| 证据                                     | 结果                                         |
| ---------------------------------------- | -------------------------------------------- |
| 官方 `documents-plugin` 内的字体文件数   | **0**（不含任何 `.ttf`/`.otf`/`.ttc`）       |
| `SKILL.md` 是否引用 `setup_mac_linux.sh` | **0 处**（该脚本无人调用）                   |
| 该脚本里的 `FONT_CDN_BASE` 可达性        | **404 `NoSuchKey`**（阿里云 OSS 对象不存在） |

`setup_mac_linux.sh` 是官方遗留的废弃脚本，其中的字体 CDN 地址已失效。官方当前的实际做法是**用系统字体**。

### 为什么可以确认是「路径废弃」而非「鉴权拦截」

OSS 返回的是对象级错误，不是权限错误：

```xml
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <HostId>glm-chat.oss-cn-hongkong.aliyuncs.com</HostId>
  <Key>office-skill/fonts</Key>
</Error>
```

- 若需鉴权 → 返回 `AccessDenied` 或 `403`
- `NoSuchKey` 说明请求**已通过全部校验**，只是对象不存在

实测四种请求头（裸 curl / `User-Agent` / `X-Device-Mid` / `Referer`）**全部 404**，排除了请求头校验的可能。

## 三、系统字体覆盖率

| 平台                 | 默认 CJK 字体                                    |
| -------------------- | ------------------------------------------------ |
| Linux（GNOME / KDE） | Noto Sans CJK / Noto Serif CJK（发行版默认安装） |
| Windows              | 微软雅黑（Microsoft YaHei）、宋体、黑体          |
| macOS                | 苹方（PingFang SC）、华文系列                    |

**覆盖率足够**：桌面发行版默认安装 CJK 字体，生成中文文档不需要额外下载。

## 四、实现要求

| 项                 | 要求                                                     |
| ------------------ | -------------------------------------------------------- |
| **优先**           | 使用系统已安装字体（`fc-list :lang=zh` / 平台等价 API）  |
| **缺失时**         | **提示用户**，说明缺少哪些字体、如何安装；**不静默下载** |
| **不打包**         | 不随发行版分发字体（避免体积膨胀与许可清单复杂化）       |
| **不依赖官方 CDN** | 该地址已失效（见上）                                     |

## 五、如需兜底（未来可选项）

若实测发现某些环境确实缺字，再考虑：从各字体上游（Noto / Sarasa / LXGW，均为 OFL-1.1）按需下载，并在用户确认后安装。**当前不实现。**

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

所有具体字体文件都是 404。 因此**不能依赖官方 CDN**。

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

实测单个 CJK 字体的体积（本机已装字体）：

| 字体                  | 体积        |
| --------------------- | ----------- |
| LXGWWenKai Mono Light | **27.0 MB** |
| LXGWWenKai Light      | 27.0 MB     |
| NotoSerifCJK Bold     | 26.1 MB     |
| NotoSansCJK 系列      | ~25 MB/个   |

估算：
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

**核心原则**：优先用系统字体（DSH skill 已要求「Local-font-first」），只在缺失时提示下载。

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
