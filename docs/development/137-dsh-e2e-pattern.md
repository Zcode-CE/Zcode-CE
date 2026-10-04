# DSH e2e 模式落地：LLM-in-the-loop 与 real-API 双流门禁

> 专题：把 DSH（deepseek-harness，MIT）的两项测试工程实践搬进 CE —— **LLM-in-the-loop e2e**（真模型 + 故障注入 + 反撒谎断言）与 **real-API e2e 的 CI 双流门禁**（keyless 恒绿 + with-key fail-loud）。试点场景选在 office-xlsx 的「空白渲染」；推广留给后续版本。
> 方法学来源：`.reverse/100-dsh-021/REPORT.md` §2.4/§4.1（三项可搬物的判别）与 `.reverse/98-ce4/DSH-OFFICE-DELTA.md`（DSH e2e 的 6 项技术要点）。本文件是这两份分析结论的落地 spec。

## 0. 读了什么 + 一致性

| 文档                                                                                                | 结论                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DSH `packages/skill/skill-office/tests/xlsx-validation.e2e.ts`（MIT，236 行全文）                   | 技术要点逐条对照 §2；CE 不能逐字节搬（依赖 `dsh-loader-smoke`/`dsh-llm-replay`/`dsh-attachment-local` 与 kit CLI），按 100-dsh-021 §3.2 #1 的判别自建最小等价物 |
| DSH `.github/workflows/e2e.yml` + `.agents/notes/implemented/testing/2026-06-19-real-api-e2e-ci.md` | 双流设计的原始依据；CE 按任务约束改为挂在 `.github/workflows/ci.yml`（见 §4 的差异说明）                                                                        |
| `docs/development/office-plugins.md`、`docs/development/pdf-plugins.md`                             | 插件来源标注、许可门禁、视觉检查链（§6bis）；本模式的夹具落在插件目录内，改动须走 `licenses:notices` 重报（§7）                                                 |
| 根 `AGENTS.md`、`docs/development/delegation-discipline.md`                                         | 「静默降级是唯一不被允许的」「验证必须打到最终消费点」「交付终点失败必须让流水线变红」——这三条正是本模式要落实的规则                                            |

一致性结论：**与既有判别一致，无推翻**。唯一的新事实是落地实测得到的（§5）：CE 的 personal provider 配置文件必须同时写 `manualProviderModelRules`（缺它会让整个文件被判无效、默认模型选择静默丢失——实测过的失败链，已在夹具注释里记下）。

## 1. 为什么需要它

CE 的办公链在工程层已经很强：自包含 bundle 断言、零依赖校验器、契约差分、峰值内存回归、三份逐字节一致。但**没有任何测试触及模型回合**。后果是三条最难验证的产品规则只有静态grep护栏（`skillVisualChain.test.mjs` 断言技能文本含/不含某些字符串）：

- 「静默降级是唯一不被允许的」；
- 「空白/全透明预览 = 渲染失败，立即停止该工作簿的全部视觉 QA」；
- 「不得谎称已做视觉检查」。

FIX-DOCX 的教训（13 个夹具 0 个含 `mc:Ignorable`，静态全绿但真实库产物判 fail）证明过：**静态验证 ≠ 行为验证**。DSH 的 e2e 把消费点推到模型回合，并且反撒谎正则直接对应 CE 的「如实声明」红线。CE 此前完全没有这一层，这是办公能力里唯一「书面承认的验证缺口」。

## 2. 模式的五个组成（试点实现）

试点文件（全部在 `apps/zcode-cli/packages/spreadsheets-plugin/` 下）：

| 文件                                                                | 角色                                                           | 归属                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `scripts/office-capabilities.mjs`                                   | 能力探测 CLI（recalculate）；不是 e2e 专属，见 §6              | `self`（设计参考 DSH 0.2.x 技能规则，未搬运代码） |
| `test/officeE2eBlankRender.test.mjs`                                | 场景与断言（keyless 常跑 2 条 + with-key 跳过门控）            | `self`                                            |
| `test/lib/blank-render-support.mjs`                                 | provider 配置构造、stream-json 解析、透明 PNG 判定、工作区装配 | `self`                                            |
| `test/fixtures/soffice-fake.cjs`、`test/fixtures/pdftoppm-fake.cjs` | PATH 注入的假渲染器（空白产物 + calls.jsonl）                  | `self`                                            |
| `.github/workflows/ci.yml` 的 `e2e-real-api` job                    | with-key 流门禁                                                | `self`                                            |

对照 DSH `xlsx-validation.e2e.ts` 的 6 项技术要点：

