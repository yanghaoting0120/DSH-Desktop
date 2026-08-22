/**
 * dsh-kb — DSH 知识中心插件（client 面）。
 *
 * 在会话标题栏注册「知识库」视图标签（conversation.view 插槽），
 * 渲染 AutoBox 风格的知识中心：
 *   - 左侧分区导航（知识库 / 技能 / 记忆 / 任务）
 *   - 右侧文件树 + Markdown 内容预览（含简化渲染）
 *   - 顶部搜索框（调 /plugins/kb/search）
 *
 * 数据来自 host 面路由 /plugins/kb/tree、/plugins/kb/file、/plugins/kb/search。
 *
 * 注意：本文件是浏览器端 bundle，采用 DSH 客户端模块系统的 factory 格式
 * （window.__ModuleLoader__.load），由 dsh-client-modules 经
 * exports["./client"] 发现并以 /plugins/dsh-kb/client.js 提供。
 */
window.__ModuleLoader__.load({
	id: "dsh-kb",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── 插件元数据 ────────────────────────────────────────────────────────

		var name = "kb-client";
		var inject = ["slots"];
		var description = "知识中心视图：AutoBox 风格展示知识库/技能/记忆/任务。";

		// ── 常量：AutoBox 设计令牌 ───────────────────────────────────────────

		var PRIMARY = "#0d9488";
		var PRIMARY_HOVER = "#0f766e";
		var SECTIONS = [
			{ key: "knowledge", label: "知识库", desc: "全部工作文件与知识条目" },
			{ key: "skills", label: "技能", desc: "SKILL.md 技能库" },
			{ key: "memory", label: "记忆", desc: "跨会话记忆" },
			{ key: "tasks", label: "任务", desc: "任务归档与调度" },
		];

		// ── 工具函数 ─────────────────────────────────────────────────────────

		function api(path) {
			return fetch(path, { headers: { accept: "application/json" } })
				.then(function (r) {
					if (!r.ok) throw new Error("HTTP " + r.status);
					return r.json();
				})
				.then(function (j) {
					if (!j || j.ok !== true) throw new Error((j && j.error) || "请求失败");
					return j;
				});
		}

		/** 简单的 Markdown → HTML 渲染（安全子集：标题/列表/粗体/行内代码/表格/引用）。 */
		function renderMarkdown(text) {
			var src = String(text || "")
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			var lines = src.split(/\r?\n/);
			var html = "";
			var listType = null;
			function closeList() {
				if (listType) {
					html += "</" + listType + ">";
					listType = null;
				}
			}
			function inline(s) {
				return s
					.replace(/`([^`]+)`/g, "<code>$1</code>")
					.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
					.replace(/\*([^*]+)\*/g, "<em>$1</em>")
					.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
			}
			for (var i = 0; i < lines.length; i++) {
				var line = lines[i];
				var trimmed = line.trim();
				if (!trimmed) {
					closeList();
					continue;
				}
				var m;
				if (/^```/.test(trimmed)) {
					closeList();
					var codeLines = [];
					i++;
					while (i < lines.length && !/^```/.test(lines[i].trim())) {
						codeLines.push(lines[i]);
						i++;
					}
					html += "<pre class='kb-code'>" + codeLines.join("\n") + "</pre>";
					continue;
				}
				if ((m = trimmed.match(/^(#{1,4})\s+(.*)/))) {
					closeList();
					var h = m[1].length;
					html += "<h" + (h + 2) + ">" + inline(m[2]) + "</h" + (h + 2) + ">";
					continue;
				}
				if ((m = trimmed.match(/^[-*]\s+(.*)/))) {
					if (listType !== "ul") {
						closeList();
						html += "<ul>";
						listType = "ul";
					}
					html += "<li>" + inline(m[1]) + "</li>";
					continue;
				}
				if ((m = trimmed.match(/^\d+[.、)]\s+(.*)/))) {
					if (listType !== "ol") {
						closeList();
						html += "<ol>";
						listType = "ol";
					}
					html += "<li>" + inline(m[1]) + "</li>";
					continue;
				}
				if (/^\|.*\|$/.test(trimmed)) {
					closeList();
					var cells = trimmed.split("|").slice(1, -1).map(function (c) { return c.trim(); });
					if (/^:?-{2,}:?$/.test(cells.join(" ").trim())) continue; // 分隔行
					html += "<tr>" + cells.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
					continue;
				}
				if (/^>/.test(trimmed)) {
					closeList();
					html += "<blockquote>" + inline(trimmed.replace(/^>\s?/, "")) + "</blockquote>";
					continue;
				}
				if (/^[-*_]{3,}$/.test(trimmed)) {
					closeList();
					html += "<hr>";
					continue;
				}
				closeList();
				html += "<p>" + inline(trimmed) + "</p>";
			}
			closeList();
			return html;
		}

		function fmtSize(n) {
			if (n == null) return "";
			if (n < 1024) return n + " B";
			if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
			return (n / 1024 / 1024).toFixed(1) + " MB";
		}

		function escapeHtml(s) {
			return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		}

		// ── 样式（AutoBox 风格，全部使用 DSH 主题变量 → 深浅主题自动适配） ──

		var STYLE = `
			.kb-view{flex:1;overflow-y:auto;padding:24px;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
			.kb-container{max-width:960px;margin:0 auto}
			.kb-header{margin-bottom:20px}
			.kb-title{font-size:20px;font-weight:700;color:var(--dsw-alias-label-primary);margin:0 0 4px}
			.kb-desc{font-size:14px;color:var(--dsw-alias-label-secondary);margin:0}
			.kb-body{display:flex;gap:16px;align-items:flex-start}
			.kb-nav{flex:0 0 200px;display:flex;flex-direction:column;gap:8px;position:sticky;top:0}
			.kb-nav-item{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);transition:all .15s ease;text-align:left;font-size:14px;color:var(--dsw-alias-label-primary)}
			.kb-nav-item:hover{border-color:var(--dsw-alias-brand-primary)}
			.kb-nav-item.active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
			.kb-nav-icon{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);font-size:16px;flex:none}
			.kb-nav-label{flex:1;font-weight:600}
			.kb-nav-desc{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400;margin-top:1px}
			.kb-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:16px}
			.kb-search input{width:100%;height:40px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;font-size:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-sizing:border-box;outline:none;transition:border-color .15s}
			.kb-search input:focus{border-color:var(--dsw-alias-brand-primary)}
			.kb-search input::placeholder{color:var(--dsw-alias-label-secondary)}
			.kb-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px}
			.kb-card-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0 0 12px}
			.kb-tree{display:flex;flex-direction:column;gap:2px}
			.kb-tree-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary);transition:background .12s}
			.kb-tree-item:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
			.kb-tree-item.active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}
			.kb-tree-item.dir{font-weight:600;color:var(--dsw-alias-label-primary)}
			.kb-tree-children{margin-left:14px;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:2px}
			.kb-tree-size{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}
			.kb-empty{padding:28px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:14px}
			.kb-content{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:20px;font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary);overflow-wrap:break-word}
			.kb-content h3,.kb-content h4,.kb-content h5,.kb-content h6{color:var(--dsw-alias-label-primary);margin:18px 0 8px}
			.kb-content h3{font-size:16px}.kb-content h4{font-size:15px}.kb-content h5{font-size:14px}
			.kb-content p{margin:8px 0}
			.kb-content ul,.kb-content ol{margin:8px 0;padding-left:22px}
			.kb-content li{margin:3px 0}
			.kb-content code{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary);padding:1px 5px;border-radius:5px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
			.kb-content pre.kb-code{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);padding:12px 14px;border-radius:10px;overflow-x:auto;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.5}
			.kb-content pre.kb-code code{background:none;color:inherit;padding:0}
			.kb-content a{color:var(--dsw-alias-brand-primary);text-decoration:none}
			.kb-content a:hover{text-decoration:underline}
			.kb-content blockquote{border-left:3px solid var(--dsw-alias-brand-primary);margin:8px 0;padding:2px 12px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent);border-radius:0 8px 8px 0}
			.kb-content table{border-collapse:collapse;margin:10px 0;width:100%;font-size:13px}
			.kb-content tr:nth-child(odd){background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
			.kb-content td,.kb-content th{border:1px solid var(--dsw-alias-border-l1);padding:6px 10px;text-align:left}
			.kb-loading{display:flex;align-items:center;justify-content:center;padding:40px;color:var(--dsw-alias-label-secondary);font-size:14px;gap:8px}
			.kb-spin{width:16px;height:16px;border:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:kb-rot .8s linear infinite}
			@keyframes kb-rot{to{transform:rotate(360deg)}}
			.kb-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);padding:12px 14px;border-radius:10px;font-size:13px}
			.kb-search-res{display:flex;flex-direction:column;gap:8px}
			.kb-search-item{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;cursor:pointer;transition:border-color .12s}
			.kb-search-item:hover{border-color:var(--dsw-alias-brand-primary)}
			.kb-search-item .sec{font-size:11px;color:var(--dsw-alias-brand-primary);font-weight:600}
			.kb-search-item .nm{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:600;margin:2px 0}
			.kb-search-item .sn{font-size:12px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
			.kb-graph-wrap{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px}
			.kb-graph-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
			.kb-graph-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
			.kb-legend-item{display:flex;align-items:center;gap:5px}
			.kb-legend-dot{width:10px;height:10px;border-radius:50%;display:inline-block}
			.kb-graph-svg{width:100%;height:540px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);touch-action:none;cursor:grab;display:block}
			.kb-graph-svg:active{cursor:grabbing}
			.kb-graph-link{stroke:var(--dsw-alias-label-secondary);stroke-opacity:.45;stroke-width:1.2}
			.kb-graph-link.hot{stroke:var(--dsw-alias-brand-primary);stroke-opacity:.85;stroke-width:2.2}
			.kb-graph-node{cursor:pointer}
			.kb-graph-node circle{stroke:var(--dsw-alias-bg-layer-1);stroke-width:1.5;transition:r .12s ease}
			.kb-graph-node:hover circle{filter:brightness(1.12)}
			.kb-graph-node text{font-size:11px;fill:var(--dsw-alias-label-secondary);pointer-events:none;font-family:inherit}
			.kb-graph-node .kb-node-title{font-weight:600}
			.kb-graph-hint{font-size:12px;color:var(--dsw-alias-label-secondary);margin-left:auto}
			/* 记忆：按日期一列（AutoBox 风格） */
			.kb-diary{display:flex;flex-direction:column;gap:8px;max-height:560px;overflow-y:auto}
			.kb-diary-month{font-size:12px;font-weight:700;color:var(--dsw-alias-brand-primary);text-transform:uppercase;letter-spacing:.05em;margin:6px 0 2px}
			.kb-diary-day{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;cursor:pointer;transition:border-color .12s,background .12s;background:var(--dsw-alias-bg-layer-2)}
			.kb-diary-day:hover{border-color:var(--dsw-alias-brand-primary)}
			.kb-diary-day.active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-color:var(--dsw-alias-brand-primary)}
			.kb-diary-date{flex:0 0 96px;font-weight:700;font-size:14px;color:var(--dsw-alias-label-primary)}
			.kb-diary-date small{display:block;font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary)}
			.kb-diary-summary{flex:1;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
			.kb-diary-badge{flex:none;font-size:10px;font-weight:700;padding:2px 8px;border-radius:9999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}
			/* 淡入过渡：内容/分区切换时平滑出现，避免屏闪 */
			@keyframes kb-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
			.kb-fade-in{animation:kb-fade .18s ease-out}
			/* 目录展开/折叠过渡 */
			.kb-tree-children{animation:kb-fade .15s ease-out}
			.kb-tree-item{transition:background .12s,color .12s}
			@media (max-width:720px){.kb-body{flex-direction:column}.kb-nav{flex-direction:row;flex-wrap:wrap;position:static;flex:auto}.kb-nav-item{flex:1;min-width:130px}}
		`;

		// ── 视图组件 ─────────────────────────────────────────────────────────

		var KB_TREE_CACHE = null;

		/** 文件树递归渲染（目录可点击展开/折叠）。 */
		function TreeRecursive(props) {
			var entries = props.entries || [];
			var depth = props.depth || 0;
			var activePath = props.activePath;
			var onPick = props.onPick;
			var expandedPaths = props.expandedPaths || {};
			var onToggleDir = props.onToggleDir;
			return react.createElement(
				react.Fragment,
				null,
				entries.map(function (entry) {
					if (entry.type === "dir") {
						var isOpen = !!expandedPaths[entry.path];
						var childCount = 0;
						var countFiles = function (list) {
							for (var i = 0; i < list.length; i++) {
								if (list[i].type === "file") childCount++;
								else countFiles(list[i].children || []);
							}
						};
						countFiles(entry.children || []);
						var childrenEl = null;
						if (isOpen && entry.children && entry.children.length > 0) {
							childrenEl = react.createElement(
								"div",
								{ className: "kb-tree-children" },
								react.createElement(TreeRecursive, {
									entries: entry.children,
									depth: depth + 1,
									activePath: activePath,
									onPick: onPick,
									expandedPaths: expandedPaths,
									onToggleDir: onToggleDir,
								})
							);
						}
						return react.createElement(
							react.Fragment,
							{ key: entry.path },
							react.createElement(
								"div",
								{
									className: "kb-tree-item dir",
									onClick: function () { if (onToggleDir) onToggleDir(entry.path); },
									title: entry.path,
								},
								react.createElement("span", null, (isOpen ? "▾ " : "▸ ") + entry.name),
								react.createElement("span", { className: "kb-tree-size" }, childCount > 0 ? childCount + " 个文件" : "")
							),
							childrenEl
						);
					}
					var active = activePath === entry.path;
					return react.createElement(
						"div",
						{
							key: entry.path,
							className: "kb-tree-item" + (active ? " active" : ""),
							onClick: function () { onPick(entry.path, entry.name); },
							title: entry.path,
						},
						react.createElement("span", null, entry.name),
						react.createElement("span", { className: "kb-tree-size" }, fmtSize(entry.size))
					);
				})
			);
		}

		// ── 知识图谱（力导向可视化） ─────────────────────────────────────────

		/** section → 颜色映射（AutoBox 青绿主色系 + 分类色）。 */
		var GRAPH_COLORS = {
			knowledge: "#0d9488",
			skills: "#f59e0b",
			memory: "#8b5cf6",
			tasks: "#3b82f6",
		};
		var GRAPH_FALLBACK = "#64748b";

		function graphColor(section) {
			return GRAPH_COLORS[section] || GRAPH_FALLBACK;
		}

		/** 计算力导向布局：返回 [{x,y}]（坐标已归一化到 [0..1] 区间）。 */
		function forceLayout(nodes, links, iterations) {
			var n = nodes.length;
			if (n === 0) return [];
			var pos = nodes.map(function (_, i) {
				var angle = (i / n) * Math.PI * 2;
				return { x: 0.5 + Math.cos(angle) * 0.28, y: 0.5 + Math.sin(angle) * 0.28 };
			});
			var vel = nodes.map(function () { return { x: 0, y: 0 }; });
			var W = 1, H = 1; // 归一化空间
			var k = Math.sqrt((W * H) / Math.max(n, 1)) * 0.9; // 理想距离
			var iterations_ = iterations || 220;

			// 邻接表 + 度数（用于节点半径）
			var degree = new Array(n).fill(0);
			var adj = new Array(n).fill(null).map(function () { return []; });
			for (var li = 0; li < links.length; li++) {
				var s = links[li].source;
				var t = links[li].target;
				var si = nodes.findIndex(function (x) { return x.id === s; });
				var ti = nodes.findIndex(function (x) { return x.id === t; });
				if (si === -1 || ti === -1) continue;
				degree[si]++;
				degree[ti]++;
				adj[si].push(ti);
				adj[ti].push(si);
			}

			for (var it = 0; it < iterations_; it++) {
				// 斥力（所有节点对）
				for (var i = 0; i < n; i++) {
					for (var j = i + 1; j < n; j++) {
						var dx = pos[i].x - pos[j].x;
						var dy = pos[i].y - pos[j].y;
						var dist2 = dx * dx + dy * dy;
						if (dist2 < 0.0004) dist2 = 0.0004;
						var dist = Math.sqrt(dist2);
						var force = (k * k) / dist; // 库仑斥力
						var fx = (dx / dist) * force;
						var fy = (dy / dist) * force;
						vel[i].x += fx;
						vel[i].y += fy;
						vel[j].x -= fx;
						vel[j].y -= fy;
					}
				}
				// 引力（边 → 弹簧）
				for (var e = 0; e < n; e++) {
					for (var a = 0; a < adj[e].length; a++) {
						var f = adj[e][a];
						if (f <= e) continue; // 每条边一次
						var ex = pos[f].x - pos[e].x;
						var ey = pos[f].y - pos[e].y;
						var ed = Math.sqrt(ex * ex + ey * ey) || 0.0001;
						var spring = (ed - k) * 0.06;
						var exf = (ex / ed) * spring;
						var eyf = (ey / ed) * spring;
						vel[e].x += exf;
						vel[e].y += eyf;
						vel[f].x -= exf;
						vel[f].y -= eyf;
					}
				}
				// 中心引力 + 阻尼 + 更新
				for (var c = 0; c < n; c++) {
					vel[c].x += (0.5 - pos[c].x) * 0.02;
					vel[c].y += (0.5 - pos[c].y) * 0.02;
					vel[c].x *= 0.82;
					vel[c].y *= 0.82;
					pos[c].x += vel[c].x;
					pos[c].y += vel[c].y;
				}
			}
			// 归一化到 [0.08, 0.92]
			var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
			for (var m = 0; m < n; m++) {
				if (pos[m].x < minX) minX = pos[m].x;
				if (pos[m].x > maxX) maxX = pos[m].x;
				if (pos[m].y < minY) minY = pos[m].y;
				if (pos[m].y > maxY) maxY = pos[m].y;
			}
			var spanX = Math.max(0.001, maxX - minX);
			var spanY = Math.max(0.001, maxY - minY);
			return pos.map(function (p) {
				return {
					x: 0.08 + ((p.x - minX) / spanX) * 0.84,
					y: 0.08 + ((p.y - minY) / spanY) * 0.84,
				};
			});
		}

		/**
		 * 知识图谱组件：拉取 /plugins/kb/graph，力导向布局，SVG 渲染。
		 * 支持：滚轮缩放、拖拽平移、节点悬停高亮相邻边、点击节点打开文件。
		 */
		function KbGraph(props) {
			var onOpen = props.onOpen;
			var state = react.useState({
				loading: true,
				error: null,
				nodes: [],
				links: [],
				layout: [],
				degree: [],
				hover: null,
				view: { x: 0, y: 0, k: 1 },
				drag: null,
			});
			var s = state[0];
			var set = state[1];
			var patch = function (p) { set(function (prev) { return Object.assign({}, prev, p); }); };
			var svgRef = react.useRef(null);
			var dragRef = react.useRef(null);

			react.useEffect(function () {
				api("/plugins/kb/graph")
					.then(function (j) {
						var nodes = j.nodes || [];
						var links = j.links || [];
						var layout = forceLayout(nodes, links, 220);
						// 计算度数
						var deg = new Array(nodes.length).fill(0);
						for (var i = 0; i < links.length; i++) {
							var si = nodes.findIndex(function (x) { return x.id === links[i].source; });
							var ti = nodes.findIndex(function (x) { return x.id === links[i].target; });
							if (si >= 0) deg[si]++;
							if (ti >= 0) deg[ti]++;
						}
						patch({ loading: false, nodes: nodes, links: links, layout: layout, degree: deg });
					})
					.catch(function (err) {
						patch({ loading: false, error: String((err && err.message) || err) });
					});
			}, []);

			function svgPoint(e) {
				var rect = svgRef.current ? svgRef.current.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
				return {
					x: e.clientX - rect.left,
					y: e.clientY - rect.top,
				};
			}

			function onWheel(e) {
				e.preventDefault();
				var rect = svgRef.current ? svgRef.current.getBoundingClientRect() : { left: 0, top: 0, width: 600, height: 540 };
				var px = e.clientX - rect.left;
				var py = e.clientY - rect.top;
				var factor = e.deltaY < 0 ? 1.12 : 0.89;
				var k2 = Math.min(4, Math.max(0.35, s.view.k * factor));
				// 以鼠标位置为锚点缩放
				var nx = px - (px - s.view.x) * (k2 / s.view.k);
				var ny = py - (py - s.view.y) * (k2 / s.view.k);
				patch({ view: { x: nx, y: ny, k: k2 } });
			}

			function onMouseDown(e) {
				if (e.button !== 0) return;
				var p = svgPoint(e);
				dragRef.current = { startX: p.x, startY: p.y, viewX: s.view.x, viewY: s.view.y, moved: false };
				e.preventDefault();
			}
			function onMouseMove(e) {
				if (dragRef.current) {
					var p = svgPoint(e);
					var dx = p.x - dragRef.current.startX;
					var dy = p.y - dragRef.current.startY;
					if (Math.abs(dx) + Math.abs(dy) > 3) dragRef.current.moved = true;
					patch({ view: { x: dragRef.current.viewX + dx, y: dragRef.current.viewY + dy, k: s.view.k } });
				}
			}
			function onMouseUp() {
				dragRef.current = null;
			}

			function nodeRadius(degree) {
				return 6 + Math.min(10, degree * 1.6);
			}

			if (s.loading) {
				return react.createElement(
					"div",
					{ className: "kb-graph-wrap" },
					react.createElement(
						"div",
						{ className: "kb-loading" },
						react.createElement("span", { className: "kb-spin" }),
						"正在构建知识图谱…"
					)
				);
			}
			if (s.error) {
				return react.createElement("div", { className: "kb-error" }, "图谱加载失败：" + s.error);
			}
			if (s.nodes.length === 0) {
				return react.createElement("div", { className: "kb-graph-wrap" }, react.createElement("div", { className: "kb-empty" }, "暂无知识节点"));
			}

			var W = 900, H = 540;
			var view = s.view;
			var linksById = {};
			for (var li = 0; li < s.links.length; li++) {
				var lk = s.links[li];
				linksById[lk.source + "→" + lk.target] = lk;
				linksById[lk.target + "→" + lk.source] = lk;
			}

			var linkEls = s.links.map(function (lk, idx) {
				var si = s.nodes.findIndex(function (x) { return x.id === lk.source; });
				var ti = s.nodes.findIndex(function (x) { return x.id === lk.target; });
				if (si === -1 || ti === -1) return null;
				var a = s.layout[si];
				var b = s.layout[ti];
				var hot = s.hover !== null && (s.hover === lk.source || s.hover === lk.target);
				return react.createElement("line", {
					key: "l" + idx,
					className: "kb-graph-link" + (hot ? " hot" : ""),
					x1: a.x * W,
					y1: a.y * H,
					x2: b.x * W,
					y2: b.y * H,
				});
			});

			var nodeEls = s.nodes.map(function (nd, idx) {
				var p = s.layout[idx];
				var r = nodeRadius(s.degree[idx]);
				var color = graphColor(nd.section);
				var isHover = s.hover === nd.id;
				var title = nd.title || nd.path;
				var labelLen = title.length;
				var fontSize = 11;
				return react.createElement(
					"g",
					{
						key: nd.id,
						className: "kb-graph-node",
						transform: "translate(" + p.x * W + "," + p.y * H + ")",
						onClick: function () { onOpen(nd.path, title); },
						onMouseEnter: function () { patch({ hover: nd.id }); },
						onMouseLeave: function () { patch({ hover: null }); },
					},
					react.createElement("circle", {
						r: isHover ? r + 2 : r,
						fill: color,
						opacity: isHover ? 1 : 0.88,
					}),
					react.createElement(
						"text",
						{
							dy: r + 13,
							textAnchor: "middle",
							className: isHover ? "kb-node-title" : "",
						},
						labelLen > 14 ? title.slice(0, 13) + "…" : title
					)
				);
			});

			var legend = Object.keys(GRAPH_COLORS).map(function (sec) {
				return react.createElement(
					"span",
					{ key: sec, className: "kb-legend-item" },
					react.createElement("span", { className: "kb-legend-dot", style: { background: GRAPH_COLORS[sec] } }),
					sec
				);
			});

			return react.createElement(
				"div",
				{ className: "kb-graph-wrap" },
				react.createElement(
					"div",
					{ className: "kb-graph-toolbar" },
					react.createElement("span", { className: "kb-card-title", style: { margin: 0 } }, "知识关系图谱"),
					react.createElement("div", { className: "kb-graph-legend" }, legend),
					react.createElement("span", { className: "kb-graph-hint" }, "滚轮缩放 · 拖拽平移 · 点击节点查看 · 悬停高亮关联")
				),
				react.createElement(
					"svg",
					{
						ref: svgRef,
						className: "kb-graph-svg",
						viewBox: "0 0 " + W + " " + H,
						width: "100%",
						height: H,
						onWheel: onWheel,
						onMouseDown: onMouseDown,
						onMouseMove: onMouseMove,
						onMouseUp: onMouseUp,
						onMouseLeave: onMouseUp,
					},
					react.createElement(
						"g",
						{ transform: "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")" },
						linkEls,
						nodeEls
					)
				)
			);
		}

		/** 知识中心主组件。 */
		function KbView(props) {
			var state = react.useState({
				loading: true,
				error: null,
				sections: null,
				section: "knowledge",
				filePath: null,
				fileName: null,
				content: null,
				contentLoading: false,
				search: "",
				results: null,
				searching: false,
				diary: null,      // 记忆日记列表（memory 分区专用）
				diaryLoading: false,
				wsTree: null,     // 工作区全部文件树（并入知识库分区）
				wsTreeLoading: false,
				expandedPaths: {}, // 目录展开状态
			});
			var s = state[0];
			var set = state[1];
			// 函数式更新：基于最新 state 合并，避免多个异步回调互相覆盖（React 闭包陷阱）
			var patch = function (p) { set(function (prev) { return Object.assign({}, prev, p); }); };
			var latest = s;

			react.useEffect(function () {
				api("/plugins/kb/tree")
					.then(function (j) {
						KB_TREE_CACHE = j;
						patch({ loading: false, sections: j.sections });
					})
					.catch(function (err) {
						patch({ loading: false, error: String((err && err.message) || err) });
					});
				// 并行加载工作区树（并入知识库分区展示）
				api("/plugins/kb/workspace")
					.then(function (j) {
						patch({ wsTreeLoading: false, wsTree: j.tree || [] });
					})
					.catch(function () {
						patch({ wsTreeLoading: false, wsTree: [] });
					});
			}, []);

			// 加载记忆日记列表（切换到 memory 分区时调用）
			function loadDiary() {
				if (s.diary) return;
				patch({ diaryLoading: true });
				api("/plugins/kb/diary")
					.then(function (j) {
						patch({ diaryLoading: false, diary: j.entries || [] });
					})
					.catch(function (err) {
						patch({ diaryLoading: false, diary: [], error: String((err && err.message) || err) });
					});
			}

			// 打开文件（带路径容错：若返回 404，尝试补分区前缀 / 去掉前缀重试）
			// 注意：不清空旧 content，新内容加载完成后无缝替换，避免内容区闪空白
			function openFile(filePath, fileName) {
				var target = filePath;
				if (s.filePath === target && !s.contentLoading) return; // 重复点击同一文件忽略
				patch({ filePath: filePath, fileName: fileName, contentLoading: true });
				var tryRead = function (p) {
					api("/plugins/kb/file?path=" + encodeURIComponent(p))
						.then(function (j) {
							patch({
								contentLoading: false,
								content: j.content || "",
								filePath: p,
								fileName: fileName || p,
							});
						})
						.catch(function (err) {
							// 容错：缺分区前缀时补上；多分区前缀时去掉再试一次
							var fixed = null;
							var slashIdx = p.indexOf("/");
							if (slashIdx === -1) {
								// 缺前缀：尝试常见分区
								var tries = ["knowledge", "skills", "memory", "tasks"];
								for (var i = 0; i < tries.length; i++) {
									var cand = tries[i] + "/" + p;
									if (cand !== p) { fixed = cand; break; }
								}
							} else {
								// 多前缀：去掉第一段
								fixed = p.slice(slashIdx + 1);
							}
							if (fixed && fixed !== p) {
								tryRead(fixed);
								return;
							}
							patch({
								contentLoading: false,
								content: "# 读取失败\n\n文件：" + p + "\n\n错误：" + String((err && err.message) || err) +
									"\n\n> 如果持续出现，请在会话中告诉我，我会检查文件路径。",
							});
						});
				};
				tryRead(target);
			}

			// 搜索
			function doSearch(q) {
				var query = (q || "").trim();
				if (!query) {
					patch({ search: "", results: null, searching: false });
					return;
				}
				patch({ search: query, searching: true, results: null });
				api("/plugins/kb/search?q=" + encodeURIComponent(query))
					.then(function (j) {
						patch({ searching: false, results: j.results || [] });
					})
					.catch(function (err) {
						patch({ searching: false, results: [], error: String((err && err.message) || err) });
					});
			}

			if (s.loading) {
				return react.createElement(
					"div",
					{ className: "kb-view" },
					react.createElement("style", null, STYLE),
					react.createElement(
						"div",
						{ className: "kb-container kb-loading" },
						react.createElement("span", { className: "kb-spin" }),
						"正在加载知识中心…"
					)
				);
			}

			var navItems = SECTIONS.map(function (sec) {
				var active = s.section === sec.key && !s.search;
				return react.createElement(
					"div",
					{
						key: sec.key,
						className: "kb-nav-item" + (active ? " active" : ""),
						onClick: function () { patch({ section: sec.key, search: "", results: null }); },
					},
					react.createElement("span", { className: "kb-nav-icon" }, sec.label.slice(0, 1)),
					react.createElement(
						"span",
						null,
						react.createElement("span", { className: "kb-nav-label" }, sec.label),
						react.createElement("span", { className: "kb-nav-desc" }, sec.desc)
					)
				);
			});
			// 图谱导航项（独立入口）
			navItems.push(react.createElement(
				"div",
				{
					key: "graph",
					className: "kb-nav-item" + (s.section === "graph" ? " active" : ""),
					onClick: function () { patch({ section: "graph", search: "", results: null }); },
				},
				react.createElement("span", { className: "kb-nav-icon" }, "图"),
				react.createElement(
					"span",
					null,
					react.createElement("span", { className: "kb-nav-label" }, "图谱"),
					react.createElement("span", { className: "kb-nav-desc" }, "知识关系网")
				)
			));

			var mainBody;
			if (s.section === "graph" && !s.search) {
				// 图谱模式：主区渲染关系图谱，内容区显示选中节点详情（无选中时显示提示）
				mainBody = react.createElement(
					"div",
					{ className: "kb-card" },
					react.createElement(KbGraph, { onOpen: openFile })
				);
			} else if (s.section === "memory" && !s.search) {
				// 记忆模式：按日期一列（AutoBox 风格）
				if (!s.diary && !s.diaryLoading) loadDiary();
				var diaryBody;
				if (s.diaryLoading) {
					diaryBody = react.createElement(
						"div",
						{ className: "kb-loading" },
						react.createElement("span", { className: "kb-spin" }),
						"加载记忆日记…"
					);
				} else if (!s.diary || s.diary.length === 0) {
					diaryBody = react.createElement("div", { className: "kb-empty" }, "暂无记忆日记");
				} else {
					// 按月份分组
					var months = [];
					var monthMap = {};
					s.diary.forEach(function (e) {
						var m = e.date.slice(0, 7);
						if (!monthMap[m]) {
							monthMap[m] = { month: m, days: [] };
							months.push(monthMap[m]);
						}
						monthMap[m].days.push(e);
					});
					var today = new Date();
					var todayStr = today.getFullYear() + "-" +
						String(today.getMonth() + 1).padStart(2, "0") + "-" +
						String(today.getDate()).padStart(2, "0");
					diaryBody = react.createElement(
						"div",
						{ className: "kb-diary" },
						months.map(function (grp) {
							return react.createElement(
								react.Fragment,
								{ key: grp.month },
								react.createElement("div", { className: "kb-diary-month" }, grp.month.replace("-", " 年 ") + " 月"),
								grp.days.map(function (e) {
									var weekday = "";
									try {
										var d = new Date(e.date + "T00:00:00");
										weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
									} catch (err) { /* 忽略 */ }
									var isToday = e.date === todayStr;
									return react.createElement(
										"div",
										{
											key: e.date,
											className: "kb-diary-day" + (s.filePath === e.path ? " active" : ""),
											onClick: function () { openFile(e.path, e.name); },
										},
										react.createElement(
											"div",
											{ className: "kb-diary-date" },
											e.date.slice(5).replace("-", " 月 ") + " 日",
											react.createElement("small", null, e.date.slice(0, 4) + " " + weekday)
										),
										react.createElement("div", { className: "kb-diary-summary" }, e.summary),
										isToday ? react.createElement("span", { className: "kb-diary-badge" }, "今天") : null
									);
								})
							);
						})
					);
				}
				mainBody = react.createElement(
					"div",
					{ className: "kb-card" },
					react.createElement("p", { className: "kb-card-title" }, "记忆 · 按日总结（点击某天查看详情）"),
					diaryBody
				);
			} else if (s.search) {
				// 搜索结果
				var searchContent;
				if (s.searching) {
					searchContent = react.createElement(
						"div",
						{ className: "kb-loading" },
						react.createElement("span", { className: "kb-spin" }),
						"搜索中…"
					);
				} else if (s.results && s.results.length > 0) {
					searchContent = react.createElement(
						"div",
						{ className: "kb-search-res" },
						s.results.map(function (r) {
							return react.createElement(
								"div",
								{
									key: r.path,
									className: "kb-search-item",
									onClick: function () { openFile(r.path, r.name); },
								},
								react.createElement("span", { className: "sec" }, (SECTIONS.find(function (x) { return x.key === r.section; }) || {}).label || r.section),
								react.createElement("div", { className: "nm" }, r.name),
								react.createElement("div", { className: "sn" }, r.snippet || "（命中文件名）")
							);
						})
					);
				} else {
					searchContent = react.createElement("div", { className: "kb-empty" }, "未找到匹配内容");
				}
				mainBody = react.createElement(
					"div",
					{ className: "kb-card" },
					react.createElement("p", { className: "kb-card-title" }, "搜索结果：" + s.search),
					searchContent
				);
			} else {
				// 分区内容：文件树
				var secMeta = SECTIONS.find(function (x) { return x.key === s.section; }) || {};
				var treeContent;
				if (s.section === "knowledge") {
					// 知识库分区：显示整个工作区的文件树（平时创建的文件都在这里）
					if (s.wsTreeLoading) {
						treeContent = react.createElement(
							"div",
							{ className: "kb-loading" },
							react.createElement("span", { className: "kb-spin" }),
							"加载文件树…"
						);
					} else if (!s.wsTree || s.wsTree.length === 0) {
						treeContent = react.createElement("div", { className: "kb-empty" }, "暂无文件");
					} else {
						treeContent = react.createElement(
							"div",
							{ className: "kb-tree" },
							react.createElement(TreeRecursive, {
								entries: s.wsTree,
								activePath: s.filePath,
								onPick: openFile,
								expandedPaths: s.expandedPaths,
								onToggleDir: function (p) {
									set(function (prev) {
										var next = Object.assign({}, prev.expandedPaths);
										if (next[p]) delete next[p];
										else next[p] = true;
										return Object.assign({}, prev, { expandedPaths: next });
									});
								},
							})
						);
					}
				} else {
					// 技能 / 记忆 / 任务分区：显示各自目录
					var secData = (s.sections && s.sections[s.section]) || { exists: false, tree: [] };
					if (!secData.exists) {
						treeContent = react.createElement("div", { className: "kb-empty" }, "该分区目录不存在");
					} else if (secData.tree.length === 0) {
						treeContent = react.createElement("div", { className: "kb-empty" }, "暂无内容");
					} else {
						treeContent = react.createElement(
							"div",
							{ className: "kb-tree" },
							react.createElement(TreeRecursive, {
								entries: secData.tree,
								activePath: s.filePath,
								onPick: openFile,
							})
						);
					}
				}
				mainBody = react.createElement(
					"div",
					{ className: "kb-card" },
					react.createElement("p", { className: "kb-card-title" }, secMeta.label + " · " + (secMeta.desc || "")),
					treeContent
				);
			}

			var contentPane;
			if (s.search) {
				contentPane = null;
			} else if (s.contentLoading && s.content === null) {
				// 仅在没有任何旧内容时才显示加载中（首次打开时）
				contentPane = react.createElement(
					"div",
					{ className: "kb-loading" },
					react.createElement("span", { className: "kb-spin" }),
					"加载文件…"
				);
			} else if (s.content !== null) {
				contentPane = react.createElement(
					"div",
					{ className: "kb-content kb-fade-in", key: s.filePath },
					react.createElement("div", {
						dangerouslySetInnerHTML: { __html: renderMarkdown(s.content) },
					})
				);
			} else {
				var emptyHint = s.section === "graph"
					? "点击图谱中的节点查看文件内容"
					: s.section === "memory"
						? "点击某一天查看当天的总结内容"
						: s.section === "knowledge"
							? "点击左侧目录展开，再点文件查看内容"
							: "从左侧选择文件查看内容";
				contentPane = react.createElement(
					"div",
					{ className: "kb-empty", style: { border: "1px solid #e2e8f0", borderRadius: 14, background: "var(--card-bg-color,#fff)" } },
					emptyHint
				);
			}

			return react.createElement(
				"div",
				{ className: "kb-view" },
				react.createElement("style", null, STYLE),
				react.createElement(
					"div",
					{ className: "kb-container" },
					react.createElement(
						"div",
						{ className: "kb-header" },
						react.createElement("h2", { className: "kb-title" }, "知识中心"),
						react.createElement("p", { className: "kb-desc" }, "知识库 / 图谱 / 技能 / 记忆 / 任务"),
					),
					react.createElement(
						"div",
						{ className: "kb-search" },
						react.createElement("input", {
							placeholder: "搜索全部知识库内容…",
							value: s.search,
							onChange: function (e) { doSearch(e.target.value); },
						})
					),
					s.error && !s.search
						? react.createElement("div", { className: "kb-error", style: { marginTop: 12 } }, "加载失败：" + s.error)
						: null,
					react.createElement(
						"div",
						{ className: "kb-body", style: { marginTop: 16 } },
						react.createElement("div", { className: "kb-nav" }, navItems),
						react.createElement(
							"div",
							{ className: "kb-main" },
							react.createElement(
								"div",
								{ className: "kb-fade-in", key: s.section + (s.search ? "|s" : ""), style: { display: "contents" } },
								mainBody
							),
							contentPane
						)
					)
				)
			);
		}

		// ── 插件主体 ──────────────────────────────────────────────────────────

		function apply(ctx) {
			ctx.slots.inject("conversation.view", function () {
				return ctx.slots.register({
					name: "conversation.view",
					id: "kb",
					order: 20,
					label: () => "知识库",
				}, KbView);
			});
		}

		exports.name = name;
		exports.inject = inject;
		exports.description = description;
		exports.apply = apply;
		return module.exports;
	}
});
