import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { ConversationShareContinuation } from "@zcode/shared";
import {
  BotAttachmentUrlRejectedError,
  setBotAttachmentAllowedHosts,
  setBotAttachmentDnsResolver,
} from "../src/bots/attachmentUrlGuard.js";
import { ConversationShareServiceError } from "../src/conversation-share/conversationShare.js";
import {
  defaultConversationShareArtifactDownloader,
  downloadConversationShareArtifact,
} from "../src/conversation-share/conversationShareArtifactDownload.js";

/**
 * 会话分享 artifact 下载的 SSRF 回归（S5）。
 *
 * 背景：downloadArtifactBytes 有超时、Content-Length 预检、SHA-256 校验，
 * 但 artifact.download_url 来自分享服务返回的 continuation（发布方控制），
 * 导入侧服务端会 fetch 发布方指定的任意 URL——盲 SSRF + 状态/大小/耗时 oracle。
 *
 * 判别实验（与 S1 同构）：起一个 127.0.0.1 探针 server，把 download_url 指向它。
 * 用例 1 注入的是修复前的默认实现（裸 fetch）：修复前它会命中探针 1 次，
 * 修复后 choke point 在任何请求之前拒绝 ⇒ 0 次命中。这是机器检查的反向断言：
 * 删掉 downloadConversationShareArtifact 里的 assertAllowedAttachmentUrl，
 * hits 立刻变 1，本文件即失败。
 *
 * 运行：cd packages/services && node --import tsx --test test/conversationShareArtifactDownload.test.ts
 */

function sampleArtifact(overrides: Partial<SampleArtifact> = {}): SampleArtifact {
  return {
    artifact_id: "art-1",
    logical_artifact_key: "doc-1",
    producer_product_turn_id: "turn-1",
    artifact_version: 1,
    state: "current",
    ref: "zcode-artifact://share/art-1",
    artifact_type: "md",
    display_name: "notes.md",
    extension: "md",
    mime_type: "text/markdown",
    size_bytes: 4,
    sha256: "0".repeat(64),
    download_url: "http://127.0.0.1/ssrf-probe",
    download_url_expires_at: 0,
    ...overrides,
  };
}

type SampleArtifact = ConversationShareContinuation["artifacts"][number];

/** 起 127.0.0.1 探针 server，返回 hits 计数与探针 URL。 */
async function startProbeServer(): Promise<{
  url: (path: string) => string;
  hits: () => string[];
  close: () => Promise<void>;
}> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "(no url)");
    res.writeHead(200, { "content-type": "text/markdown" });
    res.end(new Uint8Array(4));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    hits: () => hits.slice(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const downloader = (url: string, init?: { signal?: AbortSignal }) =>
  fetch(url, { signal: init?.signal });

test("choke point：注入修复前的裸 fetch 实现 + 探针 server ⇒ 拒绝且 0 命中", async () => {
  const probe = await startProbeServer();
  try {
    await assert.rejects(
      () =>
        downloadConversationShareArtifact(
          sampleArtifact({ download_url: probe.url("/ssrf-probe") }),
          { timeoutMs: 5_000, download: downloader },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ConversationShareServiceError, "必须是服务错误");
        assert.equal(error.kind, "invalid_contract");
        assert.equal(error.issues?.[0]?.code, "unsafe_url");
        return true;
      },
    );
    assert.deepEqual(probe.hits(), [], "SSRF 目标不得被请求");
  } finally {
    await probe.close();
  }
});

test("默认下载实现：指向回环的 download_url 同样被拒绝", async () => {
  const probe = await startProbeServer();
  try {
    // 默认下载走 fetchBotAttachmentFromUrl（连接期判据也生效），但它前面还有
    // choke point——两层都会拒绝，先命中者决定错误形态，故两种都接受。
    await assert.rejects(() =>
      downloadConversationShareArtifact(sampleArtifact({ download_url: probe.url("/x") }), {
        timeoutMs: 5_000,
      }),
    );
    assert.deepEqual(probe.hits(), [], "SSRF 目标不得被请求");
  } finally {
    await probe.close();
  }
});

