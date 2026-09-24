import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * Web 模式的监听地址与端口编排（从 runner.mjs 按职责拆出，见 task-49）。
 *
 * 这里放的是「与进程编排无关」的那一半：默认地址/端口的**选择与回退**、URL 拼装、
 * 以及「用系统默认浏览器打开」。runner.mjs 只负责进程生命周期（spawn 服务、信号、退出码）。
 *
 * 拆分时保持行为与用户可见文案逐字节不变（包括 `端口 3030 已被占用…` 那条提示）。
 */

/** 默认监听地址：回环。 */
export const DEFAULT_HOST = "127.0.0.1";
/** 默认端口：先试 3030，被占用时回退到空闲端口（长期运行需要可预期端口，共享机又要避免碰撞）。 */
export const DEFAULT_WEB_PORT = 3030;

export function isLocalHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function shouldProtectHost(host) {
  return !isLocalHost(host);
}

export function assertPortFree(host, port) {
  return new Promise((resolveFree, rejectBusy) => {
    const server = createServer();
    server.once("error", rejectBusy);
    server.listen(port, host, () => {
      server.close((error) => (error ? rejectBusy(error) : resolveFree()));
    });
  });
}

export function pickPort(host) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

export async function pickDefaultPort(host) {
  try {
    await assertPortFree(host, DEFAULT_WEB_PORT);
    return DEFAULT_WEB_PORT;
  } catch {
    const fallback = await pickPort(host);
    console.log(`端口 ${DEFAULT_WEB_PORT} 已被占用，改用 ${fallback}（可用 --port 指定固定端口）`);
    return fallback;
  }
}

export function formatUrl(host, port, token) {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const base = `http://${displayHost}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function networkUrls(port, token) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }
      const base = `http://${entry.address}:${port}/`;
      urls.push(token ? `${base}?token=${encodeURIComponent(token)}` : base);
    }
  }
  return urls;
}

export function openBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