| DSH 要点                                                     | CE 试点实现                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 真模型 + 真技能回路（起 CLI、任务直接写给模型）              | spawn 打包后的 `apps/zcode-cli/packages/cli/dist/zcode.cjs`，`--prompt <任务> --output-format stream-json --mode yolo`；构建入口 `node scripts/build-desktop-agent-cli.mjs`（它同时 stage 插件载荷到 `cli/dist/packages/`，正是 seed 的候选基目录第一顺位）                                                          |
| fixture 注入确定性失败（把偶发的「渲染空白」变成可复现故障） | 工作区 `bin/soffice` + `bin/pdftoppm` 前置进 PATH：假 soffice 写「无内容流的一页 PDF」，假 pdftoppm 写全透明 PNG（`-png`，800x600，与技能判据同源）或 1x1 白底 JPEG（`-jpeg`，Read 直读 PDF 时适配器的调用形态）；两者每次调用追加 JSON 到 `calls.jsonl`                                                             |
| 对模型行为的断言（技能必须加载、校验器必须跑、不搜索渲染器） | 解析 stream-json：`tool.updated/payload.kind==="scheduled"` 取 toolName+input（Bash 命令、Skill 调用、Read 路径）；断言含 `check_office.mjs`、加载过含 "xlsx" 的技能                                                                                                                                                 |
| 最终回答的读取                                               | headless stream-json 里 `message.upserted` 可能一条都没有（CI 首次真跑与本地假 key 回合同一症状）；回答的权威来源是 `turn.completed.payload.response`（prompt-command 的 observer 与 TUI 的 fallback 同款）。collector 先取 message.upserted、再回退 turn.completed.response；失败断言挂事件计数与尾部事件的诊断摘要 |     |
| 反「模型撒谎」断言                                           | 最终回答（最后一条非 system 的 `message.upserted`）必须匹配诚实面正则（blank/unable/failed/未…）、不得匹配撒谎面正则（visually verified/视觉检查已通过…）                                                                                                                                                            |
| 渲染失败后不重试                                             | `calls.jsonl` 序列断言：首次 pdftoppm 渲染之后不再有任何 soffice/pdftoppm 渲染调用；直接读图 ≤ 1 次                                                                                                                                                                                                                  |
| 产物完整性                                                   | `input.xlsx` 逐字节不变；`result.xlsx` 用 exceljs 复核表顺序、Notes 保留、数据未改、列宽按请求加宽、打印设置指纹（pageSetup/pageMargins/printArea）不变                                                                                                                                                              |

DSH 断言「模型不得 `which/find` libreoffice」这一条**不搬**：它与 CE「不得禁止用户用已有软件、引擎选择权属于用户」的有意分叉冲突（office-plugins.md §6bis 第 6 条）。

## 3. 环境变量登记（spec 用途声明）

按 `apps/zcode-cli/AGENTS.md`「新增环境变量先在 spec 里定义用途、优先级、错误行为与测试覆盖」：

| 变量                              | 用途                                                        | 默认                          | 缺省行为                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ZCODE_E2E_API_KEY`               | with-key 流的模型 API key（外部 DeepSeek API）              | 无                            | keyless：真实回路测试 `{ skip }` 显式跳过（常绿）；with-key（ci.yml）：preflight `exit 1` + `::error::`，**不允许伪通过** |
| `ZCODE_E2E_BASE_URL`              | API 端点                                                    | `https://api.deepseek.com/v1` | CI step 钉死，防仓库 `.env` 劫持                                                                                          |
| `ZCODE_E2E_MODEL`                 | 模型 id                                                     | `deepseek-chat`               | —                                                                                                                         |
| `ZCODE_E2E_API_TYPE`              | 协议形态：`openai-chat-completions` 或 `anthropic-messages` | `openai-chat-completions`     | 其它值在测试内 `assert.fail`（fail-loud，不让脏配置静默落到 provider 层报歧义错）                                         |
| `ZCODE_E2E_MODEL_SUPPORTS_IMAGES` | `1` 时在 provider 配置里声明图像输入                        | 关（false）                   | 见 §5 已知边界：图像能力关闭时模型走「如实声明视觉检查不可用」分支                                                        |
| `ZCODE_E2E_TIMEOUT_MS`            | 单个 agent 回路预算                                         | 240000                        | 超时即判失败（SIGKILL + 断言 timedOut=false）                                                                             |

这些变量只服务 e2e，不在别处消费；key 由 CI repo secret `ZCODE_E2E_API_KEY` 供给（step 级注入）。

