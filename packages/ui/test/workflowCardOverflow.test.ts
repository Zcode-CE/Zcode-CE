import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 工作流卡表头右簇的可压缩性（上游 3.14.3 的「卡片按钮被挤出界面」修复）。
 *
 * 为什么这两条断言是配套的，缺一不可（浏览器实测，1280x800 Chromium；实测脚本在
 * .reverse/90-upstream-v3143/overflow-harness/ 下，该目录是分析区、不随仓库分发）：
 *
 * - 只去掉簇的 min-w-0（其余不变）：零溢出的下限由 220px 退到 480px；
 * - 只去掉细节串的 min-w-0 truncate：下限退到 280px（带待答芯片时 340px）；
 * - 两处都去掉（即修复前的形态）：下限 480px，440px 卡宽时两个按钮一起右移 17px。
 *
 * 原因是 flex item 的 automatic minimum size 等于 min-content，而 truncate 的
 * white-space:nowrap 让细节串的 min-content 就是整串字宽 —— 只写子元素的 min-w-0
 * 不够，簇自己不缩，按钮照样被顶出卡外。所以「簇有 min-w-0」与「细节串能截断」
 * 必须同时成立，只钉一处会让另一半静默回归。
 *
 * 运行：cd packages/ui && node --import tsx --test test/workflowCardOverflow.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const CHROME_SOURCE = "src/components/workflow-timeline/WorkflowCardChrome.tsx";

/** 从 from 往前找最近的一个 <span 开标签，返回它的 class 串（找不到返回 null）。 */
function classNameOfNearestSpanBefore(source: string, from: number): string | null {
  const open = source.lastIndexOf("<span", from);
  if (open === -1) return null;
  const tagEnd = source.indexOf(">", open);
  if (tagEnd === -1) return null;
  const tag = source.slice(open, tagEnd);
  const match = /className="([^"]*)"/.exec(tag);
  return match?.[1] ?? null;
}

test("表头右簇可压缩：簇上必须有 min-w-0，不能再是 shrink-0", () => {
  const source = readFileSync(join(packageRoot, CHROME_SOURCE), "utf8");
  const detailAt = source.indexOf('data-testid="workflow-card-detail"');
  assert.notEqual(detailAt, -1, "找不到细节串，测试已与实现脱节");
  // 簇是细节串之前、{leading} 插槽之前的那个 span。
  const leadingAt = source.lastIndexOf("{leading}", detailAt);
  assert.notEqual(leadingAt, -1, "找不到右簇的 {leading} 插槽，测试已与实现脱节");
  const cluster = classNameOfNearestSpanBefore(source, leadingAt);
  assert.notEqual(cluster, null, "找不到右簇的开标签");
  assert.ok(
    cluster!.split(/\s+/).includes("min-w-0"),
    "右簇缺少 min-w-0（当前 " + cluster + "）：簇的地板会等于「整串细节 + 按钮」，按钮被顶出卡外",
  );
  assert.equal(
    cluster!.split(/\s+/).includes("shrink-0"),
    false,
    "右簇不能是 shrink-0（当前 " + cluster + "）：它一个像素都不会缩，负空间无处可去",
  );
});

test("细节串可截断：min-w-0 与 truncate 必须成对出现", () => {
  const source = readFileSync(join(packageRoot, CHROME_SOURCE), "utf8");
  const detailAt = source.indexOf('data-testid="workflow-card-detail"');
  assert.notEqual(detailAt, -1, "找不到细节串，测试已与实现脱节");
  const detail = classNameOfNearestSpanBefore(source, detailAt);
  assert.notEqual(detail, null, "找不到细节串的开标签");
  const classes = detail!.split(/\s+/);
  assert.ok(classes.includes("min-w-0"), "细节串缺少 min-w-0（当前 " + detail + "）");
  assert.ok(classes.includes("truncate"), "细节串缺少 truncate（当前 " + detail + "）");
});
