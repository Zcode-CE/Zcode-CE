# 办公插件：来源标注与归属

本文规定 `apps/zcode-cli/packages/{documents,presentations,spreadsheets}-plugin` 三个插件里**每个文件的来源如何标注**，以及在「Node 自研打底 + Python 按需增强」的混合方案下如何跟进上游。**规范部分是可执行、可检查的**：照它写，`licenses:check` 门禁与归属文档都不会漂移。

## 1. 为什么要立规矩

三个插件目录里同时存在四类来源，不标注就无法判断「这个文件能不能自由改」「上游更新要不要跟」：

| 类别                   | 例子                                                                                               | 风险                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| DSH 派生（逐字节）     | ——                                                                                                 | 本地改动会被上游更新静默覆盖                             |
| DSH 派生（**已分叉**） | `scripts/check_office.py`                                                                          | 最危险：上游更新与本地修复冲突，且冲突点在「安全边界」上 |
| 本项目自研             | `agents/visual-judge.md`、`test/checkOffice.test.mjs`、`scripts/check_office.mjs`（+ `lib/*.mjs`） | 被误当成上游文件而不敢改，或反向被上游覆盖               |
| 即将新增的 Node 自研   | 混合方案的 Node 部分                                                                               | 落地时无对号入座的位置（OFFICE-5 起已落地，见 §7bis）    |

## 2. 来源分类与对应义务（规范）

| 分类 id             | 含义                       | 典型许可                    | 跟上游？                | 改动后要重跑声明？                                             | 机器可读登记                                       |
| ------------------- | -------------------------- | --------------------------- | ----------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `upstream-dsh`      | 与 DSH 上游**逐字节相同**  | MIT                         | ✅ 每次 DSH 发版都 diff | ✅（文件在 `copied-components` 的 `roots` 内，哈希是门禁输入） | `roots` 覆盖即可，不需额外字段                     |
| `derived-from-dsh`  | 从某个 DSH 文件改出来的    | MIT                         | ⚠️ 逐条判断能否合并     | ✅                                                             | `locallyModifiedFiles`                             |
| `derived-apache`    | 从 Apache-2.0 来源改出来的 | Apache-2.0                  | ⚠️ 同上                 | ✅                                                             | `modifiedFiles` + 文件内 `Modified by ZCode:` 标记 |
| `upstream-official` | 来自官方 ZCode 发行包      | 受限（Office 原版禁商用等） | 只作行为参考            | ✅（若确实复制）                                               | 单独的 `copied-components` 条目                    |
| `self`              | 本项目自研                 | 随本仓库（Apache-2.0）      | ❌ 不跟                 | ✅（只要文件落在 `roots` 内）                                  | 无需许可登记字段；文档里标注即可                   |

**判据**：

- 「跟不跟上游」由**是否逐字节相同或派生**决定，与文件大小无关。
- 「要不要重跑声明」由**文件是否位于某个 `copied-components` 条目的 `roots` 目录内**决定 —— 三个插件目录整体都在 `DeepSeek Harness skill-office` 条目的 `roots` 里，所以**这三个目录里任何文件的任何字节改动都会让 `licenses:check` 变红**，必须重跑声明（见 §5）。

## 3. 每个文件必须携带什么（可检查）

### 3.1 Markdown 技能/代理文件（`skills/*/SKILL.md`、`agents/*.md`）

用 YAML frontmatter 的 `metadata` 段。既有范例（三个 SKILL.md 已按此写）：

```yaml
---
name: docx
description: ...
metadata:
  upstream: "@deepseek-ai/dsh-skill-office (MIT)"
  modified: "ZCode-CE: 工具引用改为系统 Python 与文件路径交付，见 NOTICE.md"
---
```

- `upstream`：**上游包名 + 许可**，必要时补上游内的相对路径。
- `modified`：一句话说清本地改了什么；自研文件**不写**这两个键（`agents/visual-judge.md` 就是不自称上游的例子）。

