/**
 * 机器人入站附件的两个上限常量。
 *
 * 为什么单独放一个无依赖的叶子模块（task-111）：
 * 这两个常量必须能从 browser-safe 的根入口 @zcode/services 导出
 * （packages/server 的 botIngress 用它们推导请求体上限，见 botsService.ts 的耦合注释），
 * 但它们原先定义在 botsService.ts 里 —— 而那个模块 import ./attachmentUrlGuard.js，
 * 后者 import undici（Node-only）。于是根入口的导出闭包被拉进 undici，
 * 而 Vite 会把 undici 顶层的 `process.versions.node.split('.')` 原样打进浏览器产物
 * ⇒ ReferenceError: process is not defined ⇒ Web 客户端白屏（真浏览器实测）。
 *
 * 本文件不得引入任何依赖：它存在的全部意义就是让根入口能安全地拿到这两个值。
 * 见 index.ts 里那条 re-export 的注释与 node.ts 的 browser-safe 约定。
 */

/** 单条消息最多处理的附件数。改这里必须同步重算 /bot/** 的请求体上限（见 botsService.ts）。 */
export const BOT_MAX_ATTACHMENTS_PER_MESSAGE = 4;

/** 单个附件的字节上限（5 MiB）。改这里必须同步重算 /bot/** 的请求体上限。 */
export const BOT_MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
