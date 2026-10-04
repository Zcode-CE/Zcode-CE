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
 * 背景（issue #2 症状二）：本发行线只发布 Linux 与 Windows 安装包（无 macOS 代码签名证书，
 * 见 docs/operations/release.md §平台支持），Release 里永不产生 latest-mac.yml。
 * macOS 正式包的 electron-updater 读 app-update.yml 走 github provider，请求必 404。
 * 方案 a：客户端在 darwin 正式包上显式跳过更新检查，用确定性提示替代 404 错误。
 */

/**
 * 判定当前运行形态是否应跳过自动更新检查。
 *
 * 只在三个条件同时成立时跳过：
 * 1. platform === "darwin"；
 * 2. 打包态（app.isPackaged）——开发态（ZCODE_AUTO_UPDATE_DEV）是本地 manifest 验证链路，
 *    保持可用（autoUpdater.ts 的 isDevSquirrelReadyError 等分支依赖它）；
 * 3. 未配置更新源覆盖——镜像 / 自建 feed 是另一种部署形态，其 manifest 是否提供 macOS 包
 *    由部署方决定，不由本发行线的缺失反推禁用（任务书要求保留自托管 feed 路径不变）。
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