### 3.2 代码文件（`.py`、`.mjs`）

在文件头注释块里给四个字段（`check_office.py` 已按此写，见 §4）：

```text
Upstream:  <包名> (<许可>) + 上游内相对路径
Baseline:  <字节数>, sha256 <上游文件哈希>（<上游版本/快照时刻>）
Modified:  ZCode-CE，<是否已分叉>
Local changes: <逐条摘要；注明是否追加式>
```

### 3.3 目录级

- **不写「本目录全部来自 X」这种断言** —— 多来源同目录是常态，以文件级标注为准。
- 目录级只允许两种形式：插件清单（`.zcode-plugin/plugin.json`）与本文档 §6 的总表。
- 机器可读事实源是 `third-party/copied-components.json`。**文档与登记条目冲突时，以登记条目为准并修正文档**。

## 4. 分叉文件的处理：基线 + 分叉点 + 本地改动

对 `derived-*` 文件，必须能回答「上游更新能不能合进来」。约定：

1. **记录基线身份**：上游文件的**字节数 + sha256 + 上游版本**（不依赖本地路径，外部读者也能核对）。
2. **记录本地改动摘要**：逐条写清做了什么、为什么（例如安全修复）。
3. **只做追加式修改**：优先**新增**常量/类/函数，不改上游函数签名与语义。这样上游更新可按「上游函数清单 vs 本地清单」直接比对后手工合并。
4. **若必须改上游函数体**：在 `Local changes` 里**点名函数**，并注明「非追加式改动，合并上游时需逐行核对」。
5. **同名副本必须保持一致**：`scripts/check_office.py` 与 `scripts/check_office.mjs`（含 `scripts/lib/*.mjs` 共 10 个文件）在三个插件里**各有一份且逐字节相同**；改一处就要同步三处，否则 §6 的表格与脚本自检都不成立。

   校验方式（快照 2026-09-23，三份全部一致）：

   ```bash
   cd apps/zcode-cli/packages
   for f in check_office.mjs lib/office-spec.mjs lib/office-zip.mjs lib/office-xml-lex.mjs \
            lib/office-xml-decl.mjs lib/office-xml-tree.mjs lib/office-xml-scan.mjs \
            lib/office-parts.mjs lib/office-cli.mjs lib/office-main.mjs; do
     a=$(sha256sum documents-plugin/scripts/$f | cut -d' ' -f1)
     b=$(sha256sum presentations-plugin/scripts/$f | cut -d' ' -f1)
     c=$(sha256sum spreadsheets-plugin/scripts/$f | cut -d' ' -f1)
     [ "$a" = "$b" ] && [ "$b" = "$c" ] && echo "OK   $f" || echo "DIFF $f"
   done
   ```

   该约束已被回归测试锁死：`test/checkOffice.test.mjs` 的「三份 check_office.py / check_office.mjs（含 lib/ 模块）逐字节一致」用例逐文件比 sha256，改一处不同步三处会直接失败。**这是 .py 既有约束的同型继承**（.py 三份亦逐字节相同）。

**核对上游差异的方法**（把 `$UPSTREAM` 换成本地 DSH 检出或解包目录）：

```bash
# 结构与函数清单差异（先看这里，判断是否追加式）
diff <(grep -n "^def \|^class \|^MAX_\|^[A-Z_]* = " "$UPSTREAM/check_office.py") \
     <(grep -n "^def \|^class \|^MAX_\|^[A-Z_]* = " apps/zcode-cli/packages/documents-plugin/scripts/check_office.py)
# 逐行差异
diff "$UPSTREAM/check_office.py" apps/zcode-cli/packages/documents-plugin/scripts/check_office.py
```

## 4bis. 资源预算类加固的判据：**常量 ≠ 内存有界**

对任何「读不可信文件」的校验器，只把 `MAX_*` 常量写对**不足以**让峰值内存受约束。这条判据来自 OFFICE-5 的实测：第一版 JS 重写**完整保留**了 4 个 `MAX_*` 与分块解析，峰值 RSS 仍是 Python 版的数倍。