## 4. CI 双流门禁（`.github/workflows/ci.yml` 的 `e2e-real-api`）

keyless 流（默认）：`verify` job 的 `pnpm test` 里，spreadsheet-plugin 的 e2e 测试自跳过真实回路，但**常跑** keyless 伴随断言（能力探测契约、假渲染器夹具自检、跳过逻辑本身）——真实回路的解析链与夹具因此不会静默腐烂。

with-key 流（`e2e-real-api` job）：

- 只在可信事件运行（push main / PR / workflow_dispatch）。job 级 `if` 跳过 fork PR 与 Dependabot PR（判据按 **PR author** 而非 `github.actor`）；job 级 if 跳过的 check 报 success，不阻塞合并，可作 required status check。
- Preflight：可信事件上 secret 理应存在，为空即 `exit 1`。这条把「自跳过套件 + 丢失 secret = 假绿」的失效模式变成可见失败。
- secret 只出现在 preflight 与 e2e 两个 step 的 `env:`（checkout/install 看不到）；`permissions: contents: read`；base URL 钉死；job `timeout-minutes: 20` 封顶重试风暴。
- 步骤：checkout → pnpm/node（24.14.0，与 verify 同口径）→ `pnpm install --frozen-lockfile` → `node scripts/build-desktop-agent-cli.mjs` → preflight → `cd apps/zcode-cli/packages/spreadsheets-plugin && node --test test/officeE2eBlankRender.test.mjs`。

与 DSH 原设计的差异：DSH 把 with-key 流放在独立的 `.github/workflows/e2e.yml`（理由是触发策略与凭据策略与 ci.yml 解耦）。CE 按本任务约束挂在 `ci.yml`（仅动其测试门禁部分），把「分 job 而非并入 verify」这一更本质的隔离保留下来。若将来 CE 觉得独立文件更合适，按 DSH 原文的论证迁移即可，本模式无需改。

激活：在仓库 secrets 配置 `ZCODE_E2E_API_KEY`。配置前可信事件上的这个 job 会红（preflight），这是设计行为——`100-dsh-021` 与 DSH 原文都记录过同一验证方式（secret 建立前的那次运行恰好在 preflight 失败）。

## 5. 已验证范围与诚实边界

**已验证（keyless，实跑）**（含 CI 首次真跑的失败教训）：

- 能力探测契约子测试：rc 0/2、输出形状、`--out`。
- 假渲染器夹具自检：PDF 头 `%PDF-`、PNG 全透明（RGBA 全零，含 zlib 解压复核）、JPEG 头尾魔数、`-v` 探测、`calls.jsonl` 记录。
- 真实回路**骨架**（假 key）：全链跑通到外部 API 返回 401 → `turn.failed`。实测确认：personal provider 配置可被 `decodeProviderConfigFile` 解码、默认模型选择生效、插件 seed 落在隔离 `HOME/.zcode/cli/plugins/cache/...`（spreadsheets/0.1.7 含 `scripts/office-capabilities.mjs` 与 `skills/xlsx/`）、stream-json 行可解析、`--mode yolo` 下回路可达模型请求。
- 回答来源（CI 首次真跑 run 37191195274 的失败定位）：回合在 30.9s 内正常结束（exitCode 0、turn.completed 存在），但 `message.upserted` 一条都没有——**不是超时**：runHeadlessAgent 的等待按进程退出而非定时，30.9s 只是真实回合的耗时。最终回答来自 `turn.completed.payload.response`，已落实为 collector 回退 + keyless 单测 + 失败诊断 dump。
- 打印指纹的策展边界（CI 真跑 run 37193521331 的失败定位）：原断言整对象比对 pageSetup，而 exceljs 自身的 load→save（零改动）就会把 useFirstPageNumber:false→true 并注入 firstPageNumber=1——这一位是库的写入噪音，与模型行为无关（测试缺陷，非产品发现）。修法：输入工作表带一套故意非默认的打印设置（landscape/scale 90/fitToHeight 0/自定义页边距，见 TARGET_PRINT_SETUP），指纹只比对 round-trip 稳定且重建必丢的策展字段（printFingerprint），并配 keyless 可达性锁：忠实 round-trip 必过、重建新表必散。

**未执行**：with-key 真实模型回合（本机无 `ZCODE_E2E_API_KEY`，按任务要求如实记录为「keyless 流已验证、with-key 流未执行」）。首次配置 secret 后的第一次可信事件运行即首次真跑。

**已知边界**：

