import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { FileApplicationInfo } from "@zcode/shared";
import { createFileApplicationService } from "../src/main/file-open-apps/index.js";
import type {
  FileApplicationNativeAdapter,
  NativeFileApplication,
} from "../src/main/file-open-apps/contract.js";

/**
 * 「打开方式」服务：只测不依赖真实系统的部分（注入假适配器）。
 *
 * 钉住三条最容易被改坏的规则：
 * 1. 入口不信任 renderer —— 远端目标、目录、非绝对路径、不存在的文件一律返回空；
 * 2. 应用 id 是身份的摘要，同一个 bundle 的多个安装副本合并成一条（列表里出现两个
 *    "Chromium" 时用户无法选择，且 id 与打开时的重查结果必须对得上）；
 * 3. 打开时按 id 重查，绝不把 renderer 传来的字符串当命令执行。
 *
 * 真实枚举走系统 API（macOS LaunchServices / Windows 关联 / Linux .desktop），
 * 那部分只能在与目标平台一致时人工验证，见交付说明。
 */

// 服务要求目标必须是真实存在的本机文件（不信任 renderer 的声明），所以夹具用真实临时文件。
const workspaceDir = mkdtempSync(join(tmpdir(), "zcode-file-apps-"));
const targetPath = join(workspaceDir, "note.txt");
writeFileSync(targetPath, "hello");
after(() => rmSync(workspaceDir, { recursive: true, force: true }));

const TARGET = { path: targetPath, pathKind: "file" as const };

function fakeAdapter(applications: NativeFileApplication[]) {
  const opened: Array<{ key: string; path: string }> = [];
  const adapter: FileApplicationNativeAdapter = {
    async query() {
      return applications;
    },
    async open(application, path) {
      opened.push({ key: application.key, path });
    },
  };
  return { adapter, opened };
}

test("目标校验：远端 / 目录 / 不存在的路径一律返回空", async () => {
  const { adapter } = fakeAdapter([
    { key: "/Applications/Bundle.app", name: "Bundle", isDefault: true },
  ]);
  const service = createFileApplicationService({ adapter });
  assert.deepEqual(
    await service.getFileApplications({ ...TARGET, workspaceIdentity: "ssh://host" }),
    [],
  );
  assert.deepEqual(await service.getFileApplications({ path: "/tmp", pathKind: "directory" }), []);
  assert.deepEqual(
    await service.getFileApplications({ path: "relative/note.txt", pathKind: "file" }),
    [],
  );
  assert.deepEqual(
    await service.getFileApplications({ path: "/tmp/definitely-missing.txt", pathKind: "file" }),
    [],
  );
  // 打开同样要过同一道校验：否则 renderer 可以借 open 绕过。
  const result = await service.openFileWithApplication("file-app:any", {
    ...TARGET,
    workspaceIdentity: "ssh://host",
  });
  assert.equal(result.success, false);
  assert.equal(result.error, "unsupported_file_target");
});

test("id 是身份摘要：稳定、非法应用不出现在列表里", async () => {
  const { adapter } = fakeAdapter([
    { key: "/Applications/A.app", name: "Alpha", isDefault: true, identity: "darwin-bundle:com.a" },
    { key: "", name: "Broken", isDefault: false },
    { key: "/Applications/B.app", name: "  ", isDefault: false },
  ]);
  const service = createFileApplicationService({ adapter });
  const apps = await service.getFileApplications(TARGET);
  assert.equal(apps.length, 1);
  const [app] = apps as [FileApplicationInfo];
  assert.equal(app.name, "Alpha");
  assert.equal(app.isDefault, true);
  // id 不含真实路径（身份不跨 IPC），且同一身份两次枚举得到同一个 id。
  assert.match(app.id, /^file-app:[0-9a-f]{64}$/u);
  assert.deepEqual(
    (await service.getFileApplications(TARGET)).map((item) => item.id),
    [app.id],
  );
});

test("同一身份的多个安装副本合并成一条，且优先默认 / 系统目录", async () => {
  const { adapter } = fakeAdapter([
    {
      key: "/home/user/Applications/Chromium.app",
      name: "Chromium",
      isDefault: false,
      identity: "darwin-bundle:org.chromium",
      version: "120",
    },
    {
      key: "/Applications/Chromium.app",
      name: "Chromium",
      isDefault: true,
      identity: "darwin-bundle:org.chromium",
      version: "119",
    },
  ]);
  const service = createFileApplicationService({ adapter });
  const apps = await service.getFileApplications(TARGET);
  assert.equal(apps.length, 1, "同一 bundle 只出现一条");
  assert.equal(apps[0]?.isDefault, true, "保留默认安装的副本");
});

test("打开时按 id 重查：未知 id 不执行任何命令", async () => {
  const { adapter, opened } = fakeAdapter([
    { key: "/Applications/A.app", name: "Alpha", isDefault: true, identity: "darwin-bundle:com.a" },
  ]);
  const service = createFileApplicationService({ adapter });
  const [app] = await service.getFileApplications(TARGET);
  assert.ok(app);

  const unknown = await service.openFileWithApplication("file-app:deadbeef", TARGET);
  assert.equal(unknown.success, false);
  assert.equal(unknown.error, "application_not_available");
  assert.deepEqual(opened, [], "未知 id 不得触发打开");

  const ok = await service.openFileWithApplication(app.id, TARGET);
  assert.equal(ok.success, true);
  assert.deepEqual(opened, [{ key: "/Applications/A.app", path: TARGET.path }]);
});

test("枚举失败按空列表处理（能力检测不是错误路径）", async () => {
  const failing: FileApplicationNativeAdapter = {
    async query() {
      throw new Error("spawn ENOENT");
    },
    async open() {
      throw new Error("spawn ENOENT");
    },
  };
  const service = createFileApplicationService({ adapter: failing, logger: { warn: () => {} } });
  assert.deepEqual(await service.getFileApplications(TARGET), []);
});
