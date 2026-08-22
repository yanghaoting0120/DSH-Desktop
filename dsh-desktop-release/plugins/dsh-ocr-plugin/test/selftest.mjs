// dsh-ocr 插件功能自检：
//   1. mock ctx 验证工具注册 / 路由注册 / 提示词注入；
//   2. 真实生成一张带中文+英文的测试图 → ocr_recognize 识别（验证 WinRT OCR）；
//   3. 生成一个 3 秒测试视频 → ocr_recognize 识别（验证 ffmpeg 截帧 + 逐帧 OCR）；
//   4. 模拟上传路由（本地路径）验证保存 + 识别链路。
// 用法：node test/selftest.mjs
import { apply } from "../lib/index.js";

const defs = [];
const routes = new Map();
const sections = [];
const ctx = {
  tools: { register: (d) => defs.push(d) },
  provide: () => {},
  effect: (cb) => cb(),
  emit: () => {},
  systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
  webServer: {
    register: ({ kind, path, handler }) => {
      routes.set(`${kind}:${path}`, handler);
      return () => routes.delete(`${kind}:${path}`);
    },
  },
};

apply(ctx, {});

console.log("注册的工具:", defs.map((d) => d.name).join(", "));
console.log("注册的路由:", [...routes.keys()].join(", "));
console.log("提示词段落:", sections.map((s) => s.name).join(", "));

const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
const signal = () => new AbortController().signal;

// ── 1) 生成测试图片（带中文 + 英文） ───────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const work = path.join(os.tmpdir(), "dsh-ocr-selftest");
mkdirSync(work, { recursive: true });
const imgPath = path.join(work, "sample.png");

// 用 PowerShell 生成一张白底黑字测试图（System.Drawing）。
const psGen = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 900, 240
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font("Microsoft YaHei", 26)
$g.DrawString("Hello DSH 你好世界 2026 OCR 自检测试", $font, [System.Drawing.Brushes]::Black, 20, 40)
$font2 = New-Object System.Drawing.Font("Microsoft YaHei", 18)
$g.DrawString("Second line: DeepSeek Harness Plugin", $font2, [System.Drawing.Brushes]::DarkBlue, 20, 120)
$g.Dispose()
$bmp.Save("${imgPath.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`;
execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psGen], { stdio: "inherit" });
console.log("\n[1] 测试图片已生成:", imgPath);

// ── 2) 图片 OCR ───────────────────────────────────────────────────────────
try {
  const r = await byName.ocr_recognize.execute({ path: imgPath }, { signal: signal() });
  console.log("\n[2] 图片 OCR:");
  console.log("    kind =", r.kind, "| frames =", r.frames.length);
  console.log("    text =", JSON.stringify(r.text));
  if (!r.text.trim()) console.log("    ⚠️ 未识别出文字（可能是字体/引擎问题）");
  else console.log("    ✔ 识别成功");
} catch (e) {
  console.log("\n[2] 图片 OCR FAILED:", e.message.slice(0, 200));
}

// ── 3) 生成测试视频（3 秒，画面为测试图） ─────────────────────────────────
const vidPath = path.join(work, "sample.mp4");
try {
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", imgPath, "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=900:240", vidPath], { stdio: "inherit" });
  console.log("\n[3] 测试视频已生成:", vidPath);
} catch (e) {
  console.log("\n[3] 生成视频失败（ffmpeg 不可用?）:", String(e).slice(0, 200));
}

// ── 4) 视频 OCR（截帧 + 逐帧识别） ────────────────────────────────────────
try {
  const r = await byName.ocr_recognize.execute({ path: vidPath }, { signal: signal() });
  console.log("\n[4] 视频 OCR:");
  console.log("    kind =", r.kind, "| 抽取帧数 =", r.frames.length);
  r.frames.forEach((f, i) => {
    console.log(`    帧 ${i + 1}: ${JSON.stringify(f.text.slice(0, 60))}`);
  });
  if (r.text.trim()) console.log("    ✔ 视频识别成功");
  else console.log("    ⚠️ 视频未识别出文字");
} catch (e) {
  console.log("\n[4] 视频 OCR FAILED:", e.message.slice(0, 300));
}

// ── 5) 模拟上传路由（本地路径 → 保存 → 识别） ─────────────────────────────
try {
  const handler = routes.get("exact:/plugins/ocr/upload");
  const res = { writeHead: () => {}, end: (s) => { console.log("\n[5] 上传路由响应:", s.slice(0, 400)); } };
  const req = {
    method: "POST",
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ name: "sample.png", path: imgPath }));
    },
  };
  await handler(req, res);
} catch (e) {
  console.log("\n[5] 上传路由 FAILED:", e.message.slice(0, 200));
}

// ── 6) 错误路径 / 不支持类型 ──────────────────────────────────────────────
try {
  await byName.ocr_recognize.execute({ path: "C:\\__no_such_file__.png" }, { signal: signal() });
  console.log("\n[6] 不存在的文件未报错（意外）");
} catch (e) {
  console.log("\n[6] 不存在的文件按预期报错:", e.message.slice(0, 80));
}
try {
  const txt = path.join(work, "note.txt");
  writeFileSync(txt, "hello");
  await byName.ocr_recognize.execute({ path: txt }, { signal: signal() });
  console.log("[6] 不支持的扩展名未报错（意外）");
} catch (e) {
  console.log("[6] 不支持的扩展名按预期报错:", e.message.slice(0, 80));
}

console.log("\n自检完成 ✔");
