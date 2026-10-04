import type { ConversationShareContinuation } from "@zcode/shared";

import {
  assertAllowedAttachmentUrl,
  BotAttachmentUrlRejectedError,
  fetchBotAttachmentFromUrl,
} from "../bots/attachmentUrlGuard.js";
import {
  ConversationShareServiceError,
  type ConversationShareFailureIssue,
} from "./conversationShare.js";

/**
 * 会话分享 artifact 的下载（S5：导入侧的 SSRF 防护）。
 *
 * download_url 来自分享服务返回的 continuation，而 continuation 里的目标地址
 * 由发布方在创建分享时提供——导入侧此前只有超时、Content-Length 预检和
 * SHA-256 校验（这些做得都对），但请求本身可以发向任意内网 / 回环 / 云元数据
 * 地址（盲 SSRF：状态、大小、耗时皆可作 oracle；内容因 hash 校验无法注入对话，
 * 但网络请求已经发出）。判据与 bot 入站附件（S1）同一来源：attachmentUrlGuard
 * 的 DNS 判据——只公网、连接期 DNS pin、不跟随重定向。
 *
 * 两层防护各自独立承重（与 S1 的结构一致，单层被改掉时另一层仍拦得住）：
 *   1. choke point（downloadConversationShareArtifact 的入口）：URL 先过
 *      assertAllowedAttachmentUrl——任何下载实现（含注入的测试实现与未来
 *      宿主装配的自定义实现）都必须先过这一道；
 *   2. 默认下载实现（downloadConversationShareArtifactResponse）复用
 *      fetchBotAttachmentFromUrl：连接期 DNS pin（关闭「预检公网、实连私网」
 *      的 rebinding 窗口）+ 不跟随重定向（每跳重新判定，关闭「公网 302 到内网」）。
 */

/** 未注入下载实现时的默认实现：复用 bot 附件的 SSRF 加固 fetch。 */
async function downloadConversationShareArtifactResponse(
  url: string,
  init?: { signal?: AbortSignal },
): Promise<Response> {
  const { bytes, contentType } = await fetchBotAttachmentFromUrl(url, { signal: init?.signal });
  const headers = new Headers();
  if (contentType) {
    headers.set("content-type", contentType);
  }
  // Content-Length 由实际字节数合成：调用方据此做的 size 预检（> size_bytes 即判
  // artifact_changed）仍然成立。注意此时 body 已完整物化——「在读完前拒绝超大
  // 响应」这一资源保护从来不是靠 Content-Length 头实现的（恶意端可以省略或谎报
  // 头部，预检根本触不到），真正的界限是下载超时与后续的 size + SHA-256 校验。
  headers.set("content-length", String(bytes.byteLength));
  return new Response(bytes, { status: 200, statusText: "OK", headers });
}

export type ConversationShareArtifactDownloader = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

export interface ConversationShareArtifactDownloadOptions {
  /**
   * 单请求超时（含读 body）。挂住的连接会让导入无限停在 downloading 阶段
   * （undici 默认 ~300s 兜底，体验上等于卡死），因此必须有上限。
   */
  timeoutMs: number;
  /**
   * 注入的下载实现（主要供测试替换传输层）。
   * 注入不是豁免：无论注入与否，URL 都先过 SSRF choke point。
   */
  download?: ConversationShareArtifactDownloader;
}

export interface ConversationShareArtifactDownloadResult {
  bytes: Uint8Array;
  responseMimeType?: string;
}

/**
 * 下载单个 artifact 的字节：带 SSRF 判据（choke point + 默认 DNS pin 下载）、
 * 单请求超时（含读 body）与 Content-Length 预检。
 *
 * 从 ConversationShareService.downloadArtifactBytes 抽出为独立函数：
 * 这套判据需要在不装配整个 service（client / agent / session 依赖链）的前提下
 * 直接做判别实验（本地 127.0.0.1 探针 server + 假 DNS 解析）。
 */
export async function downloadConversationShareArtifact(
  artifact: ConversationShareContinuation["artifacts"][number],
  options: ConversationShareArtifactDownloadOptions,
): Promise<ConversationShareArtifactDownloadResult> {
  const artifactIssue = (
    code: ConversationShareFailureIssue["code"],
    extra?: { actual?: number; limit?: number },
  ): ConversationShareFailureIssue => ({
    code,
    scope: "artifact",
    artifactDisplayName: artifact.display_name,
    artifactType: artifact.artifact_type,
    extension: artifact.extension,
    mimeType: artifact.mime_type,
    phase: "downloading",
    ...(extra?.actual === undefined ? {} : { actual: extra.actual }),
    ...(extra?.limit === undefined ? {} : { limit: extra.limit }),
  });

  // S5 choke point：放在任何网络请求之前，且与下载实现无关。
  try {
    await assertAllowedAttachmentUrl(artifact.download_url);
  } catch (error) {
    if (error instanceof BotAttachmentUrlRejectedError) {
      // 策略性拒绝不可重试（重试不会改变目标地址），用 invalid_contract 上报：
      // 分享契约里给出的下载地址不可接受。issue 复用 unsafe_url（发布侧已有
      // UI 文案），保持错误面不膨胀。
      throw new ConversationShareServiceError(
        "invalid_contract",
        "Conversation artifact download URL rejected",
        {
          issues: [artifactIssue("unsafe_url")],
          cause: error,
        },
      );
    }
    throw error;
  }

  const download = options.download ?? downloadConversationShareArtifactResponse;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await download(artifact.download_url, { signal: controller.signal });
    if (!response.ok) {
      throw new ConversationShareServiceError("network", "Conversation artifact download failed", {
        issues: [artifactIssue("unknown")],
      });
    }
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > artifact.size_bytes) {
      // body 已确定不会通过校验：先中断连接再抛错，不把超大响应读进内存。
      controller.abort();
      throw new ConversationShareServiceError(
        "invalid_contract",
        "Conversation artifact integrity check failed",
        {
          issues: [
            artifactIssue("artifact_changed", {
              actual: declaredBytes,
              limit: artifact.size_bytes,
            }),
          ],
        },
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const responseMimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    return { bytes, responseMimeType };
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof ConversationShareServiceError)) {
      throw new ConversationShareServiceError(
        "network",
        "Conversation artifact download timed out",
        {
          issues: [artifactIssue("unknown")],
        },
      );
    }
    throw error;
  } finally {
    clearTimeout(abortTimer);
  }
}

/** 装配侧的默认下载实现导出（供 ConversationShareService 构造时复用同一份）。 */
export const defaultConversationShareArtifactDownloader = downloadConversationShareArtifactResponse;
