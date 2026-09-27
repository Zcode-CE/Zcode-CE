# 第三方许可材料的登记、档位与门禁

面向维护者与发布前的合规复核人。这份文档说明 `third-party/` 里每个文件负责什么、`node scripts/licenses.mjs check --strict` 到底在拦什么，以及"某条材料是不是已经够了"该怎么判。

## 1. 目录职责

| 路径                                                                         | 职责                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `third-party/npm-overrides.json`                                             | npm 包的补充登记：许可标识、**出处**（registry URL / 上游 raw URL）、内容快照 `file`+`sha256`、以及 `evidenceKind`（材料档位）或 `acceptedMissingNotice`（明确接受缺失）。 |
| `third-party/upstream/<sha256>.txt`                                          | 许可/通知文本的**逐字节快照**。文件名就是内容 sha256，任何改动都会让 `licenses:check` 变红。                                                                               |
| `third-party/copied-components.json`                                         | 逐字节搬进本仓库的上游源码/资产。                                                                                                                                          |
| `third-party/embedded-components.json`                                       | 内嵌在某个 npm 包内部的组件（原生库、WASM、vendored 代码），可带 `extraction` 说明"从文件里摘出的原始声明"。                                                               |
| `third-party/runtime/sources.json`、`third-party/native-search/sources.json` | Node 运行时与原生检索工具的许可来源。                                                                                                                                      |
| `third-party/inventory.json`                                                 | **生成物**。记录全部输入哈希、声明 sha256、`reviewRequired`（阻断项）与 `documentedLimitations`（非阻断的书面限制）。不要手改。                                            |
| `THIRD-PARTY-NOTICES.md`                                                     | **生成物**，随发行物分发。不要手改。                                                                                                                                       |

## 2. 门禁与流程

```bash
node scripts/licenses.mjs notices        # 重新生成 THIRD-PARTY-NOTICES.md 与 third-party/inventory.json
node scripts/licenses.mjs check          # 基础门禁：许可标识、声明新鲜度
pnpm licenses:check
node scripts/licenses.mjs check --strict # 发布前门槛：材料义务必须为空
```

- 基础门禁管的是"**包的许可标识能不能识别、生成物是否与输入一致**"。
- `--strict` 管的是"**每一条材料义务是否已闭合或已记录**"。基础门禁通过**不等于**合规完成。
- 只要动了 `third-party/**`、`pnpm-lock.yaml`、workspace 的 `package.json` 或任何被登记的快照，就要重新跑 `notices`，否则新鲜度检查会红。
- 变更档位判定逻辑时，必须同时跑第 6 节的反向验证。

## 3. 材料证据档位（`evidenceKind`）

`evidenceKind` 描述"我们手上是哪种材料"，它决定这条义务是否阻断发布。实现见 `scripts/third-party-npm.mjs` 的 `EVIDENCE_TIERS`。

| 档位                                | 是否阻断                         | 含义                                                                                                   |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `publisher-declared-standard-terms` | **非阻断**（须四条判据全部成立） | 发布者在**已发布物**里声明了 SPDX 标识，我们随包分发该标识对应的标准条款文本，并记录了出处与版本锁定。 |
| `pinned-upstream-license-file`      | **非阻断**（须四条判据全部成立） | 登记的是**上游仓库**里 pin 住的许可文件原文，且已发布物声明的每个标识的标准条款都在分发内容里。        |
| `incomplete-unverified`             | 阻断                             | 声明缺失、含糊，或文本是自定义条款。                                                                   |
| 表里没有的其它取值                  | **阻断**（fail-closed）          | 包括拼写错误的档位名 —— 写错不会静默变绿，只会继续红。                                                 |

### 3.1 `publisher-declared-standard-terms` 的四条判据

四条**必须同时**成立，缺任何一条都会被自动降级为阻断，并在 `--strict` 的错误里逐条列出缺哪条：

