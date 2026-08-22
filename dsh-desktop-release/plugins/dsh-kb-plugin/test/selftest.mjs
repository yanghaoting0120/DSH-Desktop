// dsh-kb 插件自检脚本：mock ctx 调用 host 面逻辑，验证目录树/文件/搜索路由的行为。
// 用法: node test/selftest.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 动态导入 host 面（ESM）。
const kb = await import("../lib/index.js");

// 构造一个临时知识库目录。
const tmp = mkdtempSync(path.join(tmpdir(), "kb-test-"));
try {
  mkdirSync(path.join(tmp, "knowledge"), { recursive: true });
  mkdirSync(path.join(tmp, "skills", "literature-reader"), { recursive: true });
  mkdirSync(path.join(tmp, "memory", "long-term"), { recursive: true });
  writeFileSync(path.join(tmp, "knowledge", "index.md"), "# 索引\n\n- [测试](x.md) — 演示\n", "utf8");
  writeFileSync(path.join(tmp, "skills", "literature-reader", "SKILL.md"), "# 文献阅读\n\n用于测试。\n", "utf8");
  writeFileSync(path.join(tmp, "memory", "long-term", "user.md"), "用户偏好：简洁。\n", "utf8");

  // mock ctx：记录注册的 handler，模拟请求。
  const routes = new Map();
  const ctx = {
    config: {
      kbRoot: tmp,
      workspaceRoot: path.dirname(tmp), // 工作区根 = 临时目录的父目录（含 tmp 本身）
      sections: ["knowledge", "skills", "memory", "tasks"],
      workspaceExclude: ["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "logs", ".会话解压"],
      maxFileBytes: 4 * 1024 * 1024,
    },
    effect(fn) { this._dispose = fn(); },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  kb.apply(ctx);

  function callRoute(routePath, query = "") {
    const handler = routes.get(routePath);
    assert.ok(handler, `route ${routePath} registered`);
    let status = 0;
    let body = null;
    const req = { method: "GET", url: routePath + (query ? "?" + query : "") };
    const res = {
      writeHead(code, headers) { status = code; },
      end(data) { body = JSON.parse(data); },
    };
    handler(req, res);
    return { status, body };
  }

  // 1. 目录树
  const tree = callRoute("/plugins/kb/tree");
  assert.equal(tree.status, 200);
  assert.equal(tree.body.ok, true);
  assert.equal(tree.body.sections.knowledge.exists, true);
  const kbFiles = tree.body.sections.knowledge.tree;
  assert.ok(kbFiles.some((f) => f.name === "index.md"), "knowledge/index.md 在树中");
  // 回归测试：树中文件路径必须带分区前缀（否则点开会 404）
  const indexEntry = kbFiles.find((f) => f.name === "index.md");
  assert.ok(indexEntry && indexEntry.path.startsWith("knowledge/"),
    `树路径应带分区前缀，实际 "${indexEntry && indexEntry.path}"`);
  // 树中返回的路径应能被 file API 直接读取（模拟点击）
  if (indexEntry) {
    const viaTree = callRoute("/plugins/kb/file", "path=" + encodeURIComponent(indexEntry.path));
    assert.equal(viaTree.status, 200, `树路径可直接读取：${indexEntry.path}`);
  }

  // 2. 读取文件
  const file = callRoute("/plugins/kb/file", "path=knowledge/index.md");
  assert.equal(file.status, 200);
  assert.ok(file.body.content.includes("# 索引"), "文件内容读取正确");

  // 3. 搜索
  const search = callRoute("/plugins/kb/search", "q=%E6%B5%8B%E8%AF%95");
  assert.equal(search.status, 200);
  assert.ok(search.body.results.length >= 2, `搜索应命中多个文件，实际 ${search.body.results.length}`);

  // 4. 路径穿越防护
  const evil = callRoute("/plugins/kb/file", "path=..%2F..%2Fsecret");
  assert.equal(evil.status, 400, "路径穿越应被拒绝");

  // 5. 知识图谱：节点 + 边
  // 给 index.md 加上指向其他文件的链接，验证边生成。
  writeFileSync(
    path.join(tmp, "knowledge", "index.md"),
    "# 索引\n\n- [测试](x.md) — 演示\n\n参考 [用户偏好](memory/long-term/user.md) 与 [技能](../skills/literature-reader/SKILL.md)\n",
    "utf8"
  );
  const graph = callRoute("/plugins/kb/graph");
  assert.equal(graph.status, 200);
  assert.equal(graph.body.ok, true);
  assert.ok(graph.body.nodes.length >= 3, `图谱应有至少 3 个节点，实际 ${graph.body.nodes.length}`);
  assert.ok(graph.body.links.length >= 2, `图谱应有至少 2 条边，实际 ${graph.body.links.length}`);
  const hasIndex = graph.body.nodes.some((n) => n.path === "knowledge/index.md");
  assert.ok(hasIndex, "index.md 应作为节点出现");

  // 6. 记忆日记：按日期一列
  writeFileSync(
    path.join(tmp, "memory", "2026-08-20.md"),
    "# 记忆日记: 2026-08-20\n\n## 今日做了什么\n\n- 测试任务\n\n## 布置的任务\n\n- [ ] 待办\n",
    "utf8"
  );
  const diary = callRoute("/plugins/kb/diary");
  assert.equal(diary.status, 200);
  assert.equal(diary.body.ok, true);
  assert.ok(diary.body.entries.length >= 1, `日记应至少 1 条，实际 ${diary.body.entries.length}`);
  // 按日期倒序：最近的在前
  assert.ok(diary.body.entries[0].date >= diary.body.entries[diary.body.entries.length - 1].date, "日记应按日期倒序");
  const hasSummary = diary.body.entries.some((e) => e.summary && e.summary.length > 0);
  assert.ok(hasSummary, "日记应有摘要");

  // 7. 工作区浏览：workspace 树应包含临时目录，且其文件可经 file API 读取
  const ws = callRoute("/plugins/kb/workspace");
  assert.equal(ws.status, 200);
  assert.equal(ws.body.ok, true);
  const tmpBase = path.basename(tmp);
  const wsEntry = ws.body.tree.find((s) => s.type === "dir" && s.name === tmpBase);
  assert.ok(wsEntry, "工作区树应包含临时目录");
  // 树是嵌套结构，递归查找 knowledge/index.md
  let kbIndex = null;
  const findFile = (list) => {
    for (const e of list) {
      if (e.type === "file" && e.path.includes("knowledge/index.md")) { kbIndex = e; return; }
      if (e.type === "dir" && e.children) findFile(e.children);
    }
  };
  findFile(ws.body.tree);
  assert.ok(kbIndex, "工作区树应含 knowledge/index.md");
  if (kbIndex) {
    const viaWs = callRoute("/plugins/kb/file", "path=" + encodeURIComponent(kbIndex.path));
    assert.equal(viaWs.status, 200, `工作区文件可直接读取：${kbIndex.path}`);
  }
  console.log("✅ dsh-kb host 自检全部通过（tree/file/search/防穿越/graph/diary/workspace）");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
