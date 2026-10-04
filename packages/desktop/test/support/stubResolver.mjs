/**
 * ESM resolve 钩子：把 "electron" / "electron-updater" 重定向到测试桩，其余原样转交
 * 链中的下一解析器（tsx），保留 TS 解析与 @zcode/* 工作区解析。
 *
 * 注意本文件必须是纯 JS（.mjs 由 Node 原生编译，不能含任何 TS 类型语法）。
 * 测试文件自身的静态导入不需要桩（node:test / assert 等真实模块即可）；只有被测的
 * autoUpdater.ts 链路需要，故 register 在其 import 之前完成即可命中（ESM 先 link 后 evaluate）。
 */
import { pathToFileURL } from "node:url";

const STUBS = {
  electron: new URL("./electronStub.mjs", import.meta.url).href,
  "electron-updater": new URL("./electronUpdaterStub.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const stubUrl = STUBS[specifier];
  if (stubUrl) {
    return { url: stubUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
