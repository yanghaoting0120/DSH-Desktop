// dsh-desktop 插件功能自检：mock 一个最小 ctx，逐个调用工具。
import { apply } from "../lib/index.js";

const defs = [];
const services = {};
const routes = new Map();
const ctx = {
  tools: { register: (d) => defs.push(d) },
  provide: (k, v) => { services[k] = v; },
  effect: (cb) => cb(),
  emit: () => {},
  systemPrompt: { section: () => () => {} },
  webServer: {
    register: ({ kind, path, handler }) => {
      routes.set(`${kind}:${path}`, handler);
      return () => routes.delete(`${kind}:${path}`);
    },
  },
};

apply(ctx, {});

console.log("注册的工具:", defs.map((d) => d.name).join(", "));
console.log("提供的服务:", Object.keys(services).join(", "));

const byName = Object.fromEntries(defs.map((d) => [d.name, d]));

// 1) desktop_status
const status = await byName.desktop_status.execute({}, { signal: new AbortController().signal });
console.log("\n[desktop_status]", JSON.stringify(status, null, 2));

// 2) desktop_open — 打开一个存在的文件（应成功）
try {
  const r = await byName.desktop_open.execute(
    { target: "C:\\Users\\Lenovo\\Desktop\\yht" },
    { signal: new AbortController().signal }
  );
  console.log("\n[desktop_open] ok =", r.ok, "| command =", r.command, "| target =", r.target);
} catch (e) {
  console.log("\n[desktop_open] FAILED:", e.message);
}

// 3) desktop_open — 不存在的路径（应报错）
try {
  await byName.desktop_open.execute(
    { target: "C:\\Users\\Lenovo\\Desktop\\yht\\__no_such_file_xyz__" },
    { signal: new AbortController().signal }
  );
  console.log("\n[desktop_open missing] 未报错（意外）");
} catch (e) {
  console.log("\n[desktop_open missing] 按预期报错:", e.message.slice(0, 80));
}

// 4) desktop_notify — 短通知
try {
  const r = await byName.desktop_notify.execute(
    { title: "DSH 桌面版", body: "插件自检通知：一切正常 🎉", durationMs: 1500 },
    { signal: new AbortController().signal }
  );
  console.log("\n[desktop_notify] ok =", r.ok, "| title =", r.title);
} catch (e) {
  console.log("\n[desktop_notify] FAILED:", e.message.slice(0, 120));
}

// 5) desktop_set_font_scale — 调小 / 调大 / 越界钳制 / 缺参报错
const statusBefore = await byName.desktop_status.execute({}, { signal: new AbortController().signal });
console.log("\n[desktop_status] fontScale(初始) =", statusBefore.fontScale);

for (const args of [{ scale: 0.9 }, { level: "large" }, { scale: 2.5 }, { scale: 0.5 }]) {
  try {
    const r = await byName.desktop_set_font_scale.execute(args, { signal: new AbortController().signal });
    console.log(`[desktop_set_font_scale] ${JSON.stringify(args)} -> appliedScale = ${r.appliedScale}`);
  } catch (e) {
    console.log(`[desktop_set_font_scale] ${JSON.stringify(args)} FAILED:`, e.message.slice(0, 100));
  }
}
try {
  await byName.desktop_set_font_scale.execute({}, { signal: new AbortController().signal });
  console.log("[desktop_set_font_scale] 空参未报错（意外）");
} catch (e) {
  console.log("[desktop_set_font_scale] 空参按预期报错:", e.message.slice(0, 80));
}
const statusAfter = await byName.desktop_status.execute({}, { signal: new AbortController().signal });
console.log("[desktop_status] fontScale(最终) =", statusAfter.fontScale);

// 6) 路由已注册（SSE 下行 + POST 上报）
console.log("\n[路由] registered:", [...routes.keys()].join(", "));

// 7) desktop 服务扩展（getFontScale / setFontScale）
const svc = services.desktop;
console.log("[服务] getFontScale() =", svc.getFontScale());
svc.setFontScale(1.1);
console.log("[服务] setFontScale(1.1) 后 getFontScale() =", svc.getFontScale(), "| status.fontScale =", svc.get().fontScale);

// 8) 定时提醒（安排 → 列出 → 取消 → 再次列出）
const rem = await byName.desktop_remind.execute(
  { minutes: 60, text: "喝水提醒" },
  { signal: new AbortController().signal }
);
console.log("\n[desktop_remind] id =", rem.id, "| 触发时间 =", new Date(rem.at).toLocaleTimeString());
const list1 = await byName.desktop_reminders.execute({}, { signal: new AbortController().signal });
console.log("[desktop_reminders] 数量 =", list1.reminders.length, "| 剩余秒数 =", list1.reminders[0]?.remainingSeconds);
const c1 = await byName.desktop_remind_cancel.execute({ id: rem.id }, { signal: new AbortController().signal });
console.log("[desktop_remind_cancel] cancelled =", c1.cancelled);
const c2 = await byName.desktop_remind_cancel.execute({ id: "rem-nonexistent" }, { signal: new AbortController().signal });
console.log("[desktop_remind_cancel] 未知 id cancelled =", c2.cancelled);
const list2 = await byName.desktop_reminders.execute({}, { signal: new AbortController().signal });
console.log("[desktop_reminders] 取消后数量 =", list2.reminders.length);
try {
  await byName.desktop_remind.execute({ minutes: -5, text: "x" }, { signal: new AbortController().signal });
  console.log("[desktop_remind] 负数分钟未报错（意外）");
} catch (e) {
  console.log("[desktop_remind] 负数分钟按预期报错:", e.message.slice(0, 60));
}

console.log("\n自检完成 ✔");