| 判据                                 | 要求                                                                                                  | 代码怎么核                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| (a) 已发布物声明了 SPDX 标识         | `package.json` 的 `license`/`licenses` 字段，**或** tarball 内 README/许可段里的标识                  | 只用**已发布包目录**里的内容；我们自己写入的 override 快照**不**算（否则等于拿自己的断言给自己作证） |
| (b) 该标识对应标准、未修改的条款文本 | 我们分发的通知文本必须含该标识的标准条款片段（MIT/ISC/BSD-2/BSD-3/Apache-2.0）                        | 与 `STANDARD_CLAUSES` 表逐条比对；**标识没有表项 ⇒ 无法核对 ⇒ 阻断**                                 |
| (c) 发布者版权主体已发布             | `package.json` 的 `author`/`contributors`/`maintainers`，或已发布许可文本里的 `Copyright` 行          | 同样只认已发布物。**注意**：这只用来证明"发布者公开了身份"，不用于推断版权持有人                     |
| (d) 我们记录了出处                   | `source` + `file`/`sha256` 内容锁定 + 版本锁定（`npmArchiveSha256` / `sourceRevision` / `refs` 任一） | 直接从 override 记录里读                                                                             |

关于 (b) 的诚实说明：代码只能核到"**标准条款确实在文本里**"，它**不能**证明文本没被人改过一个字 —— 那是人工复核的职责。但"换成自定义文案"这类会让门禁静默变绿的做法一定会被拦住（实测见 §6）。

### 3.1.1 `pinned-upstream-license-file` 的四条判据

与上一档是**并列关系，不是包含关系**：两档的凭据种类不同（这一档凭「上游发布过一份真实许可文件」，
上一档凭「发布者在已发布物里声明了标识」），因此判据各写各的，互不继承。

| 判据                              | 要求                                                                                                 | 代码怎么核                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| (甲) 上游确实发布了该许可文件     | 登记的快照是上游文件的逐字节副本，且 `source` 能对上 `refs` 里的 pinned tag                          | `file`+`sha256` 存在、`refs` 非空、`source` 含该 ref、`reviewEvidence.upstreamLicenseFiles` 非空 |
| (乙) 每个已声明标识的标准条款都在 | 以**已发布物**声明的标识为准（`AND` 的每一项都要），其标准条款须出现在快照**或我们随包分发的全文**里 | 与 `PINNED_UPSTREAM_CLAUSES` 逐条比对；标识无表项 ⇒ 阻断。另要求 `record.license` 与已发布物一致 |
| (丙) 发布者版权主体可核           | 已发布物的 `author`/`contributors`/`maintainers`，或已发布/上游许可文本里的 `Copyright` 行           | 只认已发布物与上游文件原文，不认我们自己写的说明                                                 |
| (丁) 出处与内容锁定               | `source` + `file`/`sha256` + `reviewEvidence.checkedOn`/`result`                                     | 直接从 override 记录里读                                                                         |

**判据 (乙) 为什么以「已发布物」为准、而不是看 `record.license`**：实测踩到过 ——
`@trycua/cua-driver-*` 的 6 个平台包在**已发布物**里声明的是 `MIT AND MPL-2.0`，
而登记表一度只记成 `MIT`，等于把这个 MPL 义务藏掉。若判据只看 `record.license`，
这个缺陷会**静默通过**。所以 (乙) 反过来要求两者一致：不一致 ⇒ 阻断，且提示「改登记，不是改判据」。

**为什么要求「标准条款在分发内容里」而不是只看快照**：`@ubjs/*` 上游只发布了 MPL-2.0 的
Exhibit A 短通知（192 B），MPL 全文并未随包分发。短通知本身可辩护，但 MPL 的义务不止保留通知，
还有源码可提供。因此我们**另行随包分发 MPL-2.0 全文**（`scripts/license-texts/MPL-2.0.txt`，
与 Apache-2.0 走同一条通路，表在 `SHIPPED_STANDARD_TEXTS`）。这不是放宽判据，是补上真实缺的材料。

**源码可提供这条义务是独立核实过的**（不继承任何自述）：pinned tag 可达、且实际分发的二进制
对应源码就在该 tag 内。核实记录写在 `npm-overrides.json` 各条的 `reviewEvidence.result` 里。

