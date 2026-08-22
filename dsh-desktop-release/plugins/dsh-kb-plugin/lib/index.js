/**
 * dsh-kb — DSH 知识中心插件（host 面）。
 *
 * 提供文件系统 API，供客户端「知识库」视图读取知识库/技能/记忆/任务：
 *   GET /plugins/kb/tree            → 目录树（JSON）
 *   GET /plugins/kb/file?path=...   → 单个 Markdown 文件内容（JSON）
 *   GET /plugins/kb/search?q=...    → 全库文本搜索（文件名 + 内容）
 *
 * 根目录默认指向工作区下的会话文件夹，可通过插件配置 kbRoot 覆盖。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import z from "@deepseek-ai/schemastery";

/** 插件 id（cordis 条目名）。 */
const name = "kb";

/** 依赖的服务：webServer（注册 /plugins/kb 路由）。 */
const inject = ["webServer"];

/** 插件配置。 */
const Config = z.object({
  /** 知识中心根目录。默认：工作区下「DeepSeek Harness/学习Outbox排版功能并拓展（AutoBox深度分析）」；
   *  若不存在则回退到工作区本身。 */
  kbRoot: z.string().default(""),
  /** 允许读取的顶层目录名（相对 kbRoot）。 */
  sections: z
    .array(z.string())
    .default(["knowledge", "skills", "memory", "tasks"]),
  /** 工作区根目录（用于「工作区」视图浏览全部历史工作文件）。默认取 process.cwd()。 */
  workspaceRoot: z.string().default(""),
  /** 工作区视图排除的目录名（不展示）。 */
  workspaceExclude: z
    .array(z.string())
    .default(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "logs", ".session解压", ".会话解压"]),
  /** 单文件最大读取字节数（防超大文件）。 */
  maxFileBytes: z.number().min(1024).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
});

// ── 工具函数 ──────────────────────────────────────────────────────────────

/** 安全的 JSON 响应。 */
function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/** 把任意值规范化为字符串（容错）。 */
function toStr(v) {
  return typeof v === "string" ? v : "";
}

/** 将路径规范化并限制在 root 内（防目录穿越）。 */
function resolveSafe(root, rel) {
  const target = path.resolve(root, toStr(rel));
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null;
  }
  return target;
}

/** 递归构建目录树（仅 .md/.json/.txt/.js/.py 等文本文件）。 */
function buildTree(absPath, relPrefix) {
  const entries = [];
  let items;
  try {
    items = readdirSync(absPath, { withFileTypes: true });
  } catch {
    return { path: relPrefix, entries: [] };
  }
  items.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
  for (const entry of items) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(absPath, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      entries.push({
        name: entry.name,
        type: "dir",
        path: rel,
        children: buildTree(full, rel).entries,
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if ([".md", ".markdown", ".json", ".txt", ".js", ".mjs", ".py", ".yml", ".yaml", ".html", ".css"].includes(ext)) {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          /* 忽略 */
        }
        entries.push({ name: entry.name, type: "file", path: rel, size });
      }
    }
  }
  return { path: relPrefix, entries };
}

/** 读取文件内容（带大小上限）。目录、无权限、非 UTF-8 等情况返回 null。 */
function readFileSafe(absPath, maxBytes) {
  try {
    if (!existsSync(absPath)) return null;
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    if (st.size > maxBytes) return { truncated: true, size: st.size, content: "" };
    let raw = readFileSync(absPath, "utf8");
    // 去掉 UTF-8 BOM，避免内容首字符出现 \uFEFF
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return { truncated: false, size: st.size, content: raw };
  } catch {
    return null;
  }
}

/**
 * 构建知识关系图谱：节点 = 各 section 下的 Markdown 文件（index.md 除外），
 * 边 = 文件间的引用关系（Markdown 链接 [..](path) 指向同库文件）。
 * 每个节点附带：标题（首个 # 标题或文件名）、所在 section、路径。
 */