- `deepseek-chat` 无图像输入能力：模型会按技能规则走「先判定模型图片能力 → 不可用 → 如实声明视觉检查不可用」的诚实分支。要打满「空白渲染被识别 + 不重试」的路径，需供应支持图像的模型并设 `ZCODE_E2E_MODEL_SUPPORTS_IMAGES=1`。
- Windows 不支持：假渲染器是无扩展名文件 + POSIX shebang 的 PATH 解析（测试以 `{ skip: ... }` 显式跳过并写明原因）。
- `spreadsheets:visual-judge` 子代理的内部行为未断言（子代理事件不进父会话 stream-json）；只断言父会话的读图次数与最终回答。
- 打印设置指纹依赖 exceljs 能表达的 `pageSetup/pageMargins/printArea`；exceljs 不表示的打印项不在断言内。
- 本场景只覆盖 blank；DSH 还有 data/formula/layout 三场景（formula 依赖 recalculate 引擎，CE 的缺口见 §6）。

## 6. 与 recalculate 缺口的关系（item 1）

同一批 DSH 0.2.x 分析认定的 CE 唯一书面的办公能力缺口：xlsx 公式缓存重算。CE 的处理（S 档）：**不搬引擎整包**（145–182 MiB/平台 + MPL-2.0 + Linux 仅 WASM），只搬「能力探测 + 如实声明」的语义骨架：

- `scripts/office-capabilities.mjs`（spreadsheets-plugin）：stdout 一行 JSON，`capabilities.recalculate.available` 是权威答案；rc 不表达 availability（能力不可用不是错误）。将来引擎落在唯一的挂载点 `scripts/office-node/recalculate.cjs` 时探测自动翻转，技能正文无需改动。
- `skills/xlsx/SKILL.md`：交付含公式结果的工作簿时先跑探测；不可用时（CE 现状）在最终回复中如实声明「缓存结果未在本构建中重算」；不得把缓存值说成新算结果、不得用常量替换公式。

为什么把 recalculate 探测与本 e2e 模式放在同一批：两者同源（`.reverse/100-dsh-021` §4.3 的 S 档），且 e2e 的假渲染器夹具证明了「故障注入 + 如实声明断言」的模式可以复制到 recalculate（将来 L 档引擎落地时，注入「重算失败/未刷新缓存」场景，断言模型不把缓存值说成新算结果）。

## 7. 改动文件与许可门禁

三个 office 插件目录整体是 `third-party/copied-components.json` 的 `DeepSeek Harness skill-office` 条目 roots：**这些目录内任何字节改动都必须重跑** `node scripts/licenses.mjs notices` 与 `node scripts/licenses.mjs check`（office-plugins.md §5）。本次新增的 `scripts/office-capabilities.mjs`、`test/` 下四个文件、`skills/xlsx/SKILL.md` 的改动均已按此流程处理。

`test/` 不进 seed（bundled-plugins 的顶层白名单不含它），因此夹具不会进入用户缓存；`scripts/office-capabilities.mjs` 会进 seed（白名单含 `scripts`），已实测确认它随 `cli/dist/packages/spreadsheets-plugin/` staging 与运行时 seed 缓存落地。

新文件全部标注为 `self`（设计参考 DSH 对应实践，未逐字节搬运），不往 DSH 上游回写；office-plugins.md §6 的文件清单需补这些行——见交付报告的「需同步的既有文档」一节。

## 8. 如何加新场景

1. 选一条「模型最容易撒谎或静默降级」的产品规则（例如「图表部件丢失必须告知」「缺字体不得产出文件」）。
2. 做确定性注入：把偶发故障变成夹具（假 CLI / 假渲染器 / 构造坏的输入），复用 `blank-render-support.mjs` 的解析与装配函数。
3. 写断言：产物完整性 + 行为契约（技能加载、校验器执行）+ 反撒谎正则（诚实面/撒谎面成对，中英双覆盖）。
4. 配一条 keyless 常跑的夹具自检子测试（保证注入器本身永远产出「故障」）。
5. 如需随路环境变量，先在本文件（或对应 spec）登记用途、默认与缺省行为。

## 9. 明确不做（后续版本再说）

- 推广到 docx/pptx/pdf 插件与 data/formula/layout 场景；
- 子代理内部行为断言（需要子会话事件可观测面）；
- 夜间 schedule 触发（捕捉外部 API 漂移；DSH 有，CE 本轮不新增触发器类型）；
- Windows 支持（需要 .cmd 形态的假渲染器与 PATHEXT 处理）；
- 覆盖率门、性能基准门（`.reverse/100-dsh-021` §3.2 #3 的分层测试政策，单独的 M 档任务）。