### 3.2 判定流程

```text
读 override.evidenceKind
  ├─ 不在 EVIDENCE_TIERS 表里          → 阻断（fail-closed）
  ├─ incomplete-unverified             → 阻断
  ├─ publisher-declared-standard-terms → 逐条核 (a)(b)(c)(d)
  │     ├─ 四条全过 → 写入 inventory.documentedLimitations（非阻断）
  │     └─ 任一不过 → 留在 reviewRequired，reason 里逐条列出缺哪条
  └─ pinned-upstream-license-file      → 逐条核 (甲)(乙)(丙)(丁)
        ├─ 四条全过 → 写入 inventory.documentedLimitations（非阻断）
        └─ 任一不过 → 留在 reviewRequired，reason 里逐条列出缺哪条
```

### 3.3 语义边界（重要）

**非阻断不等于"材料齐全"。** 它只表示：我们**不再把发布者已经发布的声明当作缺失**。这三样东西齐备才算非阻断：

1. **发布者已发布的声明**（SPDX 标识，来自已发布物）；
2. **标准条款**（该标识对应的标准文本，且我们随包分发）；
3. **已记录的出处**（registry 标识 + `dist.integrity` 或等价版本锁定 + 声明原文所在位置）。

这三样都不构成"上游发布过 LICENSE 文件"的主张 —— 恰恰相反，这些包的上游**从未**发布过许可文件，而这一点本身是核实过的结论，不是猜测。**禁止**把任何未核实的情况塞进这一档。

### 3.4 快照要装什么：**README 许可段不能单独当快照**（实测踩到）

包内**没有 `LICENSE` 文件**、只有 README 许可段时，**把该段直接快照下来是不够的** —— 判据 (b) 会不通过，条目**仍留在阻断里**。

**原因**：判据 (b) 是把 `STANDARD_CLAUSES` 的标准片段**逐字**比对（见 `scripts/third-party-npm.mjs`）。而发布者 README 里的 MIT 正文常见两种偏差：

| 偏差     | 实例（`agent-base@6.0.2` / `https-proxy-agent@5.0.1`） | 标准片段            |
| -------- | ------------------------------------------------------ | ------------------- |
| 引号不同 | 单引号 `'Software'`                                    | 双引号 `"Software"` |
| 断行不同 | 在别处换行                                             | 特定断行位置        |

实测两条标准片段对 README 段的 `includes` **均为 `false`** ⇒ 只快照 README 段 = 白做。

**正确做法**：快照 = **两段并列**，且**各自标明身份**：

1. **README 许可段逐字**（发布者原文，含其单引号与断行）—— 这是"发布者已发布"的证据，用于判据 (a)/(c)；
2. **该标识的标准条款全文**（标准、未修改）—— 用于判据 (b)。

并在文本里**显式写明**：第 2 段是**标准条款文本**，**不是**主张上游发布过 `LICENSE` 文件。

**这个区分是关键**：它既让判据 (b) 可被机械核对，又**没有伪造"上游发布过 LICENSE"这个事实** —— 与 §3.3 的语义边界一致。

> 范式可参照 `agent-base@6.0.2` / `https-proxy-agent@5.0.1`（本仓库 2026-09-24 新增），其上游**确实没有** LICENSE：`agent-base` tag `6.0.2` 的仓库 tree 里无 `LICENSE`，`https-proxy-agent` tag `5.0.1` 同样（raw 探测 404）。

## 4. 目前的状态（快照，会漂移）

`--strict` 的阻断项与 `documentedLimitations` 的确切数字**以 `third-party/inventory.json` 为准**，不要在本文件里抄写数字。本节只记录状态的性质：

