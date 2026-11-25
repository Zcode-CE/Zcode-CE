// Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入 `schema_too_new` 守卫。
//
// 与官方 `packages/shared/src/sqlite-migrations` 同名的窄模块：CE 只搬「版本守卫」，
// 不搬官方的表级备份 / restore / runner（CE 走自建文件备份 + 自己的 runner）。
export * from "./schema-too-new.js";
