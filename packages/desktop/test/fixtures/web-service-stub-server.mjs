// 测试用替身服务：模拟 packages/server/src/entry-http.ts 的环境契约、/api/server-info 行为，
// 以及 spec §6.4 的连接面三端点（连接清单 / 撤销 / 轮换令牌）。
// 真实验收要打到随包的 zcode-server-http.cjs，但那条入口的构建归属在 task-78 的另一步
// （packages/server/build-remote.ts 新入口）—— 这里替身只负责"是一个真的、可杀的、按令牌鉴权的 HTTP 进程"，
// 让编排层的幂等/停止/陈旧判定能用真实子进程跑到。
//
// 连接面端点为什么也放这里：桌面 main 的 remoteControlClient 要真的发 HTTP 才谈得上接线正确。
// 用同一个替身进程既验服务面（探活）又验连接面（读/写端点），比再起一个假 fetch 更接近最终消费点。
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

const port = Number(process.env.PORT) || 0;
const host = process.env.ZCODE_SERVER_HOST?.trim() || "127.0.0.1";
const tokenFile = process.env.ZCODE_SERVER_AUTH_TOKENS_FILE?.trim();
/** 可选：把每次请求（方法/路径/查询串/体）追加成一行 JSON，供测试断言"写动作走了哪个端点"。 */
const recordFile = process.env.REMOTE_CONTROL_RECORD_FILE?.trim();
/** 可选：连接清单要返回的 connections 数组字面量（便于逐档构造空态/畸形/带多余字段）。 */
const connectionsJson = process.env.REMOTE_CONTROL_CONNECTIONS_JSON?.trim();

function readToken() {
  if (!tokenFile) return undefined;
  try {
    for (const line of readFileSync(tokenFile, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const first = t.split(/\s+/)[0];
      if (first) return first;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function record(entry) {
  if (!recordFile) return;
  try {
    appendFileSync(recordFile, JSON.stringify(entry) + "\n");
  } catch {
    // 记录失败不影响替身行为：它是测试的可观测面，不是被测行为。
  }
}

function readBody(req) {
  return new Promise((done) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => done(raw));
    req.on("error", () => done(""));
  });
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const provided =
    url.searchParams.get("token") ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const expected = readToken();

  // 与真实服务端同口径：受保护路径先过令牌（/api/* 全在令牌白名单内）。
  if (!expected || provided !== expected) {
    record({ method: req.method, path: url.pathname, query: url.search, status: 401 });
    json(res, 401, { error: "unauthorized" });
    return;
  }

  if (url.pathname === "/api/server-info") {
    json(res, 200, { name: "stub-server", version: "0.0.0", pid: process.pid });
    return;
  }

  // ── spec §6.4 连接面 ──────────────────────────────────────────────────────
  if (url.pathname === "/api/remote-control/connections" && req.method === "GET") {
    const connections = connectionsJson ? JSON.parse(connectionsJson) : [];
    record({ method: req.method, path: url.pathname, query: url.search, status: 200 });
    json(res, 200, { connections, revision: 7 });
    return;
  }

  if (url.pathname === "/api/remote-control/connections/revoke" && req.method === "POST") {
    const body = await readBody(req);
    record({ method: req.method, path: url.pathname, query: url.search, status: 200, body });
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      json(res, 400, { error: "malformed json" });
      return;
    }
    const hasId = parsed && parsed.id !== undefined;
    const hasAll = parsed && parsed.all !== undefined;
    if (hasId === hasAll) {
      json(res, 400, { error: "exactly one of id|all" });
      return;
    }
    // 幂等：不存在的 id 也返回 200 + revoked:0（spec §6.4）。
    json(res, 200, { revoked: hasAll ? 2 : 1 });
    return;
  }

  if (url.pathname === "/api/remote-control/rotate-token" && req.method === "POST") {
    const body = await readBody(req);
    // 可配置的状态码：task-16 实测「没有配置文件令牌的部署」下 rotate-token 返回 409
    // （不是静默 no-op、也不是 200）。替身要能复现这条，否则 main 侧的错误语义没被测过。
    const status = Number(process.env.REMOTE_CONTROL_ROTATE_STATUS) || 200;
    record({ method: req.method, path: url.pathname, query: url.search, status, body });
    if (status !== 200) {
      json(res, status, { error: "rotate-token unavailable in this deployment" });
      return;
    }
    json(res, 200, { rotatedAt: 1_700_000_000_000 });
    return;
  }

  record({ method: req.method, path: url.pathname, query: url.search, status: 404 });
  res.writeHead(404).end("not found");
});

server.listen(port, host, () => {
  process.stdout.write("stub-listening\n");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
