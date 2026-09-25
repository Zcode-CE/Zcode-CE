// 测试用「慢回收持有者」：spawn 一个子进程，把它的 pid 写进 PID_FILE，然后同步阻塞，
// 期间完全不处理 SIGCHLD（事件循环不转）⇒ 子进程被 SIGKILL 后一直以僵尸留在进程表。
//
// 为什么需要它：SIGKILL 后内核分两步收尾 —— 先 exit_files 关掉监听 socket（端口立即释放），
// 进程随后才是僵尸，僵尸要等父进程回收才从进程表消失。两步之间的窗口在本地只有约 0.1ms
// （测试进程的事件循环恰好转过一次就回收了），所以本地撞不到；CI runner 上调度被推迟，
// 窗口跨过了那次轮转 ⇒ 探活跳过 pid-dead 去探端口 ⇒ 拿到 port-closed（CI run 36151161461）。
// 本持有者把该窗口从 0.1ms 拉到秒级，使这个竞态能被确定性地测到。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const entry = process.argv[2];
const pidFile = process.env.HOLDER_PID_FILE;
const child = spawn(process.execPath, [entry], { env: process.env, stdio: "ignore" });
writeFileSync(pidFile, String(child.pid));

// 同步阻塞：SIGCHLD 会到达内核并写入 libuv 的管道，但没有事件循环去读 ⇒ 不 waitpid ⇒ 僵尸不回收。
const view = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + (Number(process.env.HOLDER_BLOCK_MS) || 30_000);
while (Date.now() < deadline) {
  Atomics.wait(view, 0, 0, 10);
}
process.exit(0);