- 阻断项分三类：**档位判据不满足**（`publisher-declared-standard-terms` 但缺 (a)~(d) 之一，已在 reason 里写明）、**未重新分档的上游 pin 文件**（`pinned-upstream-license-file`）、以及**非 npm 组件**（copied 源码、内嵌组件、原生工具）。
- `brotli@1.3.3` 的特别之处：包本体按 `package.json` 声明为 MIT，但它 vendored 的 `google/brotli` 解码器（`dec/*.js`）带 **Apache-2.0 + `Copyright 2013 Google Inc.`** 逐字节声明。该声明登记在 `embedded-components.json`（`google/brotli (vendored in brotli@1.3.3)`），并且 `THIRD-PARTY-NOTICES.md` 里能查到它。**不要把 brotli 整包记成 MIT 就结束** —— 那是署名不准。

## 5. `pinned-upstream-license-file` 档（ce.4 新设，原为阻断）

这批条目（`@trycua/cua-driver*`、`@ubjs/*`）登记的是**上游仓库里 pin 住许可文件的原文快照**，
`refs` 里记着版本 tag。在 ce.3 里它们保持阻断，理由是 fail-closed 优先、且批准范围只含一档。

ce.4 把这一档**单设并改为非阻断**，依据是四条判据（见 §3.1.1），**没有降低任何一档的强度**：

- 它与 `publisher-declared-standard-terms` 是**并列**关系。原来的「排序倒挂」在于：
  材料更弱的「只有 package.json 声明 + 标准文本」不阻断，而材料更强的「有上游发布的许可文件原文」反而阻断。
  新设一档消掉的是这个倒挂，不是把标准调低。
- 它**要求更多**而不是更少：除了上游文件本身，还要求已发布物声明的**每一个**标识的标准条款
  都在分发内容里 —— 这一条正是 `@ubjs/*` 只有 192 B Exhibit A 时过不去的原因。

### 5.1 落地时顺带修正的两处登记缺陷（独立于档位设计）

**(1) 6 个 `@trycua` 平台包的 `license` 记错了。** 它们在已发布物里声明的是 `MIT AND MPL-2.0`
（MPL 部分覆盖随包分发的 `cua_driver_node_runtime.node`，包内 `node-runtime-NOTICE.md` 自述），
而登记表把 7 条全记成 `MIT` ⇒ 把这个 MPL 义务藏掉了。已按已发布物订正为 `MIT AND MPL-2.0`；
订正后 `scripts/licenses.mjs` 的定级从 `green` 正确落到 `yellow-weak`，与 `licenses.mjs:83-85`
那条注释描述的预期一致（`MIT AND MPL-2.0` 必须按最严格项定级，不能因为首项是 MIT 就放过）。

**(2) 上游通知里的构建脚本路径是错的。** `@trycua` 包内 `node-runtime-NOTICE.md` 称源码在
`scripts/build-node-runtime.mjs`，但该路径在 pinned tag `cua-driver-rs-v0.28.2` 上 **404**；
真实路径是 `libs/cua-driver/scripts/build-node-runtime.mjs`（200）。脚本本身在、源码可提供这条义务成立，
但我们要**如实记录**这个出入，否则将来复核的人会以为是我们编造的。

### 5.2 源码可提供：独立核实，不继承自述

MPL-2.0 的义务不止保留通知，还有**源码可提供**。`licenses.mjs` 的 `PROD_WEAK_ALLOW` 此前对此是
**自述**（「源码见 pinned 上游 tag」）。ce.4 立项时**独立核实**了这句话（2026-09-27）：

| 组                    | pinned tag 可达                                | 源码覆盖实际分发的二进制来源 | 证据                                                                                 |
| --------------------- | ---------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `@ubjs/*`             | ✅ `0.31.0-3` → commit `dcb5c4ab`              | ✅                           | 该 tag 的 `runtimes/napi/` 含 `Cargo.toml`/`build.rs`/`src/lib.rs`                   |
| `@trycua/cua-driver*` | ✅ `cua-driver-rs-v0.28.2` → commit `fc188250` | ✅                           | 构建脚本在 `libs/cua-driver/scripts/build-node-runtime.mjs`（见 §5.1(2) 的路径出入） |

另外，`@ubjs/*` 快照与上游文件**逐字节同一份**（`d1cc4c0a…`），`@trycua` 同样（`c0779290…`）——
两组快照的 sha256 都能直接对着 pinned tag 的 raw URL 复核。

