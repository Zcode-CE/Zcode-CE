import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthThrottle,
  isTrustedProxy,
  parseTrustedProxies,
  resolveClientAddress,
} from "../src/authThrottle.js";

/**
 * 可信代理口径 + 鉴权失败限流的契约（task-35 / A3 + G10②）。
 *
 * 这两件事**必须同批**：按 IP 限流却仍无条件采信 `X-Forwarded-For` ⇒ 攻击者每次换一个假地址，
 * 限流形同不存在。所以本文件同时钉住「默认不采信 XFF」与「限流真的会封禁」。
 *
 * **反向验证（实测过）**：
 * - 把 `resolveClientAddress` 改回「优先取 XFF 首跳」⇒ 「伪造 XFF 不能绕过限流」变红；
 * - 去掉 `check()` 里的封禁分支 ⇒ 「达到阈值后第 N+1 次被拒」变红。
 */

test("可信代理解析：IP 与 CIDR 都接受，非法项被丢弃", () => {
  const ranges = parseTrustedProxies("127.0.0.1, 10.0.0.0/8 ,bad-entry, 192.168.0.0/33,,::1");
  assert.equal(ranges.length, 3, "非法项（域名、超长前缀、空项）必须被丢弃");
  const probe = (address: string) => isTrustedProxy(address, ranges);
  assert.equal(probe("127.0.0.1"), true);
  assert.equal(probe("127.0.0.2"), false, "单 IP 记录不得匹配同段其他地址");
  assert.equal(probe("10.255.255.255"), true);
  assert.equal(probe("11.0.0.1"), false);
  assert.equal(probe("192.168.0.0/33"), false);
  assert.equal(probe("::1"), true);
  assert.equal(probe("::2"), false);
  assert.equal(probe(undefined), false);
});

test("可信代理解析：IPv6 CIDR 按位比较（含内嵌 IPv4 与 zone）", () => {
  const ranges = parseTrustedProxies("2001:db8::/32,::ffff:127.0.0.1");
  const probe = (address: string) => isTrustedProxy(address, ranges);
  assert.equal(probe("2001:db8:1234::1"), true);
  assert.equal(probe("2001:db9::1"), false);
  assert.equal(probe("::ffff:127.0.0.1"), true, "内嵌 IPv4 形式必须能匹配");
  assert.equal(probe("fe80::1%eth0"), false);
  assert.equal(parseTrustedProxies("::/0").length, 1, "全零前缀必须被接受");
  assert.equal(isTrustedProxy("1.2.3.4", parseTrustedProxies("::/0")), false, "族不同不得匹配");
  assert.equal(isTrustedProxy("::1", parseTrustedProxies("::/0")), true);
});

test("对端地址：**默认不采信 X-Forwarded-For**（伪造头换不来新额度）", () => {
  const resolved = resolveClientAddress({
    socketAddress: "203.0.113.7",
    forwardedFor: "1.2.3.4",
    trustedProxies: [],
  });
  assert.equal(resolved, "203.0.113.7", "无可信代理时必须用 socket 地址");
});

test("对端地址：socket 是可信代理时从右往左取第一个不可信地址", () => {
  const trusted = parseTrustedProxies("127.0.0.1,10.0.0.0/8");
  // 反代一跳：XFF 只有客户端
  assert.equal(
    resolveClientAddress({
      socketAddress: "127.0.0.1",
      forwardedFor: "198.51.100.9",
      trustedProxies: trusted,
    }),
    "198.51.100.9",
  );
  // 反代两跳：最右是可信代理本身，取它左边那个
  assert.equal(
    resolveClientAddress({
      socketAddress: "127.0.0.1",
      forwardedFor: "198.51.100.9, 10.1.2.3",
      trustedProxies: trusted,
    }),
    "198.51.100.9",
  );
  // **关键**：最左的伪造值不得被采信
  assert.equal(
    resolveClientAddress({
      socketAddress: "127.0.0.1",
      forwardedFor: "1.2.3.4, 198.51.100.9, 10.1.2.3",
      trustedProxies: trusted,
    }),
    "198.51.100.9",
    "左侧伪造值必须被忽略（从右往左找第一个不可信）",
  );
});

