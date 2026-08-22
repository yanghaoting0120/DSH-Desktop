/**
 * dsh-desktop — DSH 桌面版插件（host 面）。
 *
 * 提供：
 *  - 工具 `desktop_open`    用操作系统默认应用打开文件 / 文件夹 / 网址，
 *                           或（Windows）在资源管理器中定位文件。
 *  - 工具 `desktop_notify`  发送 Windows 桌面通知（右下角气泡）。
 *  - 工具 `desktop_status`  读取桌面运行环境信息（是否运行于桌面版应用、服务器地址等）。
 *  - 服务 `desktop`         Cordis 服务，供其他插件读取同一份环境状态。
 *
 * 所有工具注册进 host 层的 tools 注册表（global 层），因此对使用任意
 * agent preset 的会话都可见；在浏览器版中运行同样可用（mode: "browser"）。
 *
 * 桌面版应用（dsh-desktop-app / Electron）启动 dsh web 时会注入环境变量：
 *   DSH_DESKTOP_APP=1 / DSH_DESKTOP_URL / DSH_DESKTOP_ELECTRON / DSH_DESKTOP_APP_VERSION
 * 本插件据此识别运行模式。
 */
import { spawn } from "node:child_process";
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** 插件 id（cordis 条目名）。 */
const name = "desktop";

/** 依赖的服务：tools（工具注册表）、webServer（注册 /plugins 路由，推字号事件）、
 *  systemPrompt（注入系统提示词，约定长任务完成后发桌面通知）。 */
const inject = ["tools", "webServer", "systemPrompt"];

// ── 界面字号调节（font-scale）───────────────────────────────────────────────

/** 字号缩放范围：0.8 = 缩小 20%，1.4 = 放大 40%。 */
const FONT_SCALE_MIN = 0.8;
const FONT_SCALE_MAX = 1.4;

/** level 预设 → 具体缩放系数。 */
const FONT_SCALE_LEVELS = { small: 0.85, medium: 1.0, large: 1.2 };

/** 将字号系数钳制到 [FONT_SCALE_MIN, FONT_SCALE_MAX]。 */
function clampScale(value) {
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
}

