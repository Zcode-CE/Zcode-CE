import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 真浏览器 E2E 的「本机登录态」前提判定（task-11）。
 *
 * ## 为什么需要它
 * 本目录的 E2E 都用隔离的 `ZCODE_DATA_BASE_DIR` 起真实服务端，但界面能否挂载取决于用户自己的
 * 账号资料：Root 启动时会跑一遍 provider 可用性登录入口守卫，判据是
 * `shouldOpenLoginEntry = !providerFamilyDomain || (!user && !hasUsableProvider)`
 * （`packages/ui/src/root/useProviderAvailabilityLoginEntryGuard.ts`，由 `Root.tsx` 传入）。
 * 本机没登录过时两条判据都成立 ⇒ 页面停在「欢迎来到 ZCode 连接账号」登录页，侧栏里永远没有
 * `workspace-item-*` 行 ⇒ 用例只能以「等待挂载超时」收场，而超时看起来像产品缺陷。
 * 所以这里把「缺挂载前提」显式判成 skip：跳过不等于通过，且在跳过的同时写清缺什么、怎么补。
 *
 * ## 判据只认文件事实，不猜界面
 * 不 try/catch 探界面、不重试到「看不出来就算了」，只看 `~/.zcode/v2` 下的既有事实：
 * 1. `credentials.json` 存在且非空 —— 账号凭据（登录态的直接文件事实）；
 * 2. `setting.json` 的 `providerFamilyDomain` 是非空字符串 —— 上式的第一项判据；登录/Provider
 *    配置流程会写入它（`packages/ui/src/lib/providerFamilyDomainMigration.ts` 与
 *    `packages/services/src/model-provider/providerProvisioningTarget.ts`）。
 * 两项同时成立，客户端才不会停在登录页。
 *
 * 已知边界：只用 API Key、从未登录账号的机器上 `credentials.json` 不存在，会被这条判据跳过
 * （宁可少跑一次，也不让真实缺陷淹没在假红里）；需要覆盖那种环境时，把判据放宽到「任一
 * Provider 配置可用」是独立的一次改动。
 */

/** 用户账号资料目录（测试只读它；测试真正写入的是自己 mkdtemp 出来的隔离目录）。 */
export function resolveUserProfileDir(): string {
  return join(homedir(), ".zcode", "v2");
}

export interface WebE2eLoginStateReport {
  readonly profileDir: string;
  /** 逐条列出缺少的挂载前提（人类可读，含绝对路径与缺什么）。 */
  readonly missing: readonly string[];
  /** 非 null ⇒ 调用方必须 `t.skip(skipReason)`，然后 return。 */
  readonly skipReason: string | null;
}

interface ProviderFamilyDomainRead {
  readonly domain: string | null;
  /** 读不出来时的原因（不存在 / 无法解析）；能读时为 null。 */
  readonly problem: string | null;
}

/**
 * 读 `setting.json` 的 `providerFamilyDomain`。
 *
 * 解析失败不静默：返回 problem 让调用方把它写进 skip 文案 —— 一条读不出来的 setting.json 本身
 * 就是「无法判定登录态」，此时如果照旧跑用例，只会得到与真正缺陷无法区分的超时。
 */
function readProviderFamilyDomain(settingPath: string): ProviderFamilyDomainRead {
  if (!existsSync(settingPath)) {
    return { domain: null, problem: settingPath + " 不存在" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingPath, "utf8"));
  } catch (error) {
    return {
      domain: null,
      problem:
        settingPath +
        " 无法解析（" +
        (error instanceof Error ? error.message : String(error)) +
        "）",
    };
  }
  const raw =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["providerFamilyDomain"]
      : undefined;
  const domain = typeof raw === "string" ? raw.trim() : "";
  return { domain: domain.length > 0 ? domain : null, problem: null };
}

/**
 * 判定本机是否具备挂载 web 界面的登录态前提。
 *
 * @param profileDir 账号资料目录；默认 `~/.zcode/v2`。允许注入是为了能在临时目录里自测这条判据
 *                   （见 `webE2eLoginState.test.ts`）—— 不然守卫本身坏了也没人发现。
 */
export function inspectWebE2eLoginState(
  profileDir: string = resolveUserProfileDir(),
): WebE2eLoginStateReport {
  const missing: string[] = [];

  const credentialsPath = join(profileDir, "credentials.json");
  if (!existsSync(credentialsPath)) {
    missing.push(credentialsPath + " 不存在（本机未登录 ZCode）");
  } else if (statSync(credentialsPath).size === 0) {
    missing.push(credentialsPath + " 是空文件（登录凭据损坏）");
  }

  const settingPath = join(profileDir, "setting.json");
  const providerFamilyDomain = readProviderFamilyDomain(settingPath);
  if (providerFamilyDomain.problem) {
    missing.push(providerFamilyDomain.problem);
  } else if (providerFamilyDomain.domain === null) {
    missing.push(settingPath + " 缺少 providerFamilyDomain（客户端启动会停在登录页）");
  }

  if (missing.length === 0) {
    return { profileDir, missing, skipReason: null };
  }
  return {
    profileDir,
    missing,
    skipReason:
      "本机没有 web 界面的挂载前提，跳过（显式跳过，不等于通过）：" +
      missing.join("；") +
      "。补齐：用 ZCode 桌面端或 CLI 登录一次账号（会写入 credentials.json 与 setting.json 的 providerFamilyDomain），再重跑本用例。",
  };
}
