# ZCode-CE v3.14.3-ce.2

## 新增功能

- **Office 文档能力不再依赖系统 Python**。文档生成与结构校验改为随包 Node 载荷，开箱即用；
  此前需要自行安装 Python 3 与相关库，未安装时技能完全不可用。
- **新增「工具与权限」设置页**。可以查看危险命令清单、把某条命令加严为「每次都要确认」，
  或放宽某条命令；也可以关闭「危险命令进入持久授权」，让它们每次都重新确认。

## 体验优化

- **授权弹窗现在显示真实范围**。此前它只显示「前缀」类规则，把「该工具的任意命令」这类规则
  静默省略 —— 你无法从界面上看出自己到底授予了多大范围。现在三种范围都会列出（任意 / 前缀 / 精确）。
  终端界面（TUI）有同一处问题，也已修。
- **Office 技能明确了能力边界**：docx / pptx 为纯生成器，不支持重度编辑既有文档；
  xlsx 可读写，但重写既有工作簿会丢弃图表部件（合并单元格与公式保留）。交付前会如实告知。
- **渲染（转 PDF / 视觉检查）明确为可选增强**。需要 LibreOffice，缺失时会说明「未做视觉检查」
  而不是静默跳过；你仍可用已有的 Word / WPS / Pages 完成同类任务。

## 问题修复

- **修复电脑控制在正式包中完全不可用**。此前驱动载荷在打包时被静默丢弃，首次调用会报
  `Cannot find package '@trycua/cua-driver'`；该文案会误导模型安装不存在的包。
- **修复开发模式下 office 载荷与电脑控制驱动缺失**（`pnpm dev:desktop`）。
- **修复危险命令被记成「整类命令」**。批准一次 `sudo apt install foo` 此前会记住
  「`sudo apt install` 任意包」；现在只记住这一条确切命令。同类问题（`doas`、`pkexec`）一并修复。
- **修复校验器可被小文件耗尽内存**。40 KB 的构造文档可让它占用 4.2 GB 并崩溃、且不输出结果；
  修复后同一文件占用 77 MB。
- **修复空命令导致的权限放大**。`Bash` 收到空命令时，「始终允许本项目」会退化成
  「本项目内任意 Bash 永久免问」，且界面上没有提示。
- **修复校验器误判自己生成的 Word 文档**。用 docx 库产出的 `.docx` 会被校验器判为失败（而 Python 版判通过），原因是它按属性书写顺序解析命名空间，而规范里声明对该元素的所有属性生效、与顺序无关。现已修复，并补齐了同一路径掩盖的两类非法输入检查。
- **修复校验器的 `--out` 参数可覆盖输入文档**（当它指向输入文档的符号链接时）。
- **修复 Excel 流式读取不可用**。读取大型工作簿的流式接口恢复可用。

## 其他变更

- 移除依赖链中**无许可依据**的 `buffers@0.1.1`（npm 无许可声明、包内无 LICENSE、上游仓库已不可访问）。
- 补登三个此前缺失上游许可文本的第三方包。
- **危险命令的持久授权默认关闭**。这是行为变更：此前能被「记住」的危险命令（如 `rm -rf ./build`）
  现在每次都要重新确认。可在「工具与权限」页一键放宽。

## 已知限制

- **电脑控制本次只验证到「枚举应用」（`list_apps`）**，动作类调用（点击、输入）未验证。
- **Office 载荷的验证止于打包链**，未在「安装后的完整包」中做端到端验证。

---

# English

## New features

- **Office document capabilities no longer need a system Python.** Document creation and structural
  checks ship a self-contained Node payload and work out of the box. A system Python 3 install used
  to be required, and the skills were unusable without it.
- **New "Tools & permissions" settings page.** Review the dangerous-command list, tighten a command
  to "always ask", relax one, or turn off persistent grants for dangerous commands entirely so they
  are confirmed every time.

## Improvements

- **The approval dialog now shows the real scope.** It used to list only "prefix" rules and silently
  omit rules like "any command of this tool" — you could not tell how far a grant reached. All three
  kinds are now listed (any / prefix / exact). The terminal UI (TUI) had the same problem and is fixed too.
- **Office skills now state their capability boundaries**: docx / pptx are pure generators and do not
  support heavy edits to existing documents; xlsx can read and write, but rewriting an existing
  workbook drops chart parts (merges and formulas are preserved). This is disclosed before delivery.
- **Rendering (PDF / visual checks) is explicitly an optional enhancement.** It needs LibreOffice;
  when absent, the build says visual layout was not inspected rather than silently skipping it.
  You can still use software you already have (Word, WPS, Pages) for the same task.

## Fixes

- **Fixed Computer Use being entirely unavailable in packaged builds.** The driver payload was
  silently dropped during packaging, so the first call failed with
  `Cannot find package '@trycua/cua-driver'` — wording that led the model to install a package that
  does not exist.
- **Fixed missing office payload and Computer Use driver in development mode** (`pnpm dev:desktop`).
- **Fixed dangerous commands being remembered as a whole family.** Approving `sudo apt install foo`
  used to remember "any `sudo apt install`"; it now remembers that exact command only. The same
  problem with `doas` and `pkexec` is fixed as well.
- **Fixed a validator memory exhaustion from small files.** A crafted 40 KB document could make the
  validator consume 4.2 GB and crash without producing output; the same file now uses 77 MB.
- **Fixed a permission escalation via empty commands.** With an empty `Bash` command, "Always allow
  in this project" degraded into "any Bash command in this project, permanently, without asking",
  with no hint in the UI.
- **Fixed the validator rejecting Word documents it produced itself.** A `.docx` written by the docx library was judged as failing (while the Python implementation passed): it parsed namespaces in attribute order, whereas the spec makes a declaration apply to every attribute of that element regardless of order. Fixed, along with two illegal-input checks that the same code path had been masking.
- **Fixed the validator's `--out` overwriting the input document** when it pointed at a symlink to it.
- **Fixed Excel streaming reads being unavailable.** The streaming API for large workbooks works again.

## Other changes

- Removed **`buffers@0.1.1`** from the dependency chain: no license declaration on npm, no LICENSE
  file in the package, and its upstream repository is no longer reachable.
- Added upstream license texts for three third-party packages that were missing them.
- **Persistent grants for dangerous commands are off by default.** This is a behavior change:
  dangerous commands that used to be remembered (such as `rm -rf ./build`) are now confirmed every
  time. It can be relaxed with one click on the "Tools & permissions" page.

## Known limitations

- **Computer Use was verified only up to listing applications (`list_apps`)**; action calls
  (clicks, typing) were not verified.
- **Office payload verification stops at the packaging chain** — no end-to-end check inside a fully
  installed build.