/** 序列化一帧 SSE 数据行（与 dsh-client-hmr 同一协议约定）。 */
function sseData(frame) {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** 读取并解析 JSON 请求体（带大小上限，防滥用）。 */
async function readJsonBody(req, maxBytes = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 把外部文件名规范化为安全的 basename（防路径穿越）。 */
function safeBaseName(name) {
  const base = path.basename(String(name || "file"));
  return base && base !== "." && base !== ".." ? base : "file";
}

/** 插件配置（全部可选，均有默认值）。 */
const Config = z.object({
  /** 桌面通知默认显示时长（毫秒）。 */
  notifyDurationMs: z.number().min(1000).max(60000).default(5000),
  /** 打开外部程序的最长等待时间（毫秒）。 */
  openTimeoutMs: z.number().min(1000).max(60000).default(10000),
});

// ── 环境状态 ──────────────────────────────────────────────────────────────

/** 读取当前桌面运行环境信息。fontScale 为当前界面字号系数（可能为 null）。 */
function readStatus(fontScale = null) {
  const isDesktop = process.env.DSH_DESKTOP_APP === "1";
  return {
    mode: isDesktop ? "desktop" : "browser",
    platform: process.platform,
    desktopApp: isDesktop
      ? {
          version: process.env.DSH_DESKTOP_APP_VERSION ?? "unknown",
          electron: process.env.DSH_DESKTOP_ELECTRON ?? "unknown",
        }
      : null,
    serverUrl: process.env.DSH_DESKTOP_URL ?? process.env.DSH_WEB_URL ?? null,
    dshHome: process.env.DSH_HOME ?? null,
    workspace: process.cwd(),
    node: process.version,
    fontScale,
  };
}

// ── 工具实现 ───────────────────────────────────────────────────────────────

/** 用系统默认应用打开目标；resolve 为 { ok, command, target }。 */
async function openTarget(target, reveal, timeoutMs) {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("desktop_open: target 必须是非空字符串（文件路径、文件夹路径或 URL）");
  }
  const value = target.trim();
  const isUrl = /^(https?|mailto|tel|file):/i.test(value);

  // 本地路径先做存在性检查：`start` 对不存在的路径会弹系统错误框并挂住。
  if (!isUrl && !existsSync(value)) {
    throw new Error(`desktop_open: 路径不存在：${value}`);
  }

  let command;
  let args;
  if (process.platform === "win32") {
    if (reveal) {
      command = "explorer.exe";
      args = ["/select," + value];
    } else if (isUrl) {
      command = "cmd.exe";
      args = ["/c", "start", "", value];
    } else {
      command = "cmd.exe";
      args = ["/c", "start", "", value];
    }
  } else if (process.platform === "darwin") {
    command = "open";
    args = reveal ? ["-R", value] : [value];
  } else {
    command = "xdg-open";
    args = [value];
  }

  const result = await runCommand(command, args, timeoutMs);
  return { ok: true, command, target: value, ...result };
}

/** 发送 Windows 桌面通知。 */
async function notifyWindows(title, body, durationMs) {
  const esc = (s) => String(s).replace(/'/g, "''");
  const showMs = Math.max(1000, Math.round(durationMs));
  const sleepMs = Math.min(20000, Math.max(2000, showMs + 1500));
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = [System.Drawing.SystemIcons]::Information",
    "$n.Visible = $true",
    `$n.BalloonTipTitle = '${esc(title)}'`,
    `$n.BalloonTipText = '${esc(body)}'`,
    `$n.ShowBalloonTip(${showMs})`,
    `Start-Sleep -Milliseconds ${sleepMs}`,
    "$n.Dispose()",
  ].join("\n");
  return runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], showMs + 15000);
}

/** 运行外部命令并等待退出；失败时抛出带退出码的错误。不捕获输出（stdio 全忽略），
 *  避免子进程管道阻塞，且在受限环境下也能运行。 */
