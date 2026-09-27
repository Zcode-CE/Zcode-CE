// 许可材料证据档位：档位表、标准条款表、以及逐条判据的核对。
//
// 为什么从 third-party-npm.mjs 拆出来：那份文件已经承担"生产依赖图 + 通知收集"，
// 再放进两档判据就超过 400 行的 max-lines（HEAD 时 362 行可计数行，加判据后 461）。
// 拆分的判据是**内聚性**而不是"行数超了" —— 本模块整体是"手上这份材料够不够"这一个问题，
// 与"包有没有装、图对不对"无关；两档判据也共享同一套条款表与判定流程。
//
// 档位语义与判据的读者文档是 third-party/README.md §3（含 §3.1 / §3.1.1 / §3.2）。

/**
 * 许可材料证据档位表。
 *
 * fail-closed：只有在本表里显式登记为 `blocking: false`、且运行时判据核对全部通过的
 * 档位才不阻断发布门禁。未登记的 `evidenceKind`（含拼写错误）一律按阻断处理。
 *
 * 档位语义与判据见 `third-party/README.md`：
 * - `publisher-declared-standard-terms`：发布者已发布的 SPDX 声明 + 对应标准未修改条款文本
 *   + 已发布的发布者版权主体 + 已记录的出处与版本锁定。四条同时成立才非阻断。
 *   非阻断不等于"材料齐全"，只表示"我们不再把发布者已发布的声明当作缺失"。
 * - `pinned-upstream-license-file`：登记的是上游仓库里 pin 住的许可文件原文。
 *   它与上面那档是并列的两档，不是包含关系，因为两者的材料种类不同：
 *   这一档的凭据是"上游发布过一份真实许可文件"，那档的凭据是"发布者在已发布物里声明了标识"。
 *   判据因此也不同：本档要求（甲）上游确实在 pinned ref 上发布了许可文件、
 *   （乙）已发布物声明的每一个标识的标准条款都在我们分发的内容里、
 *   （丙）发布者版权主体可核、（丁）出处与版本锁定。
 *   凡是缺一条就回到阻断 —— 本档不降低任何一档的强度，只是把"材料确实齐"的条目放行。
 * - `incomplete-unverified`：声明缺失、含糊，或文本是自定义条款 ⇒ 阻断。
 */
export const EVIDENCE_TIERS = new Map([
  ["publisher-declared-standard-terms", { blocking: false, guard: "published-declaration" }],
  ["pinned-upstream-license-file", { blocking: false, guard: "pinned-upstream-file" }],
  ["incomplete-unverified", { blocking: true, guard: null }],
]);

/**
 * 每个 SPDX 标识对应的标准条款片段（逐行照抄，避免跨行断句）。
 *
 * 判据只核对"我们随包分发的通知文本里确实包含该标识的标准条款"。
 * 它不能证明文本未被改动过——那是人工复核的职责；但它能拦住"换成自定义文案"
 * 这类会让门禁静默变绿的情况。没有表项的标识一律判为无法核对 ⇒ 阻断（fail-closed）。
 */
export const STANDARD_CLAUSES = new Map([
  [
    "MIT",
    [
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    ],
  ],
  [
    "ISC",
    [
      "Permission to use, copy, modify, and/or distribute this software for any",
      "purpose with or without fee is hereby granted, provided that the above",
    ],
  ],
  [
    "BSD-3-Clause",
    [
      "Redistribution and use in source and binary forms, with or without",
      "3. Neither the name of the copyright holder nor the names of its contributors",
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
    ],
  ],
  [
    "BSD-2-Clause",
    [
      "Redistribution and use in source and binary forms, with or without",
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
    ],
  ],
  [
    "Apache-2.0",
    [
      'Licensed under the Apache License, Version 2.0 (the "License");',
      "http://www.apache.org/licenses/LICENSE-2.0",
    ],
  ],
]);

/**
 * `pinned-upstream-license-file` 档可核对的条款表 = 上面那张 + MPL-2.0。
 *
 * 为什么单开一张、不直接往 STANDARD_CLAUSES 里加 MPL-2.0：
 * STANDARD_CLAUSES 是 `publisher-declared-standard-terms` 档的判据表，改动它会顺带改变
 * 那一档的语义（third-party/README.md §8 明写"MPL-2.0 因无可核对表项而刻意留在阻断"）。
 * 本次批准的范围只是新开一档，不是放宽既有档，所以两档各用各的表。
 */
export const PINNED_UPSTREAM_CLAUSES = new Map([
  ...STANDARD_CLAUSES,
  [
    "MPL-2.0",
    [
      "Mozilla Public License Version 2.0",
      "1. Definitions",
      "3. Responsibilities",
      "Exhibit A - Source Code Form License Notice",
      "You may add additional accurate notices of copyright ownership.",
    ],
  ],
]);

/**
 * 我们另行随包分发的标准条款全文（SPDX 标识 → 仓库内路径）。
 *
 * 为什么需要这张表，而不是把全文并进每一条 override 的快照：
 * 快照的价值在于它与上游文件逐字节同一份（可用 sha256 对着 pinned tag 复核）。
 * 一旦往快照里拼全文，这个可复核性质就没了。所以两者分开：
 * 快照证明"上游发布了什么"，本表证明"我们分发了什么"。
 *
 * 现有的 Apache-2.0 走的是同一条通路（见 generate-third-party-notices.mjs）。
 * MPL-2.0 进来是因为 @ubjs/* 的上游 LICENSE 只有 Exhibit A 短通知（192 B）——
 * 短通知本身可辩护（它自己写明"若未随文件分发副本可从该 URL 取得"），
 * 但 MPL 的义务不止保留通知，还有源码可提供，所以随包给全文。
 */
export const SHIPPED_STANDARD_TEXTS = {
  "MPL-2.0": "scripts/license-texts/MPL-2.0.txt",
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function declaredLicenseText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(declaredLicenseText).filter(Boolean).join(" OR ");
  return value?.type?.trim() ?? "";
}

export function publisherSubjectText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(publisherSubjectText).filter(Boolean).join(", ");
  if (value && typeof value === "object") return String(value.name ?? "").trim();
  return "";
}

/** 某个标识是否以独立词出现（避免 MIT 命中 MIT/X11 之外的同名子串）。 */
export function mentionsIdentifier(text, identifier) {
  if (!text) return false;
  return new RegExp(
    `(?:^|[^A-Za-z0-9.-])${escapeRegExp(identifier)}(?:[^A-Za-z0-9.-]|$)`,
    "u",
  ).test(text);
}

/** 按 AND/OR 拆开 SPDX 表达式（判据要逐标识核，不能只看首项）。 */
export function splitLicenseIds(value) {
  return String(value ?? "")
    .split(/\s+(?:AND|OR)\s+/iu)
    .map((part) => part.trim())
    .filter(Boolean);
}
