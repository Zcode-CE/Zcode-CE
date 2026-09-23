# PDF 插件：来源、载荷、校验器与降级边界

本文规定 `apps/zcode-cli/packages/pdf-plugin` 这个**自研**插件的载荷构成、注册闸门、校验器契约与降级边界，以及它引用的第三方材料如何登记。配套：[PDF 制作可行性](../.reverse/38-pdf/PDF-FEASIBILITY.md)（选型与实测数据）、[PDF 规格](../.reverse/38-pdf/PDF-SPEC.md)、[提交形态](../.reverse/38-pdf/COMMIT-SHAPE.md)、[task-9 报告](../.reverse/38-pdf/TASK9-REPORT.md)。

## 1. 来源与归属（逐文件）

| 文件                                                                           | 来源                   | 许可                   | 说明                                                                       |
| ------------------------------------------------------------------------------ | ---------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `.zcode-plugin/plugin.json`、`package.json`                                    | `self`                 | Apache-2.0（随本仓库） | 本仓库插件清单与包元数据                                                   |
| `skills/pdf/SKILL.md`                                                          | `self`                 | 随本仓库               | 技能正文：载荷路径、字体策略、构建、校验、边界                             |
| `agents/visual-judge.md`                                                       | `self`                 | 随本仓库               | 与 documents / presentations / spreadsheets 三份**逐字节相同**（四份同源） |
| `scripts/pdf-build.mjs`、`scripts/lib/pdf-render.mjs`                          | `self`                 | 随本仓库               | 声明式 JSON → PDF 的生成器与布局                                           |
| `scripts/check_pdf.mjs`、`scripts/lib/{pdf-structure,pdf-text,pdf-checks}.mjs` | `self`                 | 随本仓库               | 零第三方依赖的结构校验器（契约见 §4）                                      |
| `scripts/pdf-fonts.mjs`                                                        | `self`                 | 随本仓库               | 系统字体发现与 `.ttc` 面解析                                               |
| `scripts/pdf-node/{pdfkit,fontkit}.cjs`                                        | **构建产物**（不入库） | MIT（见 §5）           | esbuild 自包含 bundle，由打包链 stage                                      |

**本插件不复制任何官方 ZCode 发行包内容**（官方 `pdf` 插件授权禁止商用，见 `official-diff.md`）。技能正文与脚本均自研。

## 2. 载荷：是什么、落在哪、怎么构建

- 两个库：`pdfkit@0.17.1`（流式排版/自动分页/字体子集嵌入，**无需 node_modules**）、`fontkit@2.0.4`（解析系统字体文件：列面、判可变字体、测字形覆盖）。
- 构建：`packages/desktop/scripts/pdf-node-payload-assets.mjs` 用 esbuild 打成 CJS 自包含 bundle，落 `<plugin>/scripts/pdf-node/`。体积实测：`pdfkit.cjs` **2,534,071 B**、`fontkit.cjs` **1,979,112 B**。
- 三条自包含断言（复用 `office-node-payload-assets.mjs`）：非内置 `require` 为 0、无真实动态 `require`、**pdfkit 必须内联 fontkit**。
- **构建期 API 断言**：require 刚落盘的产物并校验 `fontkit.openSync` / `pdfkit` 构造器存在。这条是实跑踩出来的 —— `fontkit@2.0.4` 同时有 `exports.node.require`（Node 构建）与顶层 `exports.require`（**浏览器构建**，没有 `openSync`），取错一个仍能打包、能 require，但字体发现永远"找不到字体"，用户看到的是**假诊断**（"系统缺中文字体"）。
- 三处接线（顺序都必须在官方插件 staging **之后**，否则 `cpSync` 会覆盖）：
  - 桌面打包：`packages/desktop/scripts/prepare-agent-node-bundle.mjs`
  - 远端预构建：`scripts/prepare-prebuilds.mjs`（`stageRemotePdfNodePayloads`）
  - dev 链：`packages/desktop/scripts/dev-agent-payloads.mjs`（落 `apps/zcode-cli/packages/cli/dist/packages/pdf-plugin`）

## 3. 注册闸门：载荷缺失 ⇒ 插件不出现

`bootstrap/src/app/official-plugin-definitions.ts` 的 `OFFICIAL_PDF_EXTRA_REQUIRED_SEED_PATHS` 把**两个载荷 + 三个入口**（`pdf-build.mjs`、`check_pdf.mjs`、`pdf-fonts.mjs`）钉进 `requiredSeedPaths`：缺任何一项，seed 拒绝写缓存并记 `ZCODE_PLUGIN_SEED_INCOMPLETE`（`bundled-plugins.ts`），用户看不到插件。**不钉 `lib/*.mjs` 内部实现文件** —— 入口缺文件会以可读错误暴露，而多钉一层会把"重命名内部文件"变成"插件静默不出现"的新失效形态。

为什么需要这条闸门：实测（[`COMMIT-SHAPE.md`](../.reverse/38-pdf/COMMIT-SHAPE.md)）只提交目录与清单就能让插件显示为 `[enabled]`，而首次调用必然 `MODULE_NOT_FOUND`。

## 4. 校验器契约（`check_pdf.mjs`）