function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时（${timeoutMs}ms）：${command} ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`无法启动命令 ${command}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ exitCode: code });
      } else {
        reject(new Error(`命令失败（退出码 ${code}）：${command} ${args.join(" ")}`));
      }
    });
  });
}

function apply(ctx, config = {}) {
  const cfg = { notifyDurationMs: 5000, openTimeoutMs: 10000, ...config };

  // ── 字号状态与推送 ────────────────────────────────────────────────────────

  /** 当前字号系数（host 侧权威值；客户端滑块也会经 POST 同步到这里）。 */
  let fontScale = 1;

  /** 已连接的 SSE 客户端（浏览器端 /plugins/desktop/events 订阅者）。 */
  const fontScaleClients = new Set();

  /** 向所有浏览器端推送一帧并发出 host 侧事件（其他插件可用 ctx.on("desktop/font-scale") 监听）。 */
  const broadcastFontScale = () => {
    const line = sseData({ type: "font-scale", scale: fontScale });
    for (const res of fontScaleClients) {
      try {
        res.write(line);
      } catch {
        /* 客户端已断开，交给 close 事件清理 */
      }
    }
    ctx.emit("desktop/font-scale", fontScale);
  };

  // 注册路由：GET /plugins/desktop/events（SSE 下行）+ POST /plugins/desktop/font-scale（客户端上报）。
  ctx.effect(() => {
    const disposeEvents = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/desktop/events",
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405);
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
        });
        res.write(": connected\n\n");
        // 连接即推送当前值，保证新打开的页面拿到最新字号。
        res.write(sseData({ type: "font-scale", scale: fontScale }));
        fontScaleClients.add(res);
        res.on("close", () => fontScaleClients.delete(res));
      },
    });
    const disposePost = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/desktop/font-scale",
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
          payload = await readJsonBody(req);
        } catch (err) {
          send(400, { ok: false, error: String((err && err.message) || err) });
          return;
        }
        const raw = payload && payload.scale;
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          send(400, { ok: false, error: "scale 必须是有限数字（0.8–1.4）" });
          return;
        }
        const clamped = clampScale(raw);
        // 值未变化时不广播：客户端拖动期间会高频上报，而每次广播都会触发
        // 客户端 apply → 再次上报，形成 POST→广播→POST 回环（每 150ms 一次
        // 整页 zoom 重排 + 网络请求，界面会持续卡顿）。值相同时直接回包即可。
        if (Math.abs(clamped - fontScale) > 1e-9) {
          fontScale = clamped;
          broadcastFontScale();
        }
        send(200, { ok: true, scale: fontScale });
      },
    });
    const disposeDropFile = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/desktop/drop-file",
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
          // 拖入的文件可能较大，放宽到 64MB。
          payload = await readJsonBody(req, 64 * 1024 * 1024);
        } catch (err) {
          send(400, { ok: false, error: String((err && err.message) || err) });
          return;
        }
        const dest = path.join(process.cwd(), safeBaseName(payload.name || ""));
        try {
          if (typeof payload.path === "string" && payload.path) {
            // 桌面模式：从本地路径复制
            if (!existsSync(payload.path)) {
              send(400, { ok: false, error: "源文件不存在" });
              return;
            }
            copyFileSync(payload.path, dest);
          } else if (typeof payload.base64 === "string" && payload.base64) {
            // 浏览器模式：base64 内容写入
            writeFileSync(dest, Buffer.from(payload.base64, "base64"));
          } else {
            send(400, { ok: false, error: "缺少 path 或 base64" });
            return;
          }
          send(200, { ok: true, dest, name: path.basename(dest) });
        } catch (err) {
          send(500, { ok: false, error: String((err && err.message) || err) });
        }
      },
    });
    return () => {
      disposeEvents();
      disposePost();
      disposeDropFile();
      fontScaleClients.clear();
    };
  }, "desktop: font-scale routes");

  // ── 长任务完成通知（系统提示词约定） ──────────────────────────────────────

  // 注入一条系统提示词：耗时较长的任务完成后，调用 desktop_notify 通知用户。
  ctx.effect(() => {
    return ctx.systemPrompt.section({
      name: "desktop:long-task-notify",
      order: 150,
      text:
        "桌面通知约定（工具 desktop_notify）：对预计耗时较长（约 1 分钟以上，" +
        "如长时间命令、脚本执行、构建、批量处理等）的用户请求，任务完成时调用 " +
        "desktop_notify 发送桌面通知告知用户结果（完成或失败，简要说明即可）。" +
        "即时完成的小任务无需通知。",
    });
  }, "desktop: long-task-notify instruction");

  // 提供 desktop 服务：其他插件可通过 ctx.desktop 读取环境状态与字号。
  const service = {
    get: () => readStatus(fontScale),
    isDesktop: process.env.DSH_DESKTOP_APP === "1",
    mode: process.env.DSH_DESKTOP_APP === "1" ? "desktop" : "browser",
    platform: process.platform,
    /** 读取当前字号系数（1 = 默认）。 */
    getFontScale: () => fontScale,
    /** 设置字号系数并推送给所有浏览器端（0.8–1.4）。 */
    setFontScale: (scale) => {
      fontScale = clampScale(scale);
      broadcastFontScale();
    },
  };
  ctx.provide("desktop", service);

  // ── 定时提醒 ───────────────────────────────────────────────────────────────

  /** 活跃提醒表：id → { id, text, at, timer }。 */
  const reminders = new Map();

  /** 安排一个提醒；到点发桌面通知。 */
  const scheduleReminder = (text, minutes) => {
    const id = `rem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const delayMs = Math.max(1000, Math.round(minutes * 60000));
    const at = Date.now() + delayMs;
    const timer = setTimeout(() => {
      reminders.delete(id);
      notifyWindows("⏰ 定时提醒", text, 8000).catch(() => {});
      ctx.emit("desktop/reminder", { id, text, at });
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    reminders.set(id, { id, text, at, timer });
    return { id, at };
  };

  // 插件卸载时清掉所有定时器。
  ctx.effect(() => {
    return () => {
      for (const r of reminders.values()) clearTimeout(r.timer);
      reminders.clear();
    };
  }, "desktop: reminder timers");

  // desktop_open：打开文件 / 文件夹 / 网址，或定位文件。
  ctx.tools.register(defineTool({
    name: "desktop_open",
    description:
      "Open a file, folder, or URL with the operating system's default application (browser for URLs, file associations for files). " +
      "Use this when the user asks to open, preview, or launch something on their machine, or to reveal a file in the file manager. " +
      "target may be an absolute filesystem path or an http(s)/mailto URL. On Windows, reveal: true opens Explorer with the file selected.",
    parameters: {
      target: {
        type: "string",
        required: true,
        description: "Absolute path to a file or folder, or a URL to open with the default app.",
      },
      reveal: {
        type: "boolean",
        description: "When true and target is a file, reveal it in the file manager instead of opening it (Windows: Explorer with selection).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          command: { type: "string", required: true },
          target: { type: "string", required: true },
          exitCode: { type: "integer" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `已用默认应用打开：${value.target}` },
      ],
    },
    timeoutMs: cfg.openTimeoutMs,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return openTarget(args.target, args.reveal === true, cfg.openTimeoutMs);
    },
  }));

  // desktop_notify：Windows 桌面通知。
  ctx.tools.register(defineTool({
    name: "desktop_notify",
    description:
      "Send a native Windows desktop notification (balloon toast near the system tray). " +
      "Use this to alert the user outside the chat window, e.g. when a long background task finishes or something needs attention.",
    parameters: {
      title: { type: "string", required: true, description: "Notification title (short)." },
      body: { type: "string", required: true, description: "Notification body text." },
      durationMs: {
        type: "integer",
        description: "How long the balloon stays visible, in milliseconds (default 5000, max 60000).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          title: { type: "string", required: true },
          body: { type: "string", required: true },
          exitCode: { type: "integer" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `已发送桌面通知：${value.title} — ${value.body}` },
      ],
    },
    timeoutMs: cfg.notifyDurationMs + 15000,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (process.platform !== "win32") {
        return { ok: false, title: args.title, body: args.body, exitCode: null };
      }
      const duration = Math.min(60000, Math.max(1000, args.durationMs ?? cfg.notifyDurationMs));
      const result = await notifyWindows(args.title, args.body, duration);
      return { ok: true, title: args.title, body: args.body, ...result };
    },
  }));

  // desktop_status：查询运行环境（含当前字号系数）。
  ctx.tools.register(defineTool({
    name: "desktop_status",
    description:
      "Report the current desktop/runtime environment: whether dsh runs inside the desktop app (mode: desktop) or a browser (mode: browser), " +
      "the platform, the web server URL, DSH_HOME, the workspace directory, runtime versions, and the current UI font scale factor.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    execute() {
      return readStatus(fontScale);
    },
  }));

  // desktop_set_font_scale：调节工作台界面字号（缩小/放大）。
  ctx.tools.register(defineTool({
    name: "desktop_set_font_scale",
    description:
      "Adjust the workbench UI font/interface size in the DeepSeek Harness desktop app (and web UI). " +
      "Pass scale as a number 0.8 (smaller, 20% smaller) to 1.4 (larger, 40% larger); 1.0 is the default size. " +
      "Alternatively pass level: 'small' (0.85), 'medium' (1.0), or 'large' (1.2). " +
      "Use this when the user asks to make the interface text smaller or larger. " +
      "The change applies instantly to all open windows and persists for the session. " +
      "Query the current value with desktop_status (field fontScale).",
    parameters: {
      scale: {
        type: "number",
        description: "Scale factor from 0.8 to 1.4; 1.0 = default. Ignored when level is given.",
      },
      level: {
        type: "string",
        enum: ["small", "medium", "large"],
        description: "Preset level; overrides scale when both are given.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          scale: { type: "number", required: true },
          appliedScale: { type: "number", required: true },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `界面字号已调整为 ${Math.round(value.appliedScale * 100)}%${value.appliedScale === 1 ? "（默认）" : ""}` },
      ],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      let scale;
      if (args.level !== undefined && FONT_SCALE_LEVELS[args.level] !== undefined) {
        scale = FONT_SCALE_LEVELS[args.level];
      } else if (typeof args.scale === "number" && Number.isFinite(args.scale)) {
        scale = args.scale;
      } else {
        throw new Error("desktop_set_font_scale: 请提供 scale（0.8–1.4 的数字）或 level（small / medium / large）");
      }
      const clamped = clampScale(scale);
      fontScale = clamped;
      broadcastFontScale();
      return { ok: true, scale: clamped, appliedScale: clamped };
    },
  }));

  // desktop_remind：设置一个定时提醒（到点发桌面通知）。
  ctx.tools.register(defineTool({
    name: "desktop_remind",
    description:
      "Schedule a timer that fires a native Windows desktop notification after the given delay. " +
      "Use this when the user asks to be reminded later, e.g. 'remind me in 20 minutes to drink water'. " +
      "minutes must be greater than 0. Returns a reminder id that can be cancelled with desktop_remind_cancel.",
    parameters: {
      minutes: {
        type: "number",
        required: true,
        description: "Delay in minutes before the reminder fires (must be > 0).",
      },
      text: {
        type: "string",
        required: true,
        description: "Reminder message shown in the notification.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          id: { type: "string", required: true },
          at: { type: "integer", required: true },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `已设置提醒（${new Date(value.at).toLocaleTimeString()}）：${_args.text}` },
      ],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const minutes = Number(args.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error("desktop_remind: minutes 必须是大于 0 的数字");
      }
      if (typeof args.text !== "string" || !args.text.trim()) {
        throw new Error("desktop_remind: text 不能为空");
      }
      const { id, at } = scheduleReminder(args.text.trim(), minutes);
      return { ok: true, id, at };
    },
  }));

  // desktop_reminders：列出当前所有未触发的提醒。
  ctx.tools.register(defineTool({
    name: "desktop_reminders",
    description: "List all pending desktop reminders (id, text, fire time, seconds remaining).",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reminders: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                text: { type: "string", required: true },
                at: { type: "integer", required: true },
                remainingSeconds: { type: "integer", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: "text", text: value.reminders.length === 0
          ? "当前没有待触发的提醒"
          : value.reminders.map((r) => `• ${new Date(r.at).toLocaleTimeString()}（${Math.round(r.remainingSeconds / 60)} 分钟后）：${r.text}`).join("\n") },
      ],
    },
    execute() {
      const now = Date.now();
      const list = [...reminders.values()].map((r) => ({
        id: r.id,
        text: r.text,
        at: r.at,
        remainingSeconds: Math.max(0, Math.round((r.at - now) / 1000)),
      }));
      return { ok: true, reminders: list };
    },
  }));

  // desktop_remind_cancel：取消一个待触发的提醒。
  ctx.tools.register(defineTool({
    name: "desktop_remind_cancel",
    description: "Cancel a pending reminder by its id (returned by desktop_remind). No-op if the id is unknown.",
    parameters: {
      id: { type: "string", required: true, description: "Reminder id to cancel." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          cancelled: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [
        { type: "text", text: value.cancelled ? "提醒已取消" : "未找到该提醒（可能已触发）" },
      ],
    },
    execute(args) {
      const r = reminders.get(args.id);
      if (!r) return { ok: true, cancelled: false };
      clearTimeout(r.timer);
      reminders.delete(args.id);
      return { ok: true, cancelled: true };
    },
  }));
}

export { Config, apply, inject, name };