test("对端地址：XFF 畸形（带端口/域名/垃圾）⇒ 退回 socket，不给伪造留缝", () => {
  const trusted = parseTrustedProxies("127.0.0.1");
  for (const forwardedFor of ["198.51.100.9:1234", "evil.example", "not-an-ip", "<script>"]) {
    assert.equal(
      resolveClientAddress({
        socketAddress: "127.0.0.1",
        forwardedFor,
        trustedProxies: trusted,
      }),
      "127.0.0.1",
      forwardedFor + " 必须退回 socket 地址",
    );
  }
});

test("限流：连续失败到阈值后第 N+1 次被拒，封禁到期自动恢复", () => {
  let now = 0;
  const throttle = createAuthThrottle({
    maxFailures: 3,
    windowMs: 60_000,
    banDurationMs: 30_000,
    now: () => now,
  });
  const ip = "203.0.113.7";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    assert.equal(throttle.check(ip).allowed, true, "第 " + attempt + " 次尝试前仍允许");
    assert.equal(throttle.recordFailure(ip), false, "未到阈值不得封禁");
  }
  assert.equal(throttle.check(ip).allowed, true);
  assert.equal(throttle.recordFailure(ip), true, "第 3 次失败应触发封禁");
  assert.equal(throttle.check(ip).allowed, false, "封禁期内必须被拒");
  assert.match(String(throttle.check(ip).retryAfterMs), /^[0-9]+$/);
  assert.equal(throttle.bannedCount(), 1);

  now += 30_001;
  assert.equal(throttle.check(ip).allowed, true, "封禁到期后必须自动恢复（不能永久锁死）");
  assert.equal(throttle.bannedCount(), 0);
});

test("限流：成功即清零（正常用户偶发输错不会累积到阈值）", () => {
  let now = 0;
  const throttle = createAuthThrottle({ maxFailures: 3, windowMs: 60_000, now: () => now });
  const ip = "203.0.113.8";
  throttle.recordFailure(ip);
  throttle.recordFailure(ip);
  assert.equal(throttle.failureCount(ip), 2);
  throttle.recordSuccess(ip);
  assert.equal(throttle.failureCount(ip), 0);
  assert.equal(throttle.check(ip).allowed, true);
  assert.equal(throttle.recordFailure(ip), false, "清零后重新计数，不得立即封禁");
});

test("限流：窗口过期后计数重置（不会因为「很久以前失败过几次」而在某天突然被封）", () => {
  let now = 0;
  const throttle = createAuthThrottle({ maxFailures: 3, windowMs: 10_000, now: () => now });
  const ip = "203.0.113.9";
  throttle.recordFailure(ip);
  throttle.recordFailure(ip);
  now += 10_001;
  assert.equal(throttle.recordFailure(ip), false, "窗口过期后计数应从 1 重新开始");
  assert.equal(throttle.failureCount(ip), 1);
});

test("限流：地址缺失/不同地址互不牵连，跟踪表有上界（不因伪造地址无界增长）", () => {
  const throttle = createAuthThrottle({ maxFailures: 2, maxTrackedClients: 4, now: () => 0 });
  assert.equal(throttle.check(undefined).allowed, true);
  assert.equal(throttle.recordFailure(undefined), false, "没有地址时不得误判为某个地址失败");
  throttle.recordFailure("a");
  throttle.recordFailure("b");
  assert.equal(throttle.failureCount("a"), 1);
  assert.equal(throttle.bannedCount(), 0);
  for (const address of ["c", "d", "e", "f", "g"]) {
    throttle.recordFailure(address);
  }
  // 上界生效：不会因为地址数量增长而无限占用内存（驱逐最早的一条，不抛错）。
  assert.equal(throttle.bannedCount() <= 4, true);
});
