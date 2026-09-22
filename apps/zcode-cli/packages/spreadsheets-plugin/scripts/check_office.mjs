#!/usr/bin/env node
// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      scripts/check_office.py（derived-from-dsh，MIT）的 Node 重写。
//            对外契约（checks.json 的 format/verdict/checks/summary、退出码 0/1/2、
//            4 个 MAX_* 预算常量、媒体不计入读内存预算）与 .py 逐项一致；
//            逐项对照与真跑对比见 .reverse/28-office-provenance/OFFICE-CHECKER-JS.md。
// 本模块:    入口 —— 只负责跑流程并设置退出码，实现按职责拆在 lib/ 下。
// 同名副本:  三份（documents/presentations/spreadsheets）必须逐字节相同，改一处同步三处
// 回归测试:  apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
// ---------------------------------------------------------------------------
/**
 * Read-only OOXML checks and structural summaries; no rendering or formula evaluation.
 *
 * Run with INPUT.docx, INPUT.pptx, or INPUT.xlsx. Optional --contains assertions
 * check extracted text; DOCX excludes comments, glossary text, and unreferenced parts or notes.
 * --count checks slides or sheets. JSON escapes non-ASCII characters and goes to stdout and
 * optionally --out. Exit 0 means the requested structural checks passed, 1 means a document,
 * assertion, or report write failed, and 2 means invalid command-line arguments.
 *
 * The input is treated as untrusted: decompression is bounded by the MAX_* budgets below,
 * and any failure — including running out of memory — is reported as a structured fail
 * check with a readable detail instead of an empty stdout.
 *
 * 为什么拆成 lib/ 下的多个模块：本文件原先单文件 1600+ 行，超出仓库「单文件默认不超过
 * 400 行」的约束。拆分按**依赖方向单向**进行：
 *   office-spec（规格/错误） → office-xml-lex（词法） → office-xml-decl（声明校验）
 *   → office-xml-tree（元素树） → office-xml-scan（扫描 + 元素预算）
 *   → office-zip（ZIP 只读子集） → office-parts（OOXML 检查） → office-cli → office-main
 * 没有循环依赖，也没有把状态散到多处：唯一的共享可变状态是元素预算对象（PackageBudget），
 * 由 office-main 创建、逐层传入。
 *
 * 为什么不用 jszip/fflate 之类的现成库：三个插件是随包分发的纯内容插件，载荷里每多一个
 * 依赖就多一份体积与许可负担；这里需要的只是「读中央目录 + inflateRaw + CRC32」三件事，
 * node:zlib 与 node:fs 已经足够（与 .py 只用标准库同理）。
 */

import { runCheckOffice } from "./lib/office-main.mjs";

process.exitCode = await runCheckOffice();