**可复现的实测数字**（`/usr/bin/time` 口径的峰值 RSS；测量方法见 `.reverse/28-office-provenance/OFFICE-CHECKER-JS.md` §5.2）：

| 夹具                                         |     .py |    正确实现 |   还原根因后 |
| -------------------------------------------- | ------: | ----------: | -----------: |
| 元素密集（300 万元素，声明体积在字节预算内） | 240 MiB | **332 MiB** | **1160 MiB** |
| 160 MB 媒体（小 XML + 大 media）             |  21 MiB | **126 MiB** |  **252 MiB** |
| Node 空进程基线                              |      —— |      46 MiB |       46 MiB |

两个根因都**不在常量上**：

| 根因                   | 为什么常量拦不住                                                                                                                                                | 判据（实现时必须满足）                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **每个元素的常驻开销** | 元素预算约束的是「元素**个数**」，不是「每个元素多大」。给每个元素挂一个 `Map`（作用域）或 `Map`（属性）时，2,000,000 元素的常驻内存可以远超 .py 的 ElementTree | 元素/节点的**单实例开销要压到最低**：作用域用「链式 + 只在声明 `xmlns` 处挂帧」而非逐元素复制；属性用扁平数组而非 `Map`；`children`/`attrib` 按需创建（叶子元素不付代价） |
| **整包读入内存**       | 包体积**不受**任何 `MAX_*` 约束（媒体成员不进预算，这是刻意的）。整包 `readFileSync` 等于让「不进预算的字节」也占内存                                           | 只读**中央目录 + 当前成员所需的字节**（`fd` + `readSync` 分块），其余留在磁盘上；`testzip` 那趟只累加 CRC、不保留分块                                                     |

**验收要求（两条都要有，缺一不可）**：

1. **峰值内存回归测试**：对元素密集夹具断言峰值 RSS 上限。OFFICE-5 的写法见 `documents-plugin/test/checkOffice.test.mjs` 的「元素密集输入的峰值内存受元素预算约束」用例（阈值 `MAX_DENSE_PEAK_MIB = 500`；正确实现实测 281~285 MiB，还原根因后 713~717 MiB）。
   **阈值必须对着可复现的回归值标定，并做变异验证**：OFFICE-5 最初把阈值写成 900 MiB，而还原根因后只到 713~717 MiB —— 该回归能**蒙混过关**，断言等于没有。改到 500 后，把还原版装回去跑测试会**真的失败**（`实际 714 MiB`），这才算有效断言。
   **注意 Node 不能套用 `RLIMIT_AS`**：V8 启动即预留大段虚拟地址空间，`RLIMIT_AS=512 MiB` 下连 `node --version` 都跑不起来（`rc=-5`，`Fatal process out of memory: SegmentedTable::InitializeTable`；实测 2 GiB 才够）。Python 侧用 `RLIMIT_AS` 硬上限，Node 侧用 `--max-old-space-size` 限堆 **+ 断言「进程活着且给出结构化输出」**。
2. **与基准实现的峰值对比**：保留一份基准（本目录就是 `.py`）并实测同一夹具的峰值 RSS，量级差距要能解释。**注意把运行时基线单列**：Node 空进程本身约 46 MiB（V8 堆 + 运行时），所以「JS 比 .py 高几十 MiB」在正确实现上是正常的；要盯的是**随输入规模放大的那部分**（上表里 dense 从 240 → 332 MiB 属正常，到 1160 MiB 就是失控）。

**为什么单独立这条判据**：`task-58`/`task-60` 的判据只写到「保留 4 个 `MAX_*` + 分块解析」，照着做**会**得到一个内存不受约束的实现 —— 判据不足会让后人做出错误决定，与代码缺陷同级。

## 5. 与许可门禁的对齐：`modifiedFiles` 与 `locallyModifiedFiles`

改完目录内任何文件后**必须**：

