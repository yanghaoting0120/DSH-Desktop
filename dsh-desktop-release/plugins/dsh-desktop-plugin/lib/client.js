/**
 * dsh-desktop — 客户端（浏览器）半区。
 *
 * 1. 在设置页 General 区注册一张「桌面版」状态卡片：
 *    - 桌面版（Electron）中：显示运行模式 / 服务器地址 / 工作目录 / 版本信息，
 *      数据来自桌面应用 preload 注入的 window.dshDesktop 桥；
 *    - 浏览器中：如实显示「浏览器模式」，并列出插件提供的桌面工具。
 * 2. 在会话标题栏 action 区（导出按钮右侧）挂载「字号」滑块（80%–140%）与主题切换按钮：
 *    - 缩放作用于 document.body，与导出按钮同处标题栏，位置自然；
 *    - 选择保存在 localStorage（dsh-desktop.fontScale），刷新/重启后保持；
 *    - 滑块变更经 POST /plugins/desktop/font-scale 同步到 host，
 *      AI 调用 desktop_set_font_scale 改字号时经 SSE /plugins/desktop/events
 *      推回界面，双向一致。
 *
 * 注意：本文件是浏览器端 bundle，采用 DSH 客户端模块系统的 factory 格式
 * （window.__ModuleLoader__.load），由 dsh-client-modules 经
 * exports["./client"] 发现并以 /plugins/dsh-desktop/client.js 提供。
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── 插件元数据 ────────────────────────────────────────────────────────

		var name = "desktop-client";
		var inject = ["slots"];
		var description = "桌面版状态卡片 + 会话标题栏字号调节（导出按钮右侧滑块，80%–140%）与主题切换。";

		// ── 数据读取 ──────────────────────────────────────────────────────────

		/** 读取桌面版状态；浏览器中返回 present:false。 */
		function readDesktopStatus() {
			var bridge = window.dshDesktop;
			if (bridge && typeof bridge.getStatus === "function") {
				return bridge
					.getStatus()
					.then(function (s) {
						return Object.assign({}, s, { present: true });
					})
					.catch(function (err) {
						return { present: true, error: String((err && err.message) || err) };
					});
			}
			return Promise.resolve({ present: false });
		}

		// ── 界面字号调节 ───────────────────────────────────────────────────────

		/** localStorage 键：界面字号系数。 */
		var FONT_SCALE_KEY = "dsh-desktop.fontScale";
		/** 字号范围：0.8 = 缩小 20%，1.4 = 放大 40%。 */
		var FONT_SCALE_MIN = 0.8;
		var FONT_SCALE_MAX = 1.4;

		/** 钳制字号系数到合法范围。 */
		function clampScale(value) {
			return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
		}

		/** 读取持久化的字号系数；无记录或损坏时返回 1（默认）。 */
		function loadScale() {
			try {
				var raw = parseFloat(window.localStorage.getItem(FONT_SCALE_KEY));
				if (Number.isFinite(raw)) return clampScale(raw);
			} catch (err) {
				/* localStorage 不可用时忽略 */
			}
			return 1;
		}

		/** 持久化字号系数。 */
		function saveScale(scale) {
			try {
				window.localStorage.setItem(FONT_SCALE_KEY, String(scale));
			} catch (err) {
				/* 忽略 */
			}
		}

		/**
		 * 应用字号：缩放 document.body（整个应用界面随之缩放）。
		 * 注意：字号控件本身挂在 documentElement（html）上、位于 body 之外，
		 * 因此控件不随缩放变化——拖动滑块时它的位置和大小始终保持不变。
		 */
		function applyZoom(scale) {
			var target = document.body || document.documentElement;
			target.style.zoom = String(scale);
		}

		// host→client 推送：与 host 面 /plugins/desktop/events（SSE）对接，
		// 使 AI 经 desktop_set_font_scale 工具改字号时，界面立即生效。
		var fontScaleListeners = new Set();
		var fontScaleSource = null;
		function ensureFontScaleBus() {
			if (fontScaleSource !== null) return;
			try {
				fontScaleSource = new EventSource("/plugins/desktop/events");
				fontScaleSource.addEventListener("message", function (event) {
					var frame;
					try {
						frame = JSON.parse(event.data);
					} catch (err) {
						return;
					}
					if (frame && frame.type === "font-scale" && typeof frame.scale === "number") {
						var s = clampScale(frame.scale);
						fontScaleListeners.forEach(function (fn) {
							try {
								fn(s);
							} catch (err) {
								/* 单个监听器异常不影响其他监听器 */
							}
						});
					}
				});
				// EventSource 断线自动重连，无需手动处理。
			} catch (err) {
				fontScaleSource = null;
			}
		}
		/** 订阅字号变更；返回取消订阅函数。 */
		function subscribeFontScale(fn) {
			ensureFontScaleBus();
			fontScaleListeners.add(fn);
			return function () {
				fontScaleListeners.delete(fn);
				if (fontScaleListeners.size === 0 && fontScaleSource !== null) {
					try {
						fontScaleSource.close();
					} catch (err) {
						/* 忽略 */
					}
					fontScaleSource = null;
				}
			};
		}

		// client→host 上报：滑块拖动时把字号同步到 host（防抖），
		// 这样 desktop_status / desktop_set_font_scale 读到的是真实值，多标签页也一致。
		var hostNotifyTimer = null;
		function notifyHostScale(scale) {
			try {
				if (hostNotifyTimer !== null) clearTimeout(hostNotifyTimer);
				hostNotifyTimer = setTimeout(function () {
					hostNotifyTimer = null;
					fetch("/plugins/desktop/font-scale", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ scale: scale }),
					}).catch(function () {
						/* host 未就绪时静默忽略（localStorage 已保存，重连后以 host 值为准） */
					});
				}, 150);
			} catch (err) {
				/* 忽略 */
			}
		}

		// ── 轻量 toast（右下角短暂提示） ───────────────────────────────────────

		var toastTimer = null;
		function showToast(text) {
			try {
				var el = document.getElementById("dsh-desktop-toast");
				if (!el) {
					el = document.createElement("div");
					el.id = "dsh-desktop-toast";
					el.style.cssText = [
						"position:fixed",
						"right:16px",
						"bottom:104px",
						"z-index:2147483001",
						"max-width:420px",
						"font:12px/1.6 ui-sans-serif,system-ui,sans-serif",
						"color:#e6e9ef",
						"background:rgba(20,24,33,0.92)",
						"padding:6px 12px",
						"border-radius:10px",
						"border:1px solid rgba(127,127,127,0.35)",
						"box-shadow:0 2px 10px rgba(0,0,0,0.35)",
						"word-break:break-all",
						"pointer-events:none",
						"opacity:0",
						"transition:opacity 0.15s",
					].join(";");
					(document.documentElement || document.body).appendChild(el);
				}
				el.textContent = text;
				el.style.opacity = "1";
				if (toastTimer !== null) clearTimeout(toastTimer);
				toastTimer = setTimeout(function () {
					toastTimer = null;
					el.style.opacity = "0";
				}, 5000);
			} catch (err) {
				/* 忽略 */
			}
		}

		// ── 拖拽文件进窗口 ─────────────────────────────────────────────────────

		/** 把文件放入工作区（桌面模式走本地路径复制，浏览器模式走 base64）。 */
		function postDroppedFile(payload) {
			fetch("/plugins/desktop/drop-file", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			})
				.then(function (res) {
					return res.json().catch(function () {
						return { ok: false, error: "响应解析失败" };
					});
				})
				.then(function (data) {
					if (data && data.ok && data.name) {
						showToast("📥 文件已放入工作区：" + data.name);
					} else {
						showToast("拖入文件失败：" + String((data && data.error) || "未知错误").slice(0, 50));
					}
				})
				.catch(function () {
					showToast("拖入文件失败：无法连接本机服务");
				});
		}

		/**
		 * 注册全局拖拽：把文件拖到窗口空白处（非输入框区域）→ 放入工作区。
		 * 输入框区域内不拦截，交还给 composer 自身的图片附件/文本拖放逻辑。
		 */
		function mountFileDrop() {
			if (window.__dshDesktopDropInstalled) return;
			window.__dshDesktopDropInstalled = true;

			window.addEventListener("dragover", function (e) {
				var has = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf("Files") >= 0;
				if (has) e.preventDefault();
			});

			window.addEventListener("drop", function (e) {
				var files = e.dataTransfer && e.dataTransfer.files;
				if (!files || files.length === 0) return;
				var target = e.target;
				if (target && typeof target.closest === "function") {
					var inComposer = target.closest("textarea, [contenteditable='true'], [data-slot*='composer']");
					if (inComposer) return; // 输入框区域交给 composer 自己处理
				}
				e.preventDefault();
				e.stopPropagation();
				var file = files[0];
				var bridge = window.dshDesktop;
				if (bridge && typeof bridge.getPathForFile === "function") {
					var realPath = bridge.getPathForFile(file);
					if (realPath) {
						postDroppedFile({ path: realPath, name: file.name });
						return;
					}
				}
				// 浏览器模式：读内容为 base64 上传
				try {
					var reader = new FileReader();
					reader.onload = function () {
						var dataUrl = String(reader.result || "");
						var comma = dataUrl.indexOf(",");
						postDroppedFile({ name: file.name, base64: comma >= 0 ? dataUrl.slice(comma + 1) : "" });
					};
					reader.onerror = function () {
						showToast("读取文件失败");
					};
					reader.readAsDataURL(file);
				} catch (err) {
					showToast("读取文件失败");
				}
			});
		}

		// ── 样式 ──────────────────────────────────────────────────────────────

		var css = {
			box: {
				width: "100%",
				boxSizing: "border-box",
				border: "1px solid rgba(127,127,127,0.35)",
				borderRadius: "10px",
				background: "rgba(127,127,127,0.08)",
				padding: "10px 12px",
				fontSize: "13px",
				lineHeight: "1.55",
				color: "inherit",
			},
			head: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" },
			dot: { width: "9px", height: "9px", borderRadius: "50%", flex: "0 0 auto" },
			title: { fontWeight: 600, fontSize: "13.5px" },
			badge: {
				marginLeft: "auto",
				fontSize: "11px",
				padding: "1px 8px",
				borderRadius: "999px",
				border: "1px solid rgba(127,127,127,0.4)",
				background: "rgba(127,127,127,0.1)",
			},
			grid: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px" },
			key: { opacity: "0.62", whiteSpace: "nowrap" },
			val: { wordBreak: "break-all", fontFamily: "ui-monospace, Consolas, monospace", fontSize: "12px" },
			tools: { marginTop: "8px", paddingTop: "8px", borderTop: "1px solid rgba(127,127,127,0.25)", opacity: "0.85" },
			btn: {
				marginTop: "8px",
				fontSize: "12px",
				padding: "3px 12px",
				borderRadius: "999px",
				border: "1px solid rgba(127,127,127,0.45)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
			},
			err: { color: "#e5484d", marginTop: "6px", fontSize: "12px" },
		};

		// ── 卡片组件 ──────────────────────────────────────────────────────────

		/**
		 * 桌面版状态卡片（注册进 settings.general.item 槽）。
		 */
		function DesktopStatusCard() {
			var useState = react.useState;
			var useEffect = react.useEffect;
			var useCallback = react.useCallback;
			var state = useState(null);
			var status = state[0];
			var setStatus = state[1];
			var errState = useState(null);
			var error = errState[0];
			var setError = errState[1];

			var refresh = useCallback(function () {
				setError(null);
				readDesktopStatus().then(setStatus).catch(function (e) {
					setError(String((e && e.message) || e));
				});
			}, []);

			useEffect(function () {
				refresh();
			}, [refresh]);

			var mode = status ? (status.present ? (status.mode === "desktop" ? "desktop" : "browser") : "browser") : null;
			var isDesktop = mode === "desktop";
			var dotColor = isDesktop ? "#38b56b" : "#8a8f98";

			function Row(props) {
				return react.createElement("div", { style: { display: "contents" } },
					react.createElement("div", { style: css.key }, props.k),
					react.createElement("div", { style: css.val }, props.v)
				);
			}

			return react.createElement("div", { style: css.box },
				// 标题行
				react.createElement("div", { style: css.head },
					react.createElement("span", { style: Object.assign({}, css.dot, { background: dotColor }) }),
					react.createElement("span", { style: css.title }, "桌面版状态"),
					react.createElement("span", { style: css.badge },
						status === null ? "读取中…" : isDesktop ? "桌面版运行中" : "浏览器模式"
					)
				),

				// 状态网格
				status === null
					? react.createElement("div", { style: { opacity: "0.6" } }, "正在读取桌面环境信息…")
					: react.createElement("div", { style: css.grid },
						react.createElement(Row, { k: "运行模式", v: isDesktop ? "桌面版（Electron）" : "浏览器（非桌面版）" }),
						react.createElement(Row, { k: "平台", v: status.platform || "—" }),
						react.createElement(Row, { k: "服务器地址", v: status.serverUrl || "—" }),
						react.createElement(Row, { k: "工作目录", v: status.workspace || "—" }),
						react.createElement(Row, { k: "版本", v: status.versions
							? "应用 " + (status.versions.app || "?") + " · Electron " + (status.versions.electron || "?") + " · Node " + (status.versions.node || "?")
							: "—" })
					),

				// 插件工具说明
				react.createElement("div", { style: css.tools },
					"已启用桌面工具：desktop_open（打开文件/文件夹/网址）· desktop_notify（桌面通知）· desktop_status（环境查询）· desktop_set_font_scale（字号调节）"
				),

				// 刷新按钮 + 错误
				react.createElement("button", { type: "button", style: css.btn, onClick: refresh }, "刷新"),
				error !== null && react.createElement("div", { style: css.err }, "读取失败：" + error)
			);
		}

		/** 把会话节点序列化为 Markdown（用户/助手/工具结果等）。 */
		function serializeConversation(nodes) {
			var lines = ["# 会话导出", "", `> 导出时间：${new Date().toLocaleString()}`, ""];
			function contentText(content) {
				var parts = [];
				for (var i = 0; i < content.length; i++) {
					var b = content[i];
					if (b && (b.type === "text" || b.kind === "text") && typeof b.text === "string") parts.push(b.text);
					else if (b && b.type === "image") parts.push("[图片]");
					else if (b && b.kind === "image") parts.push("[图片]");
				}
				return parts.join("\n");
			}
			for (var i = 0; i < (nodes || []).length; i++) {
				var n = nodes[i];
				if (!n) continue;
				if (n.kind === "user") {
					lines.push("## 🧑 用户", "", contentText(n.content) || "_（空）_", "");
				} else if (n.kind === "steering" || n.kind === "context") {
					lines.push("## 📌 " + (n.kind === "context" && n.provenance && n.provenance.label ? n.provenance.label : "系统"), "", contentText(n.content), "");
				} else if (n.kind === "assistant") {
					var parts = [];
					for (var j = 0; j < (n.blocks || []).length; j++) {
						var b = n.blocks[j];
						if (b.kind === "text") parts.push(b.text);
						else if (b.kind === "reasoning") parts.push("> 💭 " + b.text.replace(/\n/g, "\n> "));
						else if (b.kind === "image") parts.push("[图片]");
						else if (b.kind === "tool-call") parts.push(`[工具调用：${b.name}]`);
					}
					lines.push("## 🤖 助手", "", parts.join("\n\n") || "_（空）_", "");
				} else if (n.kind === "tool-result") {
					var toolName = n.call ? n.call.name : n.callId;
					lines.push("## 🛠️ 工具结果：" + toolName, "", "```json", safeJson(n.content), "```", "");
				} else if (n.kind === "command") {
					lines.push("## ⌨️ 命令：" + (n.name || "?"), "", "```", (n.args || "") + (n.outcome && n.outcome.text ? "\n" + n.outcome.text : ""), "```", "");
				}
			}
			return lines.join("\n");
		}
		function safeJson(content) {
			try {
				var parts = [];
				for (var i = 0; i < (content || []).length; i++) {
					var b = content[i];
					if (b && b.type === "text") parts.push(b.text);
				}
				return parts.join("\n") || "（无文本内容）";
			} catch (err) {
				return "（无法序列化）";
			}
		}

		/**
		 * 导出按钮（注册进会话标题栏 action 区）。
		 * 桌面版：弹系统保存对话框写 .md；浏览器模式：Blob 下载。
		 */
		function ExportButton(props) {
			var useState = react.useState;
			var nodes = typeof props.useSession === "function"
				? props.useSession(function (s) { return s ? s.nodes : []; })
				: [];
			var doneState = useState(false);
			var done = doneState[0];
			var setDone = doneState[1];
			var timerRef = react.useRef(null);

			function doExport() {
				var md = serializeConversation(nodes);
				var stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				var name = "dsh-export-" + stamp + ".md";
				var bridge = window.dshDesktop;
				if (bridge && typeof bridge.saveFile === "function") {
					bridge.saveFile({ defaultName: name, content: md }).then(function (r) {
						if (r && r.ok && r.path) flash("✓ 已导出");
						// 取消时静默
					}).catch(function () {
						flash("导出失败");
					});
				} else {
					try {
						var blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
						var url = URL.createObjectURL(blob);
						var a = document.createElement("a");
						a.href = url;
						a.download = name;
						document.body.appendChild(a);
						a.click();
						a.remove();
						setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
						flash("✓ 已下载");
					} catch (err) {
						flash("导出失败");
					}
				}
			}

			function flash(text) {
				setDone(text);
				if (timerRef.current !== null) clearTimeout(timerRef.current);
				timerRef.current = setTimeout(function () {
					timerRef.current = null;
					setDone(false);
				}, 3000);
			}

			react.useEffect(function () {
				return function () {
					if (timerRef.current !== null) clearTimeout(timerRef.current);
				};
			}, []);

			return react.createElement("button", {
				type: "button",
				style: css.exportBtn,
				onClick: doExport,
				title: "把当前会话导出为 Markdown 文件",
			}, done ? done : "📤 导出");
		}

		/**
		 * 会话标题栏的字号调节控件（导出按钮右侧）+ 主题切换按钮。
		 *
		 * 拖动滑块实时缩放 document.body（66ms 节流，避免每帧整页重排），
		 * 松手立即应用最终值；点击百分比恢复默认 100%；选择写入
		 * localStorage（dsh-desktop.fontScale）并上报 host，同时订阅 host
		 * 推送——AI 调用 desktop_set_font_scale 或其它标签页改字号时界面同步。
		 *
		 * 防回环：本组件应用外部推送时，若值与当前已应用值一致则跳过
		 * commitZoom（不再触发上报），与 host 端「值未变化不广播」配合，
		 * 彻底斩断 拖动→POST→广播→apply→POST 的无限循环。
		 *
		 * @param props.ctx - 客户端插件上下文（用于 ctx.theme 切换主题）。
		 */
		function FontScaleControl(props) {
			var ctx = props && props.ctx;
			var useState = react.useState;
			var useEffect = react.useEffect;
			var useRef = react.useRef;
			var scaleState = useState(function () { return loadScale(); });
			var scale = scaleState[0];
			var setScale = scaleState[1];
			var darkState = useState(function () {
				return document.body ? document.body.hasAttribute("data-ds-dark-theme") : false;
			});
			var dark = darkState[0];
			var setDark = darkState[1];
			var timerRef = useRef(null);
			var pendingRef = useRef(null);
			var lastRef = useRef(null);

			/** 应用字号：缩放 + 持久化 + 上报 host。 */
			function commit(v) {
				var c = clampScale(v);
				lastRef.current = c;
				applyZoom(c);
				saveScale(c);
				notifyHostScale(c);
			}

			/** 拖动节流：合并为最短 66ms 一次（取最新值），百分比数字即时更新。 */
			function schedule(v) {
				pendingRef.current = clampScale(v);
				if (timerRef.current !== null) return;
				timerRef.current = setTimeout(function () {
					timerRef.current = null;
					var s = pendingRef.current;
					pendingRef.current = null;
					commit(s);
				}, 66);
			}

			/** 松手 / 点击恢复时立即应用最终值。 */
			function flush() {
				if (timerRef.current !== null) {
					clearTimeout(timerRef.current);
					timerRef.current = null;
				}
				if (pendingRef.current !== null) {
					var s = pendingRef.current;
					pendingRef.current = null;
					commit(s);
				}
			}

			useEffect(function () {
				// 挂载：应用持久化字号（避免页面加载时闪一下默认大小）。
				commit(loadScale());
				// 订阅 host 推送（AI 工具 / 其它标签页改字号时同步）。
				var off = subscribeFontScale(function (next) {
					var v = clampScale(next);
					setScale(v);
					// 值与当前一致时跳过 commit（防回环）。
					if (lastRef.current === null || Math.abs(v - lastRef.current) > 1e-9) {
						commit(v);
					}
				});
				// 主题被其它入口（设置页）改变时同步图标。
				var offTheme = null;
				if (ctx && typeof ctx.on === "function") {
					try {
						offTheme = ctx.on("theme/change", function () {
							setDark(document.body ? document.body.hasAttribute("data-ds-dark-theme") : false);
						});
					} catch (err) {
						offTheme = null;
					}
				}
				return function () {
					off();
					if (offTheme) {
						try { offTheme(); } catch (err) { /* 忽略 */ }
					}
					if (timerRef.current !== null) clearTimeout(timerRef.current);
				};
			}, []);

			function toggleTheme() {
				var theme = ctx && ctx.theme;
				if (!theme || typeof theme.setTheme !== "function") return;
				try {
					theme.setTheme(dark ? "light" : "dark");
				} catch (err) {
					/* 主题服务不可用时忽略 */
				}
				setDark(!dark);
			}

			function onInput(e) {
				var v = clampScale(Number(e.target.value));
				setScale(v);
				schedule(v);
			}

			function onPctClick() {
				setScale(1);
				commit(1);
			}

			return react.createElement("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: "6px",
					padding: "0 2px",
					font: "12px/1.6 ui-sans-serif,system-ui,sans-serif",
					color: "inherit",
					userSelect: "none",
					whiteSpace: "nowrap",
				},
				title: "界面字号：拖动调节（80%–140%），点击百分比恢复默认",
			},
				react.createElement("button", {
					type: "button",
					onClick: toggleTheme,
					title: "切换深色 / 浅色主题",
					style: {
						fontSize: "13px",
						padding: "0 5px",
						borderRadius: "999px",
						border: "1px solid rgba(127,127,127,0.4)",
						background: "rgba(127,127,127,0.15)",
						color: "inherit",
						cursor: "pointer",
						lineHeight: "1.5",
					},
				}, dark ? "☀️" : "🌙"),
				react.createElement("span", { style: { opacity: 0.75 } }, "字号"),
				react.createElement("input", {
					type: "range",
					min: String(FONT_SCALE_MIN),
					max: String(FONT_SCALE_MAX),
					step: "0.05",
					value: String(scale),
					onChange: onInput,
					onMouseUp: flush,
					onTouchEnd: flush,
					onKeyUp: flush,
					style: { width: "72px", margin: 0, cursor: "pointer", accentColor: "#4d6bfe" },
					"aria-label": "界面字号",
				}),
				react.createElement("button", {
					type: "button",
					onClick: onPctClick,
					title: "点击恢复默认字号",
					style: {
						fontSize: "11px",
						padding: "1px 6px",
						borderRadius: "999px",
						border: "1px solid rgba(127,127,127,0.4)",
						background: "rgba(127,127,127,0.15)",
						color: "inherit",
						cursor: "pointer",
						fontVariantNumeric: "tabular-nums",
					},
				}, Math.round(scale * 100) + "%")
			);
		}

		/**
		 * 会话标题栏的实时时钟（导出/字号滑块右侧，order 87）。
		 * 每秒更新一次，显示 时:分:秒 与 月/日；点击可在「时间+日期」与「仅时间」间切换。
		 */
		function HeaderClock() {
			var useState = react.useState;
			var useEffect = react.useEffect;
			var nowState = useState(function () { return new Date(); });
			var now = nowState[0];
			var setNow = nowState[1];
			var showDateState = useState(true);
			var showDate = showDateState[0];
			var setShowDate = showDateState[1];

			useEffect(function () {
				var timer = setInterval(function () { setNow(new Date()); }, 1000);
				return function () { clearInterval(timer); };
			}, []);

			function pad(n) { return n < 10 ? "0" + n : String(n); }
			var hh = pad(now.getHours());
			var mm = pad(now.getMinutes());
			var ss = pad(now.getSeconds());
			var dateStr = showDate ? (now.getMonth() + 1) + "/" + now.getDate() + " " : "";

			return react.createElement("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					font: "12px/1.6 ui-monospace, Consolas, monospace",
					color: "inherit",
					userSelect: "none",
					whiteSpace: "nowrap",
					fontVariantNumeric: "tabular-nums",
					padding: "0 6px",
					borderRadius: "999px",
					border: "1px solid rgba(127,127,127,0.4)",
					background: "rgba(127,127,127,0.15)",
					cursor: "pointer",
					lineHeight: "1.5",
				},
				title: "实时时钟（点击切换显示日期）",
				onClick: function () { setShowDate(!showDate); },
			}, dateStr + hh + ":" + mm + ":" + ss);
		}

		/**
		 * 智能体运行状态上报（注册进 conversation.composer.dock，不渲染任何内容）。
		 * 会话 running 状态变化时通知桌面版：托盘图标切换「运行中」、任务栏进度条转圈。
		 */
		function AgentStateReporter(props) {
			var useEffect = react.useEffect;
			var useRef = react.useRef;
			var running = typeof props.useSession === "function"
				? props.useSession(function (s) { return s ? s.running : false; })
				: false;
			var lastRef = useRef(null);

			useEffect(function () {
				if (lastRef.current !== running) {
					lastRef.current = running;
					var bridge = window.dshDesktop;
					if (bridge && typeof bridge.setAgentRunning === "function") {
						try {
							bridge.setAgentRunning(running);
						} catch (err) {
							/* 忽略 */
						}
					}
				}
			}, [running]);

			return null;
		}

		// ── 插件主体 ──────────────────────────────────────────────────────────

		/**
		 * 注册设置页卡片，并挂载固定的字号滑块。
		 */
		function apply(ctx) {
			ctx.slots.inject("settings.general.item", function () {
				return ctx.slots.register({
					name: "settings.general.item",
					id: "desktop-status",
					order: 80,
				}, DesktopStatusCard);
			});

			// 拖拽文件进窗口 → 放入工作区。
			mountFileDrop();

			// 会话标题栏 action 区的「导出 Markdown」按钮（order 85）。
			ctx.slots.inject("conversation.session.header.actions", function () {
				return ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "desktop-export",
					order: 85,
				}, ExportButton);
			});

			// 会话标题栏 action 区的「字号调节 + 主题切换」控件（order 86，导出按钮右侧）。
			ctx.slots.inject("conversation.session.header.actions", function () {
				return ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "desktop-font-scale",
					order: 86,
				}, function FontScaleControlSlot(props) {
					return react.createElement(FontScaleControl, { ctx: ctx });
				});
			});

			// 会话标题栏的「实时时钟」（order 87，字号滑块右侧）。
			ctx.slots.inject("conversation.session.header.actions", function () {
				return ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "desktop-header-clock",
					order: 87,
				}, HeaderClock);
			});

			// 智能体运行状态上报（托盘/任务栏进度）。
			ctx.slots.inject("conversation.composer.dock", function () {
				return ctx.slots.register({
					name: "conversation.composer.dock",
					id: "desktop-agent-state",
					order: 999,
				}, AgentStateReporter);
			});
		}

		exports.name = name;
		exports.inject = inject;
		exports.description = description;
		exports.apply = apply;
		return module.exports;
	}
});
