// 浏览器产物里 node:os 的替身：空对象 ⇒ 所有具名导入都是 undefined。
// 与实测产物一致（bundle 里该模块是 `t.exports={}`），所以 `homedir()` 的报错逐字相同。
export const homedir = undefined;
export const tmpdir = undefined;
export const platform = undefined;
export const cpus = undefined;
export const release = undefined;
export const arch = undefined;
export const EOL = undefined;
export default {};