```bash
node scripts/licenses.mjs notices   # 重新生成 THIRD-PARTY-NOTICES.md 与 third-party/inventory.json
node scripts/licenses.mjs check      # 门禁：输入哈希 + 许可分桶
```

不重跑就会看到 `Third-party input changed: <file>. Run node scripts/licenses.mjs notices` —— 这是**输入新鲜度**门禁，不是错误配置。

两个字段的判据（选错会直接抛错）：

| 字段                   | 生成器行为                                                                                                                                                                     | 用在什么许可上                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `modifiedFiles`        | `scripts/generate-third-party-notices.mjs` 要求**每个文件正文内**含字面量 `Modified by ZCode:`，否则抛 `Missing file-local modification notice`；还会校验文件必须在 `roots` 内 | **Apache-2.0** 路径（4(b) 要求文件内变更声明）   |
| `locallyModifiedFiles` | 自定义字段，随记录写入 `third-party/inventory.json`，**不读文件正文、不要求标记**                                                                                              | **MIT / BSD / ISC** 等不要求文件内变更声明的材料 |

**结论**：办公三件套与 CUA 插件壳都是 MIT ⇒ 用 `locallyModifiedFiles`，**不要**为了过门禁往 MIT 正文里塞 `Modified by ZCode:` 标记（既无义务，也会污染技能正文）。反过来，Apache-2.0 派生文件**必须**用 `modifiedFiles` 并在文件内加标记。

## 6. 逐文件清单（三件套，快照：2026-09-23）

三个插件目录结构一致，差异只在技能与插件清单；下表按 `documents` 列文件，其余两个同名。

| 文件                                             | 来源                             | 许可                   | 本地改动                                                                                                                                                                                                                                                                 | 跟进方式                                                      |
| ------------------------------------------------ | -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `skills/{docx,pptx,xlsx}/SKILL.md`               | `derived-from-dsh`               | MIT                    | frontmatter `metadata.modified`：工具链由**系统 Python(python-docx) 改为随包 Node 库**（docx 9.7.1 / pptxgenjs 4.0.1 / exceljs 4.4.0）；校验器相对路径修正为 `../../scripts/`；补充降级边界；**提权安装场景给出确切命令并声明所需权限**（引导式授权，task-71，见 §7ter） | 上游同名文件每次发版都 diff；**不能整体覆盖**（我们已改口径） |
| `agents/visual-judge.md`                         | `self`                           | 随本仓库               | 本项目独立实现（三份逐字节相同）                                                                                                                                                                                                                                         | 不跟上游                                                      |
| `scripts/check_office.py`                        | `derived-from-dsh`（**已分叉**） | MIT                    | 追加式安全修复：成员白名单、4 个 `MAX_*` 预算、`PackageBudget`、分块解析、`except` 补 `LookupError`（见 §7）                                                                                                                                                             | 上游更新需按 §4 手工合并；改一处同步三处                      |
| `scripts/check_office.mjs` + `scripts/lib/*.mjs` | `self`                           | 随本仓库               | OFFICE-5 的 Node 重写（主路径）：契约与 .py 逐项一致；按 `apps/zcode-cli/AGENTS.md` 的 400 行上限拆成 10 个文件（见 §7bis）                                                                                                                                              | 不跟上游；但**必须与 .py 保持契约一致**，改一边核对另一边     |
| `test/checkOffice.test.mjs`（仅 documents）      | `self`                           | 随本仓库               | 上述安全修复的回归测试；OFFICE-5 起**两条实现路径同型断言**（4 条预算用例 × 2 路径）                                                                                                                                                                                     | 不跟上游；改动脚本行为时要同步                                |
| `.zcode-plugin/plugin.json`、`package.json`      | `self`                           | 随本仓库               | ZCode 插件清单与包元数据（本仓库布局，非上游布局）                                                                                                                                                                                                                       | 不跟上游                                                      |
| `LICENSE.dsh`                                    | `upstream-dsh` 的许可文本副本    | MIT（© 2026 DeepSeek） | 无                                                                                                                                                                                                                                                                       | 上游许可变更时同步                                            |

