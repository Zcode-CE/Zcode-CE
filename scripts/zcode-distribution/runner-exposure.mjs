import { isIP } from "node:net";

/**
 * 分发入口侧的「会被外部访问」信号判定（task-82）。
 *
 * ## 为什么分发入口需要知道这件事
 *
 * 服务端（packages/server）在「登记了域名/可信代理 + 无令牌」时**回环也会拒绝启动**（本轮加固）。
 * 但 runner 的组合校验此前只看 --host 与 --no-token，看不到这两类信号 ⇒ 它会先打印
 * 「ZCode Web is running」+ Local 横幅，**之后**子进程才报拒绝。
 * 那正是 assertHostTokenCombination 既有注释点名要避免的形态：「用户会先看到 running 的假象、
 * 再拿到二段错误」。所以这里补的是**覆盖面**，不是新语义。
 *
 * ## 判据必须与服务端**同一口径**
 *
 * 三条硬约束（任何一条写错都会比缺陷本身更糟）：
 * 1. **读解析后的生效项**，不是「环境变量有没有被设置」：服务端对非法项是**静默丢弃**的
 *    （host:abc、not-an-ip），若这里把非法值当信号，就会**拒绝一个服务端本来能正常启动的配置**
 *    —— 那是比"先打印横幅"更严重的翻车（用户的正常配置起不来）。
 * 2. **优先级与服务端一致**：configEnv() 只在环境变量未设置（或为空）时才用配置文件的值透传，
 *    因此生效值 = 非空的环境变量 ?? 配置文件。
 * 3. **只认服务端会拒绝的那两类信号**：TRUSTED_HOSTS 与 TRUSTED_PROXIES。
 *    TRUSTED_ORIGINS 在服务端**只告警、不拒绝** ⇒ 这里也**不得**据此拒绝。
 *
 * ## 漂移风险与对策（**如实说明**）
 *
 * 本文件是 packages/server/src/hostAllowlist.ts 的 splitHostPort / parseTrustedHosts 与
 * authThrottle.ts 的 parseTrustedProxies 的**镜像实现** —— 分发包里的 bin/zcode.mjs 是逐字节
 * 拷贝的纯 ESM，**不能** import 服务端的 TS 模块。因此存在"两边解析口径漂移"的风险，对策是
 * **一条交叉校验测试**：packages/server/test/distributionRunnerTokenPolicy.test.ts 把同一批语料
 * 同时喂给本模块与服务端的真实解析器，断言两者对「是否有生效项」的结论**逐条一致**。
 * 服务端规则一旦改动而忘了改这里，那条测试会立刻变红。
 */