function buildGraph(root, cfg) {
  const nodes = [];
  const nodeByPath = new Map();
  const links = [];
  const linkSet = new Set();

  const isDocFile = (name) => {
    const ext = path.extname(name).toLowerCase();
    return [".md", ".markdown"].includes(ext);
  };

  const docTitle = (name, content) => {
    const m = /^#\s+(.+)$/m.exec(content || "");
    if (m) return m[1].trim().replace(/[*_`]/g, "").slice(0, 40);
    return path.basename(name, path.extname(name)).replace(/[-_]/g, " ").trim();
  };

  const sectionOf = (rel) => rel.split("/")[0] || "";

  const addNode = (rel, name, content) => {
    if (nodeByPath.has(rel)) return;
    const node = {
      id: rel,
      title: docTitle(name, content),
      section: sectionOf(rel),
      path: rel,
    };
    nodeByPath.set(rel, node);
    nodes.push(node);
  };

  const addLink = (from, to) => {
    if (from === to) return;
    if (!nodeByPath.has(from) || !nodeByPath.has(to)) return;
    const key = from + "→" + to;
    if (linkSet.has(key)) return;
    linkSet.add(key);
    links.push({ source: from, target: to });
  };

  // 收集每个 section 下的 md 文件（含子目录），并把文件名 → 相对路径映射起来，
  // 以便解析 Markdown 链接。
  const nameToPath = new Map();
  for (const section of cfg.sections) {
    const abs = path.join(root, section);
    if (!existsSync(abs)) continue;
    const walk = (dir, relPrefix) => {
      let items;
      try {
        items = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of items) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(full, rel);
        } else if (entry.isFile() && isDocFile(entry.name)) {
          let content = "";
          try {
            if (statSync(full).size <= cfg.maxFileBytes) {
              content = readFileSync(full, "utf8");
            }
          } catch {
            /* 忽略 */
          }
          addNode(rel, entry.name, content);
          const base = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
          if (!nameToPath.has(base)) nameToPath.set(base, rel);
        }
      }
    };
    walk(abs, section);
  }

  // 解析每个文件的 Markdown 链接 → 边。
  for (const node of nodes) {
    let content = "";
    try {
      const abs = path.join(root, node.path);
      if (statSync(abs).size <= cfg.maxFileBytes) {
        content = readFileSync(abs, "utf8");
      }
    } catch {
      /* 忽略 */
    }
    const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = linkRe.exec(content)) !== null) {
      let target = m[1].trim();
      if (!target || target.startsWith("http") || target.startsWith("#")) continue;
      // 去掉锚点/查询参数
      target = target.split("#")[0].split("?")[0];
      const norm = path.normalize(target).replace(/\\/g, "/");
      const base = path.basename(norm).toLowerCase().replace(/\.(md|markdown)$/i, "");
      if (norm.startsWith("../")) {
        // 相对上层引用：从当前文件目录向上解析
        const dir = path.dirname(node.path);
        const resolved = path.normalize(path.join(dir, norm)).replace(/\\/g, "/");
        if (nodeByPath.has(resolved)) {
          addLink(node.path, resolved);
        } else if (nameToPath.has(base)) {
          addLink(node.path, nameToPath.get(base));
        }
      } else if (nodeByPath.has(norm)) {
        addLink(node.path, norm);
      } else if (nameToPath.has(base)) {
        addLink(node.path, nameToPath.get(base));
      }
    }
  }

  return { ok: true, nodes, links };
}

/**
 * 构建工作区浏览树：遍历 workspaceRoot 下所有目录（限深度），
 * 只收集文档类文件（.md/.txt/.json 等），排除大目录。
 * 返回与 buildTree 同构的嵌套树：[{ name, path, type:'dir', children:[...] }, { name, path, type:'file', size }]
 */
function buildWorkspaceTree(root, exclude, maxDepth = 4) {
  const docExts = [".md", ".markdown", ".txt", ".json", ".docx", ".pdf", ".xlsx", ".pptx", ".html", ".js", ".py", ".yml", ".yaml"];
  const walk = (dir, relPrefix, depth) => {
    const entries = [];
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return entries;
    }
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, "zh");
    });
    for (const entry of items) {
      if (entry.name.startsWith(".")) continue;
      if (exclude.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          entries.push({ name: entry.name, path: rel, type: "dir", children: walk(full, rel, depth + 1) });
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (docExts.includes(ext)) {
          let size = 0;
          try {
            size = statSync(full).size;
          } catch {
            /* 忽略 */
          }
          entries.push({ name: entry.name, path: rel, type: "file", size });
        }
      }
    }
    return entries;
  };
  return walk(root, "", 0);
}

/** 计算工作区根目录。 */
function resolveWorkspaceRoot(cfg) {
  const ws = toStr(cfg.workspaceRoot).trim();
  if (ws) return path.resolve(ws);
  return process.cwd();
}

// ── 插件主体 ──────────────────────────────────────────────────────────────

/** 计算知识中心根目录。 */
function resolveRoot(cfg, cwd) {
  const kbRoot = toStr(cfg.kbRoot).trim();
  if (kbRoot) return path.resolve(kbRoot);
  const candidate = path.join(
    cwd,
    "DeepSeek Harness",
    "学习Outbox排版功能并拓展（AutoBox深度分析）",
  );
  return existsSync(candidate) ? candidate : cwd;
}

function apply(ctx, config) {
  const cfg = Config(config ?? ctx.config ?? {});
  const cwd = process.cwd();
  const root = resolveRoot(cfg, cwd);
  const wsRoot = resolveWorkspaceRoot(cfg);

  // 顶部「分区」列表：各 section 目录是否存在。
  ctx.effect(() => {
    const disposeTree = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/kb/tree",
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { ok: false, error: "method not allowed" });
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const section = toStr(url.searchParams.get("section") || "").trim();
        const sections = {};
        for (const name of cfg.sections) {
          const abs = path.join(root, name);
          sections[name] = {
            exists: existsSync(abs) && statSync(abs).isDirectory(),
            tree: existsSync(abs) ? buildTree(abs, name).entries : [],
          };
        }
        sendJson(res, 200, { ok: true, root, section, sections });
      },
    });

    const disposeFile = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/kb/file",
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { ok: false, error: "method not allowed" });
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const rel = toStr(url.searchParams.get("path") || "");
        if (!rel) {
          sendJson(res, 400, { ok: false, error: "path 不能为空" });
          return;
        }
        // 依次在 kbRoot 与工作区根下解析（工作区文件路径以工作区根为基准）
        let abs = resolveSafe(root, rel);
        if (abs) {
          const probe = readFileSafe(abs, cfg.maxFileBytes);
          if (probe) {
            sendJson(res, 200, { ok: true, path: rel, ...probe });
            return;
          }
        }
        let wsAbs = null;
        if (wsRoot !== root) {
          wsAbs = resolveSafe(wsRoot, rel);
          if (wsAbs) {
            const wsData = readFileSafe(wsAbs, cfg.maxFileBytes);
            if (wsData) {
              sendJson(res, 200, { ok: true, path: rel, ...wsData });
              return;
            }
          }
        }
        // 两个基准都解析失败（含路径穿越被拒）→ 400；解析到但文件不可读 → 404
        if (!abs && !wsAbs) {
          sendJson(res, 400, { ok: false, error: "非法路径" });
          return;
        }
        sendJson(res, 404, { ok: false, error: "文件不存在或不可读：" + rel });
      },
    });

    const disposeSearch = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/kb/search",
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { ok: false, error: "method not allowed" });
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const q = toStr(url.searchParams.get("q") || "").trim().toLowerCase();
        const results = [];
        if (q) {
          for (const section of cfg.sections) {
            const abs = path.join(root, section);
            if (!existsSync(abs)) continue;
            const walk = (dir, relPrefix) => {
              let items;
              try {
                items = readdirSync(dir, { withFileTypes: true });
              } catch {
                return;
              }
              for (const entry of items) {
                if (entry.name.startsWith(".")) continue;
                const full = path.join(dir, entry.name);
                const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                  walk(full, rel);
                } else if (entry.isFile()) {
                  const ext = path.extname(entry.name).toLowerCase();
                  if (![".md", ".markdown", ".txt", ".json"].includes(ext)) continue;
                  try {
                    const size = statSync(full).size;
                    if (size > cfg.maxFileBytes) continue;
                    const content = readFileSync(full, "utf8");
                    const lower = content.toLowerCase();
                    const idx = lower.indexOf(q);
                    const matched = entry.name.toLowerCase().includes(q) || idx !== -1;
                    if (matched) {
                      results.push({
                        section,
                        path: rel,
                        name: entry.name,
                        size,
                        snippet: idx !== -1
                          ? content.slice(Math.max(0, idx - 60), idx + 140).replace(/\s+/g, " ")
                          : "",
                      });
                    }
                  } catch {
                    /* 忽略单文件错误 */
                  }
                }
              }
            };
            walk(abs, section);
          }
          results.sort((a, b) => a.section.localeCompare(b.section) || a.path.localeCompare(b.path));
        }
        sendJson(res, 200, { ok: true, q, results: results.slice(0, 100) });
      },
    });

    const disposeGraph = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/kb/graph",
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { ok: false, error: "method not allowed" });
          return;
        }
        sendJson(res, 200, buildGraph(root, cfg));
      },
    });

    // 日记 API：返回 memory 目录下按日期排序的日记列表（YYYY-MM-DD.md），含摘要。
    const disposeDiary = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/kb/diary",
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { ok: false, error: "method not allowed" });
          return;
        }
        const memAbs = path.join(root, "memory");
        const entries = [];
        if (existsSync(memAbs)) {
          let items;
          try {
            items = readdirSync(memAbs, { withFileTypes: true });
          } catch {
            items = [];
          }
          for (const entry of items) {
            if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) {
              const full = path.join(memAbs, entry.name);
              let content = "";
              try {
                if (statSync(full).size <= cfg.maxFileBytes) {
                  content = readFileSync(full, "utf8");
                }
              } catch {
                /* 忽略 */
              }
              const date = entry.name.slice(0, 10);
              // 摘要：首个主标题之后收集正文文本（跳过各级标题、代码块、空行）
              const lines = content.split(/\r?\n/);
              let summary = "";
              let started = false;
              let inCode = false;
              for (const line of lines) {
                const t = line.trim();
                if (/^```/.test(t)) { inCode = !inCode; continue; }
                if (inCode) continue;
                if (!started) {
                  if (/^#\s/.test(t)) { started = true; }
                  continue;
                }
                if (/^#{1,6}\s/.test(t)) continue; // 跳过子标题，继续收集正文
                if (!t) continue;
                summary += t.replace(/[*_`#>|\[\]()]/g, "").trim() + " ";
                if (summary.length > 120) break;
              }
              entries.push({
                date,
                path: "memory/" + entry.name,
                name: entry.name,
                size: statSync(full).size,
                summary: summary.trim() || "（无摘要）",
              });
            }
          }
          entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
        }
        sendJson(res, 200, { ok: true, entries });
      },
    });

    // 工作区 API：返回工作区根目录下所有历史工作目录及其文档文件。
    const disposeWorkspace = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/kb/workspace",
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { ok: false, error: "method not allowed" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          root: wsRoot,
          tree: buildWorkspaceTree(wsRoot, cfg.workspaceExclude),
        });
      },
    });

    return () => {
      disposeTree();
      disposeFile();
      disposeSearch();
      disposeGraph();
      disposeDiary();
      disposeWorkspace();
    };
  });
}

export { Config, apply, inject, name };