**机器可读登记**：`third-party/copied-components.json` 的 `DeepSeek Harness skill-office` 条目 —— `roots` 覆盖三个插件目录，`license: MIT`，`scope` 里写明技能目录改名（`assets/`→`skills/`）与 `visual-judge.md` 属独立实现；`locallyModifiedFiles` 列出 §7 的分叉文件。**改本文档时同步检查该条目。**

## 7. `scripts/check_office.py` 的分叉记录

| 项                      | 值                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游                    | `@deepseek-ai/dsh-skill-office` (MIT)，`packages/skill/skill-office/assets/scripts/check_office.py`                                                                                                                                                                                                                                                                                                                          |
| 基线（快照 2026-09-23） | **13,217 字节**，sha256 `d94afa67593a284751e0f2dc000877e836f885d39954a882033cf22a13278f66`（deepseek-harness `0.1.7-alpha.2`；`0.1.6` 起该文件未变）                                                                                                                                                                                                                                                                         |
| 本地（三份逐字节相同）  | **22,082 字节**，sha256 `e45c2759654ca819fbe4fda4e6ff18dd52563472776bbeb109eb86eb1f6fe358`（含来源标注头与 2026-09-23 的 `LookupError` 修复）                                                                                                                                                                                                                                                                                |
| 改动性质                | **追加式**：上游的 `def`/`class` 清单是本地清单的子集，未改上游函数签名与语义 ⇒ 上游更新可手工合并                                                                                                                                                                                                                                                                                                                           |
| 改动内容                | ⓪ 2026-09-23：文件头加入来源/基线/分叉标注（纯注释，不改行为，四份字段见 §3.2）；① 成员白名单 `XML_MEMBER_SUFFIXES` + `is_xml_member()`；② 资源预算 `MAX_MEMBER_BYTES`(64 MiB)、`MAX_TOTAL_BYTES`(256 MiB)、`MAX_MEMBER_ELEMENTS`(2,000,000)、`MAX_TOTAL_ELEMENTS`(4,000,000) 与 `class PackageBudget`；③ 分块解析 `PARSE_CHUNK_BYTES`(1 MiB)，失败也输出结构化错误；④ **2026-09-23：`except` 列表补 `LookupError`**（见下） |
| ④ 的动因                | 成员声明未知编码（`encoding="NO-SUCH-ENCODING"`）时 ET 抛 `LookupError`，它既不是 `ValueError` 也不是 `OSError`，**不在原 except 列表里** ⇒ 实测「退出码 1 + 空 stdout + 裸 traceback」，正是 ③ 要消灭的形态。`IndexError` 同为 `LookupError` 子类，一并覆盖。JS 版无此洞（一律结构化 fail），详见 `.reverse/28-office-provenance/OFFICE-CHECKER-JS.md` §5.4                                                                 |
| **本文件的状态**        | **保留实现，不是主路径**：技能正文只引用 `check_office.mjs`。保留两个理由：① 作为 JS 重写的**行为基准**（OFFICE-5 的 455 例契约对比与多轮 fuzz 都以它为准）；② §8 把 Python 定位为「按需增强」路径。**因此它必须与 .mjs 保持契约一致**，不是「没人用的死文件」                                                                                                                                                               |
| 动因                    | `check_office.py` 的调用方是模型，输入来自用户文件或网络下载，属不可信输入。修复前对解压体积**没有任何上限**：实测 2.09 MB 的 ZIP 可解出 2 GiB、子进程峰值 RSS 4,116 MiB；且大夹具上 `OverflowError` 逃逸导致「退出码 1 但 stdout 为空」，调用方无法区分「文档不合法」与「检查器崩了」                                                                                                                                       |
| 回归测试                | `apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs`                                                                                                                                                                                                                                                                                                                                                         |