/** 主机名归一化：小写、去尾随点（与服务端 hostAllowlist.ts 同口径）。 */
function normalizeHostname(value) {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * 拆分 host[:port]（含 [::1]:3030）。返回 null 表示服务端会**丢弃**该条目。
 *
 * 逐条镜像 hostAllowlist.ts 的 splitHostPort：畸形（空、含路径/查询/空白/控制字符、
 * 端口非数字或越界）一律返回 null；不带方括号的多冒号形态只有整体是合法 IPv6 时才接受。
 */
/**
 * 是否含控制字符：**与服务端字符类 `[\u0000-\u001f\u007f]` 逐码位等价**。
 *
 * 为什么不用正则字面量：会触发 oxlint 的 no-control-regex（服务端那处带着该警告）。
 * 为什么不用 `\p{Cc}`：它是 Unicode 一般类别 Cc，**包含 C1 区 U+0080–U+009F**，
 * 而服务端只拒 U+0000–U+001F 与 U+007F ⇒ 实测 176 条语料里 32 条结论不一致（漂移）。
 */
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function splitHostPort(raw) {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // 控制字符用**逐码位比较**而不是正则字面量。两个理由，第二条是实测出来的：
  // ① 不触发 oxlint 的 no-control-regex（服务端 hostAllowlist.ts 的同款写法带着那条警告，
  //    新增文件不该抬高仓库的 warning 基线）；
  // ② **不能**用 \p{Cc} 代替：实测它把 C1 区（U+0080–U+009F）也判为控制字符，而服务端只拒
  //    U+0000–U+001F 与 U+007F ⇒ 两侧口径漂移（176 条语料里 32 条不一致），会让 runner 拒掉
  //    服务端本来接受的 Host。下面的比较与服务端的字符类**逐码位等价**，并由交叉校验测试钉住。
  if (/[\s/?#\\]/.test(trimmed) || hasControlCharacter(trimmed)) {
    return null;
  }
  let hostPart;
  let portPart;
  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing === -1) {
      return null;
    }
    hostPart = trimmed.slice(1, closing);
    const rest = trimmed.slice(closing + 1);
    if (rest) {
      if (!rest.startsWith(":")) {
        return null;
      }
      portPart = rest.slice(1);
    }
  } else {
    const separator = trimmed.lastIndexOf(":");
    if (separator !== -1 && trimmed.indexOf(":") !== separator) {
      // 多冒号：只有整体是合法 IPv6 才接受（与服务端同一判据）。
      if (isIP(trimmed) === 6) {
        return { host: normalizeHostname(trimmed) };
      }
      return null;
    }
    if (separator === -1) {
      hostPart = trimmed;
    } else {
      hostPart = trimmed.slice(0, separator);
      portPart = trimmed.slice(separator + 1);
    }
  }
  const host = normalizeHostname(hostPart);
  if (!host) {
    return null;
  }
  if (portPart === undefined) {
    return { host };
  }
  if (!/^\d{1,5}$/.test(portPart)) {
    return null;
  }
  const port = Number(portPart);
  if (port <= 0 || port > 65535) {
    return null;
  }
  return { host, port };
}

/** 解析 ZCODE_SERVER_TRUSTED_HOSTS：非法项丢弃（与服务端 parseTrustedHosts 同口径）。 */
export function parseTrustedHosts(raw) {
  if (!raw?.trim()) {
    return [];
  }
  const parsed = [];
  for (const entry of raw.split(",")) {
    const split = splitHostPort(entry);
    if (split) {
      parsed.push(split);
    }
  }
  return parsed;
}

/** 解析 ZCODE_SERVER_TRUSTED_PROXIES：接受 IP 与 CIDR，非法项丢弃（与服务端同口径）。 */
export function parseTrustedProxies(raw) {
  if (!raw?.trim()) {
    return [];
  }
  const ranges = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const slash = trimmed.lastIndexOf("/");
    const addressPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
    const prefixPart = slash === -1 ? undefined : trimmed.slice(slash + 1);
    const family = isIP(addressPart);
    if (family === 0) {
      continue;
    }
    const maxPrefix = family === 4 ? 32 : 128;
    if (prefixPart !== undefined) {
      if (!/^\d{1,3}$/.test(prefixPart) || Number(prefixPart) > maxPrefix) {
        continue;
      }
    }
    ranges.push(addressPart);
  }
  return ranges;
}

/**
 * 求**生效**的外部访问信号（与服务端 collectExposureSignals 的输入口径一致）。
 *
 * 优先级：非空环境变量 ?? 配置文件键（与服务端 configEnv() 的 setIfUnset 一致）。
 * 只返回服务端会**据此拒绝启动**的两类；TRUSTED_ORIGINS 刻意不在内（服务端对它只告警）。
 */
export function resolveExposureSignals({ env = process.env, file = {} } = {}) {
  const envHosts = env.ZCODE_SERVER_TRUSTED_HOSTS?.trim();
  const envProxies = env.ZCODE_SERVER_TRUSTED_PROXIES?.trim();
  const fileHosts = Array.isArray(file.trustedHosts) ? file.trustedHosts.join(",") : "";
  const fileProxies = Array.isArray(file.trustedProxies) ? file.trustedProxies.join(",") : "";
  const trustedHosts = parseTrustedHosts(envHosts || fileHosts);
  const trustedProxies = parseTrustedProxies(envProxies || fileProxies);
  return {
    trustedHosts: trustedHosts.map((entry) =>
      entry.port === undefined ? entry.host : entry.host + ":" + String(entry.port),
    ),
    trustedProxies,
  };
}

