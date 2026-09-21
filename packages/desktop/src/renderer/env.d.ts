/// <reference types="@zcode/client/globals" />

// renderer 侧环境声明（写法对齐 packages/web/src/env.d.ts）：
// 1. window.zcode 是 preload 通过 contextBridge 暴露的桌面平台 API，类型声明在
//    @zcode/client/globals（packages/client/src/globals.d.ts）。renderer 工程原来只
//    include "src/renderer"，该声明文件从未进入编译单元，于是 window.zcode 全部退化成
//    TS2339；这里显式把声明拉进 renderer program，不改任何运行时代码。
// 2. @zcode/ui 导出的样式表是纯 CSS 资源，TypeScript 没有对应声明，补最小声明避免 TS2882。
declare module "*.css";
declare module "@zcode/ui/styles.css";
