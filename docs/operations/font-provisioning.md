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

若实测发现某些环境确实缺字，再考虑从各字体上游（Noto / Sarasa / LXGW，均为 OFL-1.1）按需下载，并**在用户确认后**
安装（下载前告知体积；失败不阻断文档生成）。**当前不实现**，也不依赖官方 CDN（该地址已失效，见 §二）。

安装位置（若实现）：Linux `~/.local/share/fonts`（用户级，不需 root；`fc-cache -f` 刷新缓存）、
macOS `~/Library/Fonts`、Windows `%LOCALAPPDATA%\Microsoft\Windows\Fonts`。

## 六、字体许可（调研结论）

官方废弃脚本列出的 80 个字体全部是开源许可：OFL-1.1 为主（Sarasa Mono SC、Noto Sans/Serif SC、LXGW WenKai、
Liberation、Tinos、OpenSymbol），另有 DejaVu（Bitstream Vera）与 WenQuanYi Zen Hei / GNU FreeFont（GPL + font exception）——
许可档位不齐是「不打包」的依据之一。三个上游仓库 Sarasa-Gothic / LxgwWenKai / noto-cjk 均可访问（实测 200）。

## 七、体积（关键约束）

实测单个 CJK 字体 25–27 MB（LXGW WenKai、Noto Sans/Serif CJK 同量级）。据此估算：80 个全量约 **300–500 MB**，
只取 2 个（Sans + Serif 各一）约 **30 MB** ⇒ **全量下载不现实**，这是「不下载、不打包」的一条依据。
