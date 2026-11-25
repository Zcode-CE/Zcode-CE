import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  isProtectedStoragePath,
} from "../src/storage/domain/storageCatalog.js";

/**
 * 凭据 v2 的两个新文件必须显式列入清理白名单。
 *
 * `credential-secret` 是密钥本身：被清理流程删掉等于该目录的密文永久解不开（且用户在
 * 清理 UI 上看到的是「可清理的缓存」）。`credential-source` 决定该目录允许用哪种密钥，
 * 误删会让来源判定从「已绑定 os」退回「未绑定」，下次访问就可能另造一把密钥。
 * 现在它们按前缀规则落到「其他/不可清理」，安全但依赖间接分类；这里把行为钉成显式契约，
 * 避免今后分类调整把它们变成可清理项。
 */

test("credential-secret / credential-source 被判定为受保护路径", () => {
  for (const relativePath of ["v2/credential-secret", "v2/credential-source"]) {
    assert.equal(isProtectedStoragePath(relativePath), true, `${relativePath} 必须受保护`);
    // 绝对形式与 Windows 分隔符走同一条归一化路径。
    assert.equal(isProtectedStoragePath(`/${relativePath}`), true);
    assert.equal(isProtectedStoragePath(relativePath.replaceAll("/", "\\")), true);
  }
});

test("受保护清单只按精确 basename 命中，不误伤可清理产物", () => {
  assert.equal(isProtectedStoragePath("v2/logs/host-2026-11-25.log"), false);
  assert.equal(isProtectedStoragePath("v2/credential-secret.bak"), false);
  assert.equal(isProtectedStoragePath("v2/credential-source.tmp"), false);
  // 已有的凭据文件与设置仍然是受保护的（防回归）。
  assert.equal(isProtectedStoragePath("v2/credentials.json"), true);
  assert.equal(isProtectedStoragePath("v2/setting.json"), true);
});

test("两个新文件所在类别不可清理（清理计划不得包含它们）", () => {
  for (const relativePath of ["v2/credential-secret", "v2/credential-source"]) {
    const classification = classifyStoragePath(relativePath, {
      rootId: "dataBaseDir",
      hasCustomDataBaseDir: true,
    });
    assert.equal(
      getStorageCategoryCleanability(classification.categoryId),
      "none",
      `${relativePath} 落在可清理类别 ${classification.categoryId}`,
    );
  }
});
