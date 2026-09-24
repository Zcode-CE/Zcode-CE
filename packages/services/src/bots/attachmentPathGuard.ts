import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getAppConfigDir } from "../paths.js";

/**
 * Bot 入站附件的本地路径校验（任意文件读防护）。
 *
 * 背景：webhook 渠道的入站 payload 里 `attachments[].localPath` 完全由请求方控制
 * （providers/webhookProvider.ts:99-101 直接透传），botsService 又对它直接
 * `readFile(attachment.localPath)`（botsService.ts:1122-1126）。原实现没有任何路径校验，
 * 于是「能打到入站面的人」可以读本机任意文件（~/.ssh/id_rsa、凭据库、任意工作区源码）。
 *
 * 允许目录的定义与依据
 * --------------------
 * 只允许 bot 自己的附件缓存目录，即 `getAppConfigDir()/bot-attachments`。依据：
 *   1. 该目录是 botsService 自己创建并写入的唯一附件落点
 *      （`buildAttachmentCachePath`，botsService.ts:1065-1082）；
 *   2. `localPath` 在这条链路上的唯一正当来源就是它 —— 上游的 provider 适配器
 *      要么给 `dataBase64`、要么给 `downloadUrl`，没有任何 provider 依赖外部传入的
 *      `localPath`（全仓 grep 只有 webhookProvider 从 payload 读它）；
 *   3. 因此「允许目录 = 附件缓存根」既能满足真实用途，又不给出任何额外的读取面。
 * 注意这里不是「允许用户配置一个目录列表」—— 那会把决策权交给配置，而配置同样
 * 可以被写；单一固定根更小、更可审。
 *
 * 校验口径（为什么不是字符串前缀比较）
 * ------------------------------------
 *   · 先 `resolve` 成绝对路径再比，避免 `..` 穿越；
 *   · 再 `realpath` 解析符号链接 —— 否则缓存目录里一个指向 /etc 的软链就能绕过；
 *   · 比较用「相对路径不以 .. 开头」，而不是 `startsWith(root)`：后者会让
 *     `/root/bot-attachments-evil` 被误判为在 `/root/bot-attachments` 内；
 *   · Windows 下大小写不敏感，统一按平台规则比较（`sep` 与 relative 天然处理分隔符）。
 */

export class BotAttachmentPathRejectedError extends Error {
  readonly code = "bot_attachment_path_rejected";

  constructor(
    readonly localPath: string,
    readonly allowedRoot: string,
    detail?: string,
  ) {
    super(
      `Bot attachment localPath is outside the allowed directory. ` +
        `Allowed: ${allowedRoot}. Received: ${localPath}.` +
        (detail ? ` (${detail})` : "") +
        " Pass the attachment inline as dataBase64 or as a downloadUrl instead of a local path.",
    );
    this.name = "BotAttachmentPathRejectedError";
  }
}

/** bot 附件缓存的唯一允许根目录。 */
export function botAttachmentAllowedRoot(): string {
  return resolve(getAppConfigDir(), "bot-attachments");
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

/**
 * 校验并返回可安全读取的绝对路径。
 *
 * 越权时抛 `BotAttachmentPathRejectedError`（可操作错误：说明允许目录、收到的路径、
 * 以及替代做法），不返回 null —— 调用方据此给用户明确失败而不是静默跳过附件。
 */
export async function resolveAllowedAttachmentLocalPath(localPath: string): Promise<string> {
  const root = botAttachmentAllowedRoot();
  if (!localPath.trim()) {
    throw new BotAttachmentPathRejectedError(localPath, root, "empty path");
  }
  // 相对路径不以「进程 cwd」为基准解释：那会让校验结果依赖启动目录。
  // 只接受绝对路径，语义明确。
  if (!isAbsolute(localPath)) {
    throw new BotAttachmentPathRejectedError(localPath, root, "path is not absolute");
  }

  const resolved = resolve(localPath);
  if (!isInsideDirectory(root, resolved)) {
    throw new BotAttachmentPathRejectedError(localPath, root);
  }

  // 符号链接必须在比较之后解析：缓存目录内一个指向外部的软链会绕过纯字符串判定。
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpath(root);
    realCandidate = await realpath(resolved);
  } catch {
    // 根目录或文件不存在：交给调用方的 readFile 报真实错误（保持原有 not-found 语义）。
    return resolved;
  }
  if (!isInsideDirectory(realRoot, realCandidate)) {
    throw new BotAttachmentPathRejectedError(localPath, root, "symlink escapes the allowed root");
  }
  return realCandidate;
}
