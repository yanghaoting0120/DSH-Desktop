/**
 * dsh-ocr — DSH OCR 插件（host 面）。
 *
 * 提供：
 *  - 工具 `ocr_recognize`    识别图片，或对视频截取关键帧后逐帧识别，返回全部文本。
 *  - 路由 `POST /plugins/ocr/upload`  接收客户端上传的图片/视频文件
 *    （桌面模式传本地路径；浏览器模式传 base64），保存后自动识别并返回文本。
 *
 * OCR 引擎：Windows 10+ 内置 WinRT OCR（Windows.Media.Ocr），经 powershell.exe
 * 调用 lib/ocr.ps1 实现，离线、免费、支持中文（zh-Hans-CN）。
 * 视频关键帧：ffmpeg 均匀抽帧（默认最多 6 帧），逐帧识别后合并。
 *
 * 所有工具注册进 host 层的 tools 注册表（global 层），对任意 agent preset 可见。
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** 插件 id（cordis 条目名）。 */
const name = "ocr";

/** 依赖的服务：tools（工具注册表）、webServer（上传路由）、systemPrompt（提示词注入）。 */
const inject = ["tools", "webServer", "systemPrompt"];

/** 图片扩展名 → 直接 OCR。 */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);
/** 视频扩展名 → 截帧后 OCR。 */
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".flv", ".wmv", ".ts"]);

/** 插件配置（全部可选，均有默认值）。 */
const Config = z.object({
  /** 默认 OCR 语言标签（Windows 语言包标签，如 zh-Hans-CN / en-US / en-GB）。 */
  lang: z.string().default("zh-Hans-CN"),
  /** 视频最多抽取的关键帧数（1–20）。 */
  maxFrames: z.number().min(1).max(20).default(6),
  /** ffmpeg 可执行文件（在 PATH 中可直接写 ffmpeg）。 */
  ffmpegPath: z.string().default("ffmpeg"),
  /** powershell 可执行文件。 */
  powershellPath: z.string().default("powershell.exe"),
  /** 单张图片 OCR 超时（毫秒）。 */
  ocrTimeoutMs: z.number().min(5000).max(120000).default(30000),
  /** 视频截帧工具整体超时（毫秒）。 */
  ffmpegTimeoutMs: z.number().min(10000).max(300000).default(120000),
  /** 上传文件保存目录名（相对工作区）。 */
  uploadDir: z.string().default("ocr-uploads"),
});

// ── 工具函数 ──────────────────────────────────────────────────────────────

/** 把外部文件名规范化为安全的 basename（防路径穿越）。 */
function safeBaseName(name) {
  const base = path.basename(String(name || "file"));
  return base && base !== "." && base !== ".." ? base : "file";
}

/** spawn 一个命令并收集 stdout/stderr；超时自动 kill；返回 { code, stdout, stderr }。 */
function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch { /* ignore */ }
        resolve({ code: -1, stdout, stderr: stderr + "\n[timeout] command timed out" });
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: String((err && err.message) || err) });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
  });
}

