/**
 * macOS 自动更新可用性判定（纯函数模块，不导入 electron）。
 *
 * 为什么单独成模块而不是内联进 autoUpdater.ts：
 * autoUpdater.ts 顶部静态导入 electron 与 electron-updater，在 node:test 里无法加载
 * （desktop 包既有测试纪律，见 packages/desktop/test/remoteAssetCdnSettingPriority.test.ts
 * 顶部注释）。把「哪些组合跳过更新检查」这段判定抽成纯模块，才能用可执行测试钉住判定矩阵
 * 与「判定真的被入口调用」两件事（见 packages/desktop/test/autoUpdateDarwinAvailability.test.ts
 * 与 autoUpdaterDarwinSkip.test.ts）。
 *
 * 背景（issue #2 症状二）：发行线发布未签名 macOS 安装包（darwin x64 + arm64 的 dmg/zip，
 * ad-hoc 签名、不公证，见 docs/operations/release.md §平台支持），electron-updater 在 macOS
 * 保持关闭——未签名包不具备自动更新链路所需的签名校验基础。客户端在 darwin 正式包上显式
 * 跳过更新检查（三条件：darwin + 打包态 + 未配置更新源覆盖），用确定性提示替代更新请求
 * 失败噪音，引导用户从 GitHub Releases 手动下载新版本（见 136-darwin-auto-update-skip）。
 */

/**
 * 判定当前运行形态是否应跳过自动更新检查。
 *
 * 只在三个条件同时成立时跳过：
 * 1. platform === "darwin"；
 * 2. 打包态（app.isPackaged）——开发态（ZCODE_AUTO_UPDATE_DEV）是本地 manifest 验证链路，
 *    保持可用（autoUpdater.ts 的 isDevSquirrelReadyError 等分支依赖它）；
 * 3. 未配置更新源覆盖——镜像 / 自建 feed 是另一种部署形态，其 manifest 是否提供 macOS 包
 *    由部署方决定，不由本发行线的签名策略反推禁用（保留自托管 feed 路径不变）。
 *
 * @param input.platform 进程平台，传 process.platform
 * @param input.isPackaged 是否打包态，传 app.isPackaged
 * @param input.updateFeedUrl 更新源覆盖 URL，未配置传 undefined / 空串
 */
export function shouldSkipAutoUpdateCheckOnDarwinRelease(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  updateFeedUrl?: string | null;
}): boolean {
  if (input.platform !== "darwin" || !input.isPackaged) {
    return false;
  }
  return !input.updateFeedUrl?.trim();
}