test("默认下载实现本身（不经过 choke point）：回环地址由连接期判据拒绝", async () => {
  const probe = await startProbeServer();
  try {
    await assert.rejects(
      () => defaultConversationShareArtifactDownloader(probe.url("/x")),
      (error: unknown) => {
        assert.ok(error instanceof BotAttachmentUrlRejectedError);
        assert.equal(error.reason, "blocked_address");
        return true;
      },
    );
    assert.deepEqual(probe.hits(), [], "SSRF 目标不得被请求");
  } finally {
    await probe.close();
  }
});

test("默认下载实现导出与内部默认一致（装配侧复用同一份判据）", () => {
  assert.equal(typeof defaultConversationShareArtifactDownloader, "function");
});

test("合法公网目标放行（假 DNS 解析到公网地址，注入实现被调用）", async () => {
  setBotAttachmentDnsResolver(async () => [{ address: "93.184.216.34", family: 4 }]);
  let requestedUrl: string | null = null;
  try {
    const result = await downloadConversationShareArtifact(
      sampleArtifact({ download_url: "http://artifacts.example.test/file.md" }),
      {
        timeoutMs: 5_000,
        download: async (url) => {
          requestedUrl = url;
          return new Response(new Uint8Array(4), {
            status: 200,
            headers: { "content-type": "text/markdown; charset=utf-8", "content-length": "4" },
          });
        },
      },
    );
    assert.equal(requestedUrl, "http://artifacts.example.test/file.md");
    assert.equal(result.bytes.byteLength, 4);
    assert.equal(result.responseMimeType, "text/markdown");
  } finally {
    setBotAttachmentDnsResolver(null);
  }
});

test("resolve 到私网的域名被拒绝（判据看解析后地址，不看字符串）", async () => {
  setBotAttachmentDnsResolver(async () => [{ address: "10.0.0.9", family: 4 }]);
  try {
    await assert.rejects(
      () =>
        downloadConversationShareArtifact(
          sampleArtifact({ download_url: "http://artifacts.example.test/file.md" }),
          { timeoutMs: 5_000, download: downloader },
        ),
      ConversationShareServiceError,
    );
  } finally {
    setBotAttachmentDnsResolver(null);
  }
});

test("Content-Length 预检：声明超过 size_bytes ⇒ artifact_changed", async () => {
  setBotAttachmentDnsResolver(async () => [{ address: "93.184.216.34", family: 4 }]);
  let bodyRead = false;
  try {
    await assert.rejects(
      () =>
        downloadConversationShareArtifact(
          sampleArtifact({ download_url: "https://public.example.test/file.md", size_bytes: 4 }),
          {
            timeoutMs: 5_000,
            download: async () => {
              bodyRead = true;
              return new Response(new Uint8Array(100), {
                status: 200,
                headers: { "content-length": "100" },
              });
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ConversationShareServiceError);
        assert.equal(error.kind, "invalid_contract");
        assert.equal(error.issues?.[0]?.code, "artifact_changed");
        assert.equal(error.issues?.[0]?.actual, 100);
        assert.equal(error.issues?.[0]?.limit, 4);
        return true;
      },
    );
  } finally {
    setBotAttachmentDnsResolver(null);
  }
});

test("超时：挂住的下载实现按 network 超时失败", async () => {
  setBotAttachmentDnsResolver(async () => [{ address: "93.184.216.34", family: 4 }]);
  try {
    await assert.rejects(
      () =>
        downloadConversationShareArtifact(
          sampleArtifact({ download_url: "https://public.example.test/file.md" }),
          {
            timeoutMs: 50,
            download: (_url, init) =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
              }),
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ConversationShareServiceError);
        assert.equal(error.kind, "network");
        assert.match(error.message, /timed out/);
        return true;
      },
    );
  } finally {
    setBotAttachmentDnsResolver(null);
  }
});

test("放行项：登记主机后内网目标可下载（默认安全 + 用户可显式放宽）", async () => {
  setBotAttachmentAllowedHosts(["127.0.0.1"]);
  const probe = await startProbeServer();
  try {
    const result = await downloadConversationShareArtifact(
      sampleArtifact({ download_url: probe.url("/allowed") }),
      { timeoutMs: 5_000, download: downloader },
    );
    assert.equal(result.bytes.byteLength, 4);
    assert.deepEqual(probe.hits(), ["/allowed"]);
  } finally {
    await probe.close();
    setBotAttachmentAllowedHosts([]);
  }
});
