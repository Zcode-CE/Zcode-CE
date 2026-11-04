import assert from "node:assert/strict";
import test from "node:test";
import { expandCliCustomCommandPrompt } from "../src/custom-command-expand.js";

/**
 * 自定义命令里的 `!` shell 块不再在解析阶段执行，而是改写成交给模型的 Bash 指令（X24，3.17.2 移植）。
 *
 * 为什么必须钉住：改前 `expandCliCustomCommandPrompt` 对含 `!` 的命令直接抛「unsupported shell
 * expansion」，而 bootstrap 侧曾在解析阶段直接执行 shell（该实现已在上游 3.17.2 中删除）——
 * 完全绕过权限系统，是提示注入可直达的副作用通道。改后只改写文本，执行交给模型的 Bash 工具调用，
 * 由权限服务决定放行、询问或拒绝。
 *
 * 运行：cd apps/zcode-cli/packages/cli && node --import tsx --test test/customCommandShellHandoff.test.ts
 */

const metadata = { name: "deploy", scope: "project", source: "agents" };

test("行内 `!` 块改写成交给模型的 Bash 指令，原文形态不再出现", () => {
  const expanded = expandCliCustomCommandPrompt({
    args: "",
    // 行内写法要求 `!` 在行首或空白之后（避免把 `Warning!` 这类正文误判成命令），这里按真实写法留空格。
    command: { content: "先跑测试 !`pnpm test`", metadata },
  });
  assert.match(expanded.prompt, /Run it with the Bash tool exactly as written/);
  // 说明文字必须写明这一步来自命令文件，模型据此按外部内容对待它。
  assert.match(expanded.prompt, /the \/deploy command file \(project\/agents\)/);
  assert.match(expanded.prompt, /pnpm test/);
  assert.doesNotMatch(expanded.prompt, /!`pnpm test`/);
});

test("围栏 `!` 块同样改写，多行命令保持完整", () => {
  const expanded = expandCliCustomCommandPrompt({
    args: "",
    command: { content: "```!\nnpm ci\nnpm run build\n```", metadata },
  });
  assert.match(expanded.prompt, /Run it with the Bash tool exactly as written/);
  assert.match(expanded.prompt, /npm ci\nnpm run build/);
  assert.doesNotMatch(expanded.prompt, /```!/);
});

test("改写发生在参数替换之前：参数文本不会被当成 shell 块", () => {
  const expanded = expandCliCustomCommandPrompt({
    args: "!`rm -rf /`",
    command: { content: "执行：$ARGUMENTS", metadata },
  });
  assert.doesNotMatch(expanded.prompt, /Run it with the Bash tool/);
  assert.match(expanded.prompt, /!`rm -rf \/`/);
});

test("Bash 拿不到的变量（skill 目录）整块不转交，避免审批看到的命令与实际执行不一致", () => {
  const expanded = expandCliCustomCommandPrompt({
    args: "",
    command: { content: "!`bash $ZCODE_SKILL_DIR/run.sh`", metadata },
  });
  assert.match(expanded.prompt, /was not run/);
  assert.match(expanded.prompt, /ZCODE_SKILL_DIR/);
  assert.doesNotMatch(expanded.prompt, /Run it with the Bash tool/);
});
