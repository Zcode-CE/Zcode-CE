// 测试用替身服务：模拟 packages/server/src/entry-http.ts 的环境契约与 /api/server-info 行为。
// 真实验收要打到随包的 zcode-server-http.cjs，但那条入口的构建归属在 task-78 的另一步
// （packages/server/build-remote.ts 新入口）—— 这里替身只负责"是一个真的、可杀的、按令牌鉴权的 HTTP 进程"，
// 让编排层的幂等/停止/陈旧判定能用**真实子进程**跑到。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const port = Number(process.env.PORT) || 0;
const host = process.env.ZCODE_SERVER_HOST?.trim() || "127.0.0.1";
const tokenFile = process.env.ZCODE_SERVER_AUTH_TOKENS_FILE?.trim();

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

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/api/server-info") {
    res.writeHead(404).end("not found");
    return;
  }
  const expected = readToken();
  const provided =
    url.searchParams.get("token") ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!expected || provided !== expected) {
    res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
    return;
  }
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ name: "stub-server", version: "0.0.0", pid: process.pid }));
});

server.listen(port, host, () => {
  process.stdout.write("stub-listening\n");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
