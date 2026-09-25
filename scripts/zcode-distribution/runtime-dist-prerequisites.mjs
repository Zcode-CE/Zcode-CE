/**
 * TUI 运行时（SEA staging）需要、但不由 `pnpm --filter "@zcode/cli..." build` 产出的 workspace 构建工程。
 *
 * 为什么需要这份声明（实测，tag v3.14.3-ce.3 的 Release 流水线）：
 * `scripts/build-zcode.mjs` 的构建段只跑 `pnpm --filter "@zcode/cli..." build`，
 * 它覆盖 @zcode/cli 依赖闭包里"有 build 脚本"的包；没有 build 脚本的包会被 pnpm 静默跳过。
 * 而 `stageTuiRuntime`（scripts/zcode-distribution/assets.mjs）会把 TUI 运行时闭包里的
 * workspace 包整份 stage 进包，其中
 * `apps/zcode-cli/packages/cli/scripts/sea-runtime-package-resolution.mjs:37` 明确要求
 * 每个 workspace 包都有 dist/index.js（SEA 只携带 dist，见 sea-workspace-package-assets.mjs 的入口改写）。
 *
 * @zcode/shared 同时满足"在 TUI 闭包里"和"没有 build 脚本"（packages/shared/package.json
 * 的 scripts 只有 lint）⇒ 它的 dist 此前只由根 `pnpm typecheck` 的 `tsc -b` 产出
 * ⇒ 任何没先跑 typecheck 的调用方都会在 stageTuiRuntime 处失败。
 * 实测：干净检出里 `node scripts/build-zcode.mjs --allow-placeholder-base-url` 报
 * `Missing @zcode/shared dist files`，与 CI 日志逐字一致；而根 `pnpm build`（= pnpm -r build）
 * 同样不产出它 —— 所以这不是"CI 少了一步"，是构建脚本自身不完整。
 *
 * 为什么写成显式清单而不是自动发现：与 build-zcode.mjs 里旁路模块的拷贝清单同口径 ——
 * 名字写死才能在"新增一个无 build 脚本的 workspace 运行时包"时立刻在评审里看见，
 * 自动发现会把这类遗漏变成静默通过。
 * `scripts/test/runtimeDistPrerequisites.test.mjs` 会按 TUI 运行时闭包对账这份清单。
 *
 * 取值是相对仓库根的目录；构建命令为 `pnpm exec tsc -b <目录...>`（这些包是 tsc 工程，不是 pnpm script）。
 */
export const tuiRuntimeWorkspaceBuildProjects = ["packages/shared"];