- stdout 一行 JSON：`{format:"pdf", verdict:"pass"|"fail", checks:[{id,status,detail?}], summary}`；非 ASCII 转义（同 `check_office` 口径）；退出码 **0 通过 / 1 检查失败或读取失败 / 2 参数错误**（含 `--out`）。
- 检查项与"为什么它能被静默违反"：`package`（结构损坏阅读器仍能显示）、`catalog`、`pages`（`--count` 断言；页脚越界会被 PDFKit **静默加页**，实测 2 页变 4 页）、`page-tree`（`/Count` 与实际页对象不一致）、`page-size`、`fonts`（未嵌入 ⇒ 换机器变字体；缺 `/ToUnicode` ⇒ 画面正确但**不可检索/复制**；无子集前缀 ⇒ 整字体嵌入）、`contains` / `glyphs`（`--text`：源文本每个非 ASCII 码点必须出现在文本层 —— 缺字形时 PDFKit **不报错**）、`visual`（**本工具不做视觉检查**，默认在 `summary.visualCheck = "not_performed"` 留痕；`--require-visual` 时判 fail）。
- 支持边界：只解析**经典交叉引用表**（PDFKit 产物口径）。xref 流/对象流的 PDF 会得到结构化失败（不是静默放行）；逃生通道 `qpdf --object-streams=disable in.pdf out.pdf`。
- 回归测试：`test/checkPdf.test.mjs`（11 条，零第三方依赖的自造夹具；含"bfrange 目标数组含多码元项不得错位"的反向断言），已在 `scripts/run-tests.mjs` 登记。

## 5. 许可登记

- `pdfkit`（MIT）、`fontkit`（MIT）作为 `pdf-plugin/package.json` 的**构建期依赖**进仓库安装树；随包分发的是 bundle。
- `scripts/licenses.mjs` 的 `MANUAL_LICENSE` 登记 `png-js: "MIT"`（包内 LICENSE 为 MIT 全文；package.json 无 license 字段）。
- `third-party/npm-overrides.json` 新增四条：`fontkit@2.0.4`、`brotli@1.3.3`、`dfa@1.2.0`（npm 包内与上游仓库均无独立 LICENSE ⇒ 按既有 `publisher-license-identifier-and-standard-terms` 约定登记标准 MIT 全文 + npm tarball sha256）、`png-js@1.1.0`（包内 LICENSE 即上游文本，登记 `packaged-license-file`）。
- 生成物：`node scripts/licenses.mjs notices` → `THIRD-PARTY-NOTICES.md`；门禁 `node scripts/licenses.mjs check`（本仓当前绿）。
- **未引入随包字体**，因此**没有 OFL 与 Reserved Font Name 义务**。若将来随包 OFL 子集字体：必须改字体名（Noto 是 RFN）+ 附 OFL 全文与版权声明，并同步登记。

## 6. 字体策略与降级边界

- **系统字体优先**：只扫 `/usr/share/fonts` 等常规目录（Win/mac 各有对应目录），按文件名/语言/字重偏好排序后测覆盖；实测 229 ms 选中 `NotoSansCJKsc-Regular`（无差别遍历 752 ms 且会选到日文/最重面）。`.ttc` 必须给 **PostScript 面名**；**可变字体直接排除**（注册必抛）。
- **缺失 ⇒ 失败关闭**：`pdf-build.mjs` 先做覆盖检查，缺字则输出缺字清单 + 各平台安装命令 + "不要用拉丁字体凑合"，**不产出任何文件**；渲染后还用 `check_pdf --text` 从产物侧复核一次（两道：写文件前 + 最终消费点）。
- **无粗体面时如实声明**：`boldFallback: true` + `degradation` 字段（PDFKit 无合成粗体）。
- **视觉检查是可选增强**：本链路只做结构检查；需要目视时用外部渲染器（LibreOffice/Ghostscript/Poppler）渲成 PNG 再交给 `visual-judge`，没有渲染器就**如实说明未做**。
- 不代装任何东西（含字体/渲染器/TeX）；给出命令由用户自己执行，并保留用户用 Word/WPS 等已有软件完成同类任务的自由。

## 7. 验收命令

```bash
# 校验器契约（无需载荷）
cd apps/zcode-cli/packages/pdf-plugin && node --test test/checkPdf.test.mjs

# 从零生成（需载荷；<CACHE> = seed 后的插件目录，或 dev 的 cli/dist/packages/pdf-plugin）
node <CACHE>/scripts/pdf-build.mjs --in report.json --out report.pdf
# 成功输出：{ok:true, pages, bytes, fonts, verify:{verdict:"pass", ...}}；失败一律不产出文件

# 独立复核
qpdf --check report.pdf && pdfinfo report.pdf && pdffonts report.pdf && pdftotext report.pdf - | head
```

## 8. 未验证项

- macOS / Windows 的字体目录与 `.ttc` 行为（字体发现只在 Linux 实测）；
- Electron 桌面壳内的实际调用（打包链与 CLI seed+生成链路均已实跑通过）；
- 峰值内存回归测试（校验器目前只有输入上界）；
- LaTeX/公式链路与视觉渲染链路（未实现）。