## 7bis. `scripts/check_office.mjs`（+ `lib/*.mjs`）的记录

**归属 `self`**：本项目自研，不是 DSH 上游文件，不回写上游、不跟 DSH 发版。**但它有一个上游血统的参照物 —— 同目录的 `check_office.py`**，两者的关系是「重写并保持契约一致」，所以改动时必须两边核对。

| 项                      | 值                                                                                                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 落点                    | `scripts/check_office.mjs` + `scripts/lib/*.mjs`（三插件各一份，逐字节相同，见 §4.5）                                                                                                                                                                                         |
| 规模（快照 2026-09-23） | **10 个文件 / 80,058 字节 / 1,986 行**；对照 `.py` 的 1 个文件 / 22,082 字节 / 418 行                                                                                                                                                                                         |
| 依赖                    | **零第三方依赖**，只用 `node:fs` / `node:path` / `node:process` / `node:zlib`（理由同 `.py` 只用标准库：插件随包分发，多一个依赖就多一份体积与许可负担）                                                                                                                      |
| 对外契约                | 与 `.py` **逐项一致**：输出 `{format, verdict, checks, summary}`、退出码 0/1/2、4 个 `MAX_*` 常量、媒体不计入读内存预算、失败必带非空 `detail`。逐项对照表见 `.reverse/28-office-provenance/OFFICE-CHECKER-JS.md` §2                                                          |
| 为什么拆 10 个文件      | `apps/zcode-cli/AGENTS.md` 规定单文件不超过 400 行；单文件版 1,673 行是上限的 4 倍。按**依赖方向单向**拆：`spec → xml-lex → xml-decl → xml-tree → xml-scan → zip → parts → cli → main`，**无循环依赖**。唯一共享可变状态是元素预算对象 `PackageBudget`（main 创建、逐层传入） |
| 安全加固                | 与 `.py` 同批：成员白名单、4 个 `MAX_*`、`PackageBudget`、分块解析。**额外要求见 §4bis**（常量 ≠ 内存有界）                                                                                                                                                                   |
| 与 `.py` 的已知差异     | ① `.py` 的 `except` 漏 `LookupError`（已补，见 §7）；② 少数畸形输入上 `detail` 文案不同（两边都结构化 fail、verdict 与 rc 一致）；③ JS 侧一律结构化 fail（比 `.py` 更严，不会更松）                                                                                           |
| 回归测试                | `apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs`（两条实现路径同型断言 + 峰值内存用例 + 三插件逐字节一致用例）                                                                                                                                            |
| 行为基准                | 保留 `.py` 作为基准：OFFICE-5 用 **455 例契约对比（stdout/rc/`--out` 逐字节 0 差异）**、**800 例包级模糊对比（rc 差异 0、verdict 翻转 0）**、**3,900 例 XML 层差分（0 差异）** 验证                                                                                           |

**方法论提示（值得复用）**：`.py` 与 `.mjs` 的差异**不是靠人眼读代码发现的**，是靠**差分模糊对比**抓到的 —— 首轮 600 例里 22 例 verdict 翻转，**全是同一危险方向（JS 判 pass、.py 判 fail，即校验器放行非法输入）**，根因是自研 XML 扫描器只按 `?>` 找处理指令结尾、不校验 XML 声明与 QName。**「新实现比旧实现宽松」是最该优先探测的失效方向**，而随机变异 + 逐例比 rc/stdout 能在几分钟内覆盖人眼想不到的输入形状。

## 8. 混合方案的边界（规划，落地时对号入座）

