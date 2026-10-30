// CLI workspace 包的 canonical 构建顺序。
//
// 为什么单独一份：CLI 各包的 package.json 用 exports 指向 dist，tsc/NodeNext 解析
// `@zcode/*` 时依赖这些 dist 已存在。曾经三处各自维护顺序（桌面 agent 构建、
// bootstrap:with-remote 直跑 tsc、typecheck:cli），新增依赖时只更新其中一处，
// 干净 CI 就会在下一步以 `Cannot find module` 暴露。现在所有消费者都从这里派生。
//
// 顺序即依赖顺序，不要按字母重排：contracts/shared-types 先于 core，dynamic-workflow
// 必须在 core/adapters 之前，bootstrap 最后。
export const cliWorkspaceBuilds = [
  { packageName: "@zcode/shared-types", packageDir: "shared-types" },
  { packageName: "@zcode/contracts", packageDir: "contracts" },
  // dynamic-workflow 的 tsc 构建依赖 gitignored 的 libs.generated.ts；bare-tsc 路径
  // 不走 package build script，所以 prepareScript 由调用方显式执行。
  {
    packageName: "@zcode/dynamic-workflow",
    packageDir: "dynamic-workflow",
    prepareScript: "scripts/generate-libs.mjs",
  },
  { packageName: "@zcode/dynamic-workflow-runtime", packageDir: "dynamic-workflow-runtime" },
  { packageName: "@zcode/core", packageDir: "core" },
  { packageName: "@zcode/adapters", packageDir: "adapters" },
  { packageName: "@zcode/i18n", packageDir: "i18n" },
  // @zcode/telemetry 已随遥测移除（P1）整包删除，构建清单同步去掉 ——
  // 留着会让 `pnpm --filter @zcode/telemetry build` no-match 失败，
  // 影响 pre-dev:local-cli 与 prepare-agent-node-bundle。
  { packageName: "@zcode/bootstrap", packageDir: "bootstrap" },
];

// typecheck:cli 额外需要 @zcode/tui：CLI 的 TUI 运行时依赖，桌面 agent bundle 不导入它，
// 所以不放进上面的构建清单；但 cli 的 `tsc --noEmit` 必须能解析它的 dist。
export const cliTypecheckBuilds = [
  ...cliWorkspaceBuilds,
  { packageName: "@zcode/tui", packageDir: "tui" },
];
