#!/usr/bin/env node
// 校验 docs/README.md 是 docs/ 的唯一索引：所有文档都被索引、所有索引链接都可解析。
//
// 为什么需要：docs/ 下新增文档但忘了加索引时，读者/代理找不到它；反过来，文档改名/删除后
// README 里的旧链接只在点开时才 404。两者都是静默漂移，靠人工回扫不可靠。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const docsRoot = resolve(import.meta.dirname, "..", "docs");
const readmePath = join(docsRoot, "README.md");
const readme = readFileSync(readmePath, "utf8");

const errors = [];

// 1) 所有相对 .md 链接（去掉 #anchor / ?query）必须解析到真实文件。
const linkPattern = /\]\(([^)]+\.md)(?:#[^)]*)?\)/g;
const linked = new Set();
for (const match of readme.matchAll(linkPattern)) {
  const raw = match[1];
  if (/^[a-z]+:/iu.test(raw)) continue; // 外链不检查
  const target = resolve(docsRoot, raw);
  linked.add(relative(docsRoot, target).replaceAll("\\", "/"));
  if (!existsSync(target)) errors.push(`README 链接指向不存在的文件：${raw}`);
}

// 2) docs/ 下每篇文档（README 除外）都必须出现在索引里。
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".md") && full !== readmePath) {
      files.push(relative(docsRoot, full).replaceAll("\\", "/"));
    }
  }
}
walk(docsRoot);
for (const file of files) {
  if (!linked.has(file)) errors.push(`文档未出现在 docs/README.md 索引：${file}`);
}

if (errors.length > 0) {
  console.error("docs 索引检查失败：");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`✓ docs 索引：${files.length} 篇文档全部在册，${linked.size} 条链接可解析`);