| 部分                                                             | 归属                                                                     | 说明                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 技能文本（`skills/*/SKILL.md`）                                  | `self`（但含 DSH 血缘，按 `derived-from-dsh` 标注）                      | 本项目差异化的地方；技能口径由我们定                                          |
| **Node 自研工具**（混合方案的打底部分）                          | `self`                                                                   | 新增文件一律标 `self`，不往 DSH 上游回写                                      |
| **Python 按需增强**（载荷 + `load_workspace_dependencies` 契约） | `upstream-dsh`（含 **MPL-2.0** 的 `python-build-standalone` 与各 wheel） | 引入时按来源分别登记许可；**先有载荷、再改技能**                              |
| `scripts/check_office.py`                                        | `derived-from-dsh`                                                       | 我们的安全加固必须保留；上游若也做了资源限制，合并时对齐语义而不是覆盖        |
| `scripts/check_office.mjs`（+ `lib/*.mjs`）                      | `self`                                                                   | **技能正文调用的主路径**（见 §7bis）；与 `.py` 保持契约一致，改一边核对另一边 |

### 7ter. 提权安装的引导方式（task-71）

三个 SKILL.md 里「用户想要渲染但 `soffice` 缺失」这一段，原先只说「给出命令让用户自己跑」，
没说这条命令**需要什么权限**、也没说界面提供了投递入口。task-71 补上这两点：

- 明确这条命令**需要管理员权限**（给出 `sudo` 形式，并说明会询问账户密码）；
- 明确界面在 shell 代码块上提供 **"send to terminal"**，它**只把命令粘进集成终端、不执行**，
  由用户自己按回车；
- 明确**不要**让用户把密码贴进对话。

**为什么是「给出命令 + 用户自己回车」而不是「agent 代跑」**：`.reverse/30-sudo-auth/SUDO-AUTH-EVAL.md`
（task-67）评估后**否决**了给 agent 一条可交互提权通道（PTY 透传 / 自建 askpass / 密码框）。
理由中最硬的一条是 **TOCTOU 从结构上不可能发生** —— 用户按下的回车**就是**执行，
不存在「批准的是 A、执行的是 B」的窗口。本节的写法是那份评估结论的落地，两者一致。

**一条硬规则**：**技能与载荷是配套的，不能拆开搬**。技能里写「调用 `load_workspace_dependencies`」时，载荷必须已经在包里；反过来，当前技能走**随包 Node 库**时，不要引入一个只认系统解释器（`python3`）的技能文本。

## 9. DSH 发新版时的跟进流程

1. **取上游**：拿新版 DSH 的 `packages/skill/skill-office/`。
2. **按表分流**（§6）：`upstream-dsh` 的文件可直接比对；`derived-from-dsh` 的**先看 §4 的结构 diff**，判断是否追加式。
3. **`check_office.py` 专项**：用 §4 的命令比 `def`/`class`/`MAX_*` 清单。若上游也加了资源预算，逐项对齐语义（别直接覆盖我们的 4 个预算常量）；两边都加了同类逻辑时，取更严格的一侧并在 `Local changes` 记录取舍。
   **改完 `.py` 后必须同步 `.mjs`**（反之亦然）：两者是同一契约的两份实现（见 §7bis）。改完跑 `test/checkOffice.test.mjs`，其中的「三份逐字节一致」用例会抓住漏同步；契约层面的回归用差分对比（`.reverse/28-office-provenance/OFFICE-CHECKER-JS.md` §4 给了脚本口径）。
4. **技能文本**：只在「载荷已就位」或「确认上游改动与载荷无关」时才改；改完同步 frontmatter 的 `modified` 描述。
5. **收尾**：`node scripts/licenses.mjs notices` → `node scripts/licenses.mjs check`；跑 `apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs`；更新本文档 §6/§7 的**哈希与字节数**（它们都是快照值）。
6. **不要**把本仓库的自研文件（`visual-judge.md`、Node 工具、测试）当成上游文件覆盖。

## 10. 快照与漂移

本文档中的**字节数、sha256、版本号**都是「写作时刻」的快照（当前为 2026-09-23）。它们会随改动漂移 —— 任何一次改动都要**同时**更新本文档、`third-party/copied-components.json` 与重新生成的 `THIRD-PARTY-NOTICES.md`。三处不一致时：以 `copied-components.json`（机器可读）为准，然后修正另外两处。
