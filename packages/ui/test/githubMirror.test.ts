import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGithubMirrorPrefix,
  GITHUB_MIRROR_PREFIX_ERROR_CODES,
  isMirrorableGithubUrl,
  normalizeGithubMirrorPrefix,
  resolveGithubMirrorPrefix,
  ZCODE_GITHUB_MIRROR_ENV_KEY,
} from "../../shared/src/githubMirror.js";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
} from "../../shared/src/validationAppSettings.js";

/**
 * 国内加速前缀的回归测试。
 *
 * 覆盖四类不能回归的性质：
 * 1. **默认关闭**：空值/未配置必须原样直连，默认行为不因本功能改变；
 * 2. **作用范围**：只改写 GitHub 自有域名，非 GitHub 域名一律不动；
 * 3. **拒绝非法值**：http 明文、带凭据、带查询串都必须拦下；
 * 4. **保存期与运行期策略不同**：保存期拒绝，运行期退化为直连而不是抛错。
 *
 * 为什么放在 ui 包而不是 shared 包：本仓库的测试入口 scripts/run-tests.mjs 只扫描
 * packages/services 与 packages/ui 两个包目录，而 shared 包没有测试目录。
 * 放在这里才能被 pnpm test 真正执行（"写了但跑不到"的回归测试等于没有）。
 * 跨包直接引 shared 源码是既有约定，见同目录的 nonCliAcpRetirement.test.ts。
 *
 * 运行方式（CE 无统一 test script，沿用既有 *.test.ts 的 node:test 约定）：
 *   cd packages/ui && node --import tsx --test test/githubMirror.test.ts
 */

const ZIPBALL_URL = "https://api.github.com/repos/owner/repo/zipball/v1.0.0";
const CLONE_URL = "https://github.com/owner/repo.git";
const PREFIX = "https://ghfast.top/";

test("empty or missing prefix keeps every request on the original GitHub URL", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.equal(applyGithubMirrorPrefix(ZIPBALL_URL, value), ZIPBALL_URL, String(value));
    assert.equal(applyGithubMirrorPrefix(CLONE_URL, value), CLONE_URL, String(value));
    assert.equal(normalizeGithubMirrorPrefix(value), undefined);
  }
});

test("a valid prefix is normalized to a single trailing slash", () => {
  assert.equal(resolveGithubMirrorPrefix(PREFIX).prefix, PREFIX);
  assert.equal(resolveGithubMirrorPrefix("https://ghfast.top").prefix, PREFIX);
  assert.equal(resolveGithubMirrorPrefix("  https://ghfast.top/  ").prefix, PREFIX);
  // 带路径的前缀（部分镜像站会挂在子路径下）同样保留。
  assert.equal(
    resolveGithubMirrorPrefix("https://mirror.example.com/github").prefix,
    "https://mirror.example.com/github/",
  );
});

test("a valid prefix rewrites GitHub hosts and leaves everything else untouched", () => {
  assert.equal(applyGithubMirrorPrefix(CLONE_URL, PREFIX), `${PREFIX}${CLONE_URL}`);
  assert.equal(applyGithubMirrorPrefix(ZIPBALL_URL, PREFIX), `${PREFIX}${ZIPBALL_URL}`);
  assert.equal(
    applyGithubMirrorPrefix("https://www.github.com/owner/repo", PREFIX),
    `${PREFIX}https://www.github.com/owner/repo`,
  );
});

test("non-GitHub hosts are never redirected to the mirror", () => {
  const others = [
    "https://gitlab.com/owner/repo.git",
    "https://z-cdn.chatglm.cn/office-skill/fonts/font_list.txt",
    "https://api.z.ai/api/v1/releases/electron/manifest",
    "https://github.com.evil.example/owner/repo.git",
    "https://raw.githubusercontent.com/owner/repo/main/font.ttf",
  ];
  for (const url of others) {
    assert.equal(applyGithubMirrorPrefix(url, PREFIX), url, url);
    assert.equal(isMirrorableGithubUrl(url), false, url);
  }
});

test("applying the prefix twice does not double-prefix", () => {
  // 前缀自身不是 GitHub 域名，因此第二次套用会被 isMirrorableGithubUrl 挡住。
  // 这条性质是"多个调用点各自调用一次"仍然安全的前提。
  const once = applyGithubMirrorPrefix(CLONE_URL, PREFIX);
  assert.equal(applyGithubMirrorPrefix(once, PREFIX), once);
});

test("http prefixes are rejected so plugin downloads never go plaintext", () => {
  assert.equal(
    resolveGithubMirrorPrefix("http://ghfast.top/").errorCode,
    GITHUB_MIRROR_PREFIX_ERROR_CODES.insecureProtocol,
  );
  // 运行期非法值退化为直连，而不是抛错打断插件安装。
  assert.equal(applyGithubMirrorPrefix(CLONE_URL, "http://ghfast.top/"), CLONE_URL);
});

test("prefixes carrying credentials, query strings or fragments are rejected", () => {
  assert.equal(
    resolveGithubMirrorPrefix("https://user:pass@ghfast.top/").errorCode,
    GITHUB_MIRROR_PREFIX_ERROR_CODES.credentials,
  );
  assert.equal(
    resolveGithubMirrorPrefix("https://ghfast.top/?token=abc").errorCode,
    GITHUB_MIRROR_PREFIX_ERROR_CODES.queryOrFragment,
  );
  assert.equal(
    resolveGithubMirrorPrefix("https://ghfast.top/#frag").errorCode,
    GITHUB_MIRROR_PREFIX_ERROR_CODES.queryOrFragment,
  );
});

test("non-URL input is reported as invalid rather than silently accepted", () => {
  for (const value of ["ghfast.top", "not a url", "://missing-scheme"]) {
    assert.equal(
      resolveGithubMirrorPrefix(value).errorCode,
      GITHUB_MIRROR_PREFIX_ERROR_CODES.invalidUrl,
      value,
    );
    assert.equal(applyGithubMirrorPrefix(CLONE_URL, value), CLONE_URL, value);
  }
});

test("AppSettings accepts an empty prefix and rejects values that bypass the UI", () => {
  // 空串 = 关闭，是合法状态（默认行为）。
  for (const schema of [appSettingsSchema, appSettingsPatchSchema]) {
    assert.equal(schema.parse({ githubMirrorPrefix: "" }).githubMirrorPrefix, "");
    assert.equal(schema.parse({}).githubMirrorPrefix, undefined);
    assert.equal(schema.parse({ githubMirrorPrefix: PREFIX }).githubMirrorPrefix, PREFIX);
  }

  // schema 是最后一道闸：手工编辑 setting.json 写入 http 前缀同样要被拒绝，
  // 否则插件 zipball 会落到明文链路。
  for (const schema of [appSettingsSchema, appSettingsPatchSchema]) {
    for (const invalid of ["http://ghfast.top/", "ghfast.top", "https://user:pass@ghfast.top/"]) {
      assert.equal(
        schema.safeParse({ githubMirrorPrefix: invalid }).success,
        false,
        `${invalid} should be rejected`,
      );
    }
  }
});

test("the mirror env key is the documented ZCODE_ name", () => {
  // 宿主与 agent 子进程靠这个字符串对齐；改名会让插件安装静默退回直连。
  assert.equal(ZCODE_GITHUB_MIRROR_ENV_KEY, "ZCODE_GITHUB_MIRROR");
});
