/**
 * dsh-desktop — 根目录入口转发。
 *
 * 通过 junction 链接安装到 profile 的 node_modules 时，Node 的
 * legacyMainResolve 会忽略 package.json 的 main 字段，直接查找包根目录的
 * index.js。这里转发到实际实现 lib/index.js。
 */
export { default } from "./lib/index.js";