/** 信号是否为空（没有任何生效项 ⇒ 服务端不会据此拒绝 ⇒ runner 也不该拒绝）。 */
export function hasExposureSignal(signals) {
  return signals.trustedHosts.length > 0 || signals.trustedProxies.length > 0;
}

/**
 * 除 `--token` 之外，**还有哪些令牌来源**能让服务端放行（避免这里**误拒**合法配置）。
 *
 * 实测（真跑分发包夹具 + 真实服务端）：`host=127.0.0.1` + `TRUSTED_HOSTS=panel.example`
 * + `ZCODE_SERVER_AUTH_TOKENS_FILE` 指向一个**有内容的**令牌文件 ⇒ 服务端**正常启动**
 * （无令牌 401 / 带令牌 200）。
 *
 * 因此这里必须把「令牌文件里真的有可用令牌」也算作"已配令牌"，否则会把**用户本来能用的配置
 * 直接拒掉** —— 那比"先打印横幅"严重得多（后者只是难看，前者是功能不可用）。
 *
 * 判据与服务端 `parseAuthTokenFile` 对齐：跳过空行与 `#` 注释行，其余行按空白切出第一个字段；
 * **至少一条**才算可用（服务端对空文件/只有注释是**拒绝启动**的，那种情况下这里也不该放行）。
 */
export function hasUsableTokenFile({ env = process.env, file = {}, readFileSync } = {}) {
  const envPath = env.ZCODE_SERVER_AUTH_TOKENS_FILE?.trim();
  const filePath = typeof file.authTokensFile === "string" ? file.authTokensFile.trim() : "";
  const path = envPath || filePath;
  if (!path || typeof readFileSync !== "function") {
    return false;
  }
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    // 读不到 ⇒ 服务端会**抛错拒绝启动**（fail-closed，不是静默降级）。这里返回 false
    // 只会让 runner 多报一次"没令牌"，不会误放行 —— 保守方向是对的。
    return false;
  }
  for (const rawLine of String(content).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.search(/\s/);
    const token = separator === -1 ? trimmed : trimmed.slice(0, separator);
    if (token) {
      return true;
    }
  }
  return false;
}

/**
 * 「回环 + 有信号 + 无令牌」的拒绝文案（与服务端 buildLoopbackExposureRefusal 同一因果链，
 * 但按分发入口的口吻给**可照做**的两条修法）。
 */
export function buildLoopbackExposureRefusal({ host, signals }) {
  const lines = [];
  if (signals.trustedHosts.length > 0) {
    lines.push("  - ZCODE_SERVER_TRUSTED_HOSTS 登记了域名：" + signals.trustedHosts.join(", "));
  }
  if (signals.trustedProxies.length > 0) {
    lines.push(
      "  - ZCODE_SERVER_TRUSTED_PROXIES 登记了可信代理：" + signals.trustedProxies.join(", "),
    );
  }
  return [
    "Refusing to start: --no-token cannot be combined with a reverse-proxy / external-host setup.",
    '拒绝启动：绑定回环地址 "' + host + '" 且未提供 token，但配置里登记了反向代理或外部域名。',
    "",
    "触发的信号：",
    ...lines,
    "",
    "原因：登记了它们就说明「回环可达」不再等于「只有本机能到」——",
    "  把回环端口放到同机反向代理、隧道或容器端口映射之后时，请求的对端地址就是回环，",
    "  于是「回环不要求令牌」这条判断会让鉴权整条不生效（Host 白名单与来源校验都挡不住），",
    "  结果是**一个 curl 就等于无需令牌的完全控制权**（执行命令、读写工作区）。",
    "  服务端本身也会拒绝启动 —— 这里提前报错，避免先打印 running 再被二段错误打断。",
    "",
    "两种做法：",
    "  1. 配一个令牌：去掉 --no-token（回环下会自动生成），或用 --token <token> 指定一个，",
    "     或把令牌写进 ZCODE_SERVER_AUTH_TOKENS_FILE 指向的文件；",
    "  2. 或去掉上面那些登记项：如果你确实只在本机用（不经反代/隧道），",
    "     就不要配 ZCODE_SERVER_TRUSTED_PROXIES，也不要在 ZCODE_SERVER_TRUSTED_HOSTS 里登记域名。",
  ].join("\n");
}