## 6. 反向验证（改判定逻辑后必须跑）

门禁的价值取决于它**会不会拦**。改动档位判定后，至少构造一个"声明缺失或含糊"的用例，确认 `--strict` 仍然报红，并在恢复后确认逐字节一致：

| 用例       | 做法                                                                      | 期望                                                             |
| ---------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 声明缺失   | 临时去掉某包 `package.json` 的 `license` 字段                             | 判据 (a) 不满足 ⇒ 该条回到阻断；基础门禁也会因标识缺失变红       |
| 自定义文案 | 把某条的通知文本换成非标准措辞（同步改 `sha256`/`file` 以通过新鲜度检查） | 判据 (b) 不满足 ⇒ 该条回到阻断，`documentedLimitations` 计数减一 |
| 档位名含糊 | 把 `evidenceKind` 改成任意未登记的名字                                    | fail-closed ⇒ 仍然阻断                                           |

**ce.4 追加的两例（新档专有，因为新档引入了"判据只看已发布物"这条纪律）**：

| 用例                     | 做法                                                            | 期望                                                                  |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| 登记藏义务（新档）       | 把某条平台包的 `record.license` 从 `MIT AND MPL-2.0` 改回 `MIT` | 判据 (乙) 不满足 ⇒ 该条回到阻断，且 reason 明写「改登记，不是改判据」 |
| 快照无法绑定 tag（新档） | 把 `source` 换成不含 pinned ref 的 URL                          | 判据 (甲) 不满足 ⇒ 该条回到阻断（拿匿名文本当上游文件是自证）         |

```bash
# 恢复后必须逐字节一致
sha256sum third-party/npm-overrides.json third-party/upstream/*.txt | head
node scripts/licenses.mjs notices && node scripts/licenses.mjs check --strict
```

## 7. 新增或修改一条 override

1. 先确认**有没有**上游材料：tarball 的**完整条目清单**（不是过滤结果）+ **文件内容里的声明**（`grep -riE 'permission is hereby granted|licen[sc]e|copyright'`）+ 上游仓库**所有分支/版本 tag 的树**。只按文件名查会漏 —— `brotli@1.3.3` 就是这么漏掉的。
2. 有真实文件 ⇒ 落 `third-party/upstream/<sha256>.txt`（文件名 = 内容 sha256），在 override 里写 `file`+`sha256`+`source`，**不要**加 `evidenceKind`。
3. 只有发布者声明 + 标准条款 ⇒ 登记 `evidenceKind: "publisher-declared-standard-terms"`，并在 `reviewEvidence` 里写清：`npmArchiveSha256`、声明原文所在位置、发布者身份来源。四条判据要能被机械核对。
4. 确实无法取得任何材料 ⇒ `evidenceKind: "incomplete-unverified"`（阻断）或 `acceptedMissingNotice`（明确接受缺失并写明理由）。
5. 跑 `node scripts/licenses.mjs notices`，再跑基础门禁与 `--strict`，确认差集符合预期。

## 8. 已知限制

- (b) 只能核对"标准条款在不在"，不能证明文本未被改动。
- `STANDARD_CLAUSES` 只覆盖 MIT / ISC / BSD-2-Clause / BSD-3-Clause / Apache-2.0。
  `pinned-upstream-license-file` 档另用 `PINNED_UPSTREAM_CLAUSES`（= 上面那张 + MPL-2.0）。
  两档**刻意不共用一张表**：改动 `STANDARD_CLAUSES` 会顺带改变 `publisher-declared-standard-terms`
  的语义，而那不在 ce.4 的批准范围内。其它标识（EPL / CDDL 等）即使声明清楚也仍因"无可核对表项"留在阻断 ——
  这是刻意的保守选择，需要时再逐个补表并补验证。
- `documentedLimitations` 是**机器可读的书面限制**，不是豁免；它照样出现在 `THIRD-PARTY-NOTICES.md` 的 "Source evidence limitations" 段里。