/** 调用 ocr.ps1 识别一张图片；resolve 为识别文本（可能为空字符串）。 */
async function ocrImage(imagePath, lang, cfg) {
  const outFile = path.join(
    path.dirname(imagePath),
    `.ocr-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  const scriptPath = new URL("./ocr.ps1", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-ImagePath", imagePath,
    "-Lang", lang,
    "-OutFile", outFile,
  ];
  const r = await runCommand(cfg.powershellPath, args, cfg.ocrTimeoutMs);
  let text = "";
  try {
    if (existsSync(outFile)) text = readFileSync(outFile, "utf8");
  } catch { /* ignore */ }
  try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
  if (r.code !== 0 && !text) {
    throw new Error(`OCR 失败（${path.basename(imagePath)}）：${(r.stderr || "未知错误").trim().slice(0, 300)}`);
  }
  return text;
}

/** 用 ffmpeg 读取视频时长（秒）；失败返回 null。 */
async function probeVideoDuration(videoPath, cfg) {
  const r = await runCommand(cfg.ffmpegPath, ["-i", videoPath], cfg.ffmpegTimeoutMs);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * 从视频均匀抽取最多 maxFrames 个关键帧到 outDir，返回帧文件路径数组。
 * 用 -ss 快速定位 + -frames:v 1 精确抽帧，避免整段解码。
 */
async function extractKeyFrames(videoPath, outDir, maxFrames, cfg) {
  mkdirSync(outDir, { recursive: true });
  const duration = await probeVideoDuration(videoPath, cfg);
  const count = duration ? Math.min(maxFrames, Math.max(1, Math.floor(duration))) : maxFrames;
  const framePaths = [];
  for (let i = 0; i < count; i++) {
    const t = duration ? (duration * (i + 0.5)) / count : i;
    const out = path.join(outDir, `frame_${String(i + 1).padStart(3, "0")}.png`);
    const r = await runCommand(
      cfg.ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(t), "-i", videoPath, "-frames:v", "1", "-q:v", "2", out],
      cfg.ffmpegTimeoutMs
    );
    if (r.code === 0 && existsSync(out)) framePaths.push(out);
  }
  return framePaths;
}

/**
 * 识别一个文件：图片直接 OCR；视频抽帧后逐帧 OCR。
 * resolve 为 { kind, text, frames: [{ path, text }] }。
 */
async function recognizeFile(filePath, cfg, exec) {
  const ext = path.extname(filePath).toLowerCase();
  if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);

  if (IMAGE_EXTS.has(ext)) {
    exec?.signal?.throwIfAborted?.();
    const text = await ocrImage(filePath, cfg.lang, cfg);
    return { kind: "image", text, frames: [{ path: filePath, text }] };
  }
  if (VIDEO_EXTS.has(ext)) {
    const tmpDir = path.join(path.dirname(filePath), `.frames-${process.pid}-${Date.now()}`);
    try {
      const frames = await extractKeyFrames(filePath, tmpDir, cfg.maxFrames, cfg);
      if (frames.length === 0) throw new Error("未能从视频中抽取关键帧（请确认 ffmpeg 可用）");
      const results = [];
      for (const f of frames) {
        exec?.signal?.throwIfAborted?.();
        const text = await ocrImage(f, cfg.lang, cfg);
        results.push({ path: f, text });
      }
      // 合并文本：非空帧文本之间空行分隔；完全重复的连续帧去重。
      const unique = [];
      for (const r of results) {
        const t = r.text.trim();
        if (!t) continue;
        if (unique.length && unique[unique.length - 1] === t) continue;
        unique.push(t);
      }
      const text = unique.join("\n\n");
      return { kind: "video", text, frames: results };
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  throw new Error(`不支持的文件类型：${ext}（支持图片 png/jpg/webp/bmp/gif/tiff 与常见视频格式）`);
}

// ── 插件主体 ──────────────────────────────────────────────────────────────

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function apply(ctx, config) {
  const cfg = Config(config);

  // ── 工具 ocr_recognize ──────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: "ocr_recognize",
    description:
      "Recognize text in an image file, or extract key frames from a video file and recognize each of them. " +
      "Returns the recognized text (empty string when no text is found). " +
      "Supported inputs: images (png/jpg/jpeg/webp/bmp/gif/tiff) and common video formats (mp4/mov/avi/mkv/webm/m4v/flv/wmv/ts). " +
      "For videos, up to maxFrames key frames are sampled evenly across the duration and OCR'd; near-duplicate consecutive frames are de-duplicated. " +
      "Uses the Windows built-in OCR engine (offline, supports Chinese).",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Absolute path to the image or video file to recognize.",
      },
      lang: {
        type: "string",
        description: `OCR language tag (default "${cfg.lang}"). Examples: zh-Hans-CN, en-US, en-GB, ja-JP.`,
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["image", "video"], required: true },
          text: { type: "string", required: true },
          frames: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                text: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (args, value) => {
        if (value.kind === "video" && value.frames.length > 1) {
          const nonEmpty = value.frames.filter((f) => f.text.trim()).length;
          return [
            { type: "text", text: `已从视频抽取 ${value.frames.length} 个关键帧，识别到文本的帧：${nonEmpty} 帧。` },
            ...(value.text.trim()
              ? [{ type: "text", text: `识别文本：\n${value.text}` }]
              : [{ type: "text", text: "未识别到任何文本。" }]),
          ];
        }
        return value.text.trim()
          ? [{ type: "text", text: `识别文本：\n${value.text}` }]
          : [{ type: "text", text: "未识别到任何文本。" }];
      },
    },
    timeoutMs: cfg.ffmpegTimeoutMs + cfg.ocrTimeoutMs * 2,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return recognizeFile(args.path, cfg, exec);
    },
  }));

  // ── 路由 POST /plugins/ocr/upload ───────────────────────────────────────

  const disposeUpload = ctx.webServer.register({
    kind: "exact",
    path: "/plugins/ocr/upload",
    handler: async (req, res) => {
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== "POST") {
        send(405, { ok: false, error: "method not allowed" });
        return;
      }
      let payload;
      try {
        // 视频可能较大，放宽到 200MB。
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 200 * 1024 * 1024) throw new Error("上传文件过大（>200MB）");
          chunks.push(chunk);
        }
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (err) {
        send(400, { ok: false, error: String((err && err.message) || err) });
        return;
      }
      const name = safeBaseName(payload?.name || "");
      const uploadRoot = path.join(process.cwd(), cfg.uploadDir);
      mkdirSync(uploadRoot, { recursive: true });
      const dest = path.join(uploadRoot, name);
      try {
        if (typeof payload?.path === "string" && payload.path) {
          // 桌面模式：从本地路径复制（大文件无需 base64）。
          if (!existsSync(payload.path)) {
            send(400, { ok: false, error: "源文件不存在" });
            return;
          }
          copyFileSync(payload.path, dest);
        } else if (typeof payload?.base64 === "string" && payload.base64) {
          // 浏览器模式：base64 内容写入。
          writeFileSync(dest, Buffer.from(payload.base64, "base64"));
        } else {
          send(400, { ok: false, error: "缺少 path 或 base64" });
          return;
        }
        const result = await recognizeFile(dest, cfg, null);
        send(200, {
          ok: true,
          name,
          dest,
          kind: result.kind,
          text: result.text,
          frames: result.frames.map((f) => ({ path: f.path, text: f.text })),
        });
      } catch (err) {
        send(500, { ok: false, error: String((err && err.message) || err) });
      }
    },
  });

  // ── 系统提示词注入 ──────────────────────────────────────────────────────

  ctx.effect(() => {
    return ctx.systemPrompt.section({
      name: "ocr:usage",
      order: 160,
      text:
        "OCR 识别约定（工具 ocr_recognize）：当用户要求识别图片、截图、扫描件，或" +
        "提供图片/视频文件希望提取其中的文字时，调用 ocr_recognize 完成识别。图片直接识别；" +
        "视频会先抽取关键帧再逐帧识别。识别结果中的 text 字段即提取出的文字，可直接" +
        "用于分析、总结、翻译或转写。识别不出文字时 text 为空字符串，属正常情况。",
    });
  });

  return () => {
    disposeUpload();
  };
}

export { name, inject, apply };
