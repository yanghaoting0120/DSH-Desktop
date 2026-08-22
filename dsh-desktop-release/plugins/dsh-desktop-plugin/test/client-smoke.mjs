// client.js 冒烟测试：模拟 __ModuleLoader__ + 最小 react，验证 factory 可执行、
// apply 可调用且注册的插槽/组件定义正确（不触发真实 DOM 渲染）。
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

let loaded = null;
globalThis.window = {
  addEventListener: () => {},
  __ModuleLoader__: {
    load(entry) {
      loaded = entry;
      const require = (name) => {
        if (name === "react") {
          // 最小 React 桩：createElement 返回描述对象；hooks 返回 [value, setter]
          return {
            createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
            useState: (init) => [typeof init === "function" ? init() : init, () => {}],
            useEffect: () => {},
            useRef: (init) => ({ current: init }),
            useCallback: (fn) => fn,
          };
        }
        throw new Error("unexpected require: " + name);
      };
      return entry.factory(require);
    },
  },
};
globalThis.document = {
  body: { hasAttribute: () => false, style: {} },
  documentElement: { appendChild: () => {} },
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }),
  getElementById: () => null,
};
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};
globalThis.fetch = async () => ({ json: async () => ({ ok: false }) });
globalThis.EventSource = class { addEventListener() {} close() {} };

// 执行 bundle（脚本形式，靠全局 window.__ModuleLoader__ 自注册）。
new Function(src)();

if (!loaded) throw new Error("client bundle 未调用 __ModuleLoader__.load");
console.log("client bundle 已加载，id =", loaded.id);

const requireFn = (name) => {
  if (name === "react") {
    return {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (init) => [typeof init === "function" ? init() : init, () => {}],
      useEffect: (fn) => { const cleanup = fn(); if (typeof cleanup === "function") cleanup(); },
      useRef: (init) => ({ current: init }),
      useCallback: (fn) => fn,
    };
  }
  throw new Error("unexpected require: " + name);
};
const exportsObj = loaded.factory(requireFn);
console.log("exports =", JSON.stringify(Object.keys(exportsObj)));
console.log("description =", exportsObj.description);

// 调用 apply，验证插槽注册
const registrations = [];
const ctx = {
  slots: {
    inject(name, factory) {
      registrations.push({ name, factory });
    },
    register(opts, component) {
      return { ...opts, component };
    },
  },
  theme: { setTheme: () => {} },
  on: () => () => {},
};
exportsObj.apply(ctx);

console.log("注册的插槽:");
for (const r of registrations) {
  const entry = r.factory();
  console.log("  -", r.name, "| id =", entry.id, "| order =", entry.order, "| component =", entry.component ? entry.component.name : "(fn)");
}
const headerSlots = registrations.filter((r) => r.name === "conversation.session.header.actions");
if (headerSlots.length !== 2) throw new Error("标题栏 action 插槽应注册 2 个条目（导出 + 字号），实际 " + headerSlots.length);
const orders = headerSlots.map((r) => r.factory().order);
console.log("标题栏条目 order =", orders.join(", "), orders[0] < orders[1] ? "（导出在前，字号在右侧 ✔）" : "（顺序异常！）");

// 渲染 FontScaleControl 验证不抛错（桩 react：先解包 Slot 的 createElement 描述，再真正调用组件函数）
const fsSlot = headerSlots.find((r) => r.factory().id === "desktop-font-scale");
const fsEntry = fsSlot.factory();
const slotEl = fsEntry.component({ ctx: { theme: { setTheme: () => {} }, on: () => () => {} } });
if (!slotEl || typeof slotEl.type !== "function") throw new Error("FontScaleControlSlot 渲染结果异常: " + JSON.stringify(slotEl && slotEl.type));
const rendered = slotEl.type({ ctx: { theme: { setTheme: () => {} }, on: () => () => {} } });
if (!rendered || rendered.type !== "span") throw new Error("FontScaleControl 渲染结果异常: " + JSON.stringify(rendered && rendered.type));
console.log("FontScaleControl 渲染 OK，根元素 = span，子元素数 =", (rendered.children || []).length);

console.log("\n冒烟测试通过 ✔");
