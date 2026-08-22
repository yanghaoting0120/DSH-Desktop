/**
 * dsh-ocr — 客户端（浏览器）半区。
 *
 * 在对话输入区的工具行（conversation.input.left）注册一个「🖼 识别」按钮：
 *  1. 点击后打开文件选择框（图片 / 视频）；
 *  2. 桌面版经 window.dshDesktop.getPathForFile 拿本地路径直接上传（大文件友好），
 *     浏览器版回退 FileReader base64 上传；
 *  3. host 面保存文件并自动识别（图片直接 OCR，视频抽关键帧后逐帧 OCR）；
 *  4. 识别完成后，把「文件 + 识别文本」写入输入框并自动提交，AI 收到后即可
 *     基于文本分析 / 总结 / 翻译。
 *
 * 注意：本文件是浏览器端 bundle，采用 DSH 客户端模块系统的 factory 格式
 * （window.__ModuleLoader__.load），由 dsh-client-modules 经
 * exports["./client"] 发现并以 /plugins/dsh-ocr/client.js 提供。
 */
window.__ModuleLoader__.load({
	id: "dsh-ocr",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── 插件元数据 ────────────────────────────────────────────────────────

		var name = "ocr-client";
		var inject = ["slots"];
		var description = "对话输入区「OCR 识别」按钮：选择图片/视频，自动识别文字并发送给 AI 分析。";

		// ── 轻量 toast（右下角短暂提示） ───────────────────────────────────────

		var toastTimer = null;
		function showToast(text) {
			try {
				var el = document.getElementById("dsh-ocr-toast");
				if (!el) {
					el = document.createElement("div");
					el.id = "dsh-ocr-toast";
					el.style.cssText = [
						"position:fixed",
						"right:16px",
						"bottom:104px",
						"z-index:2147483002",
						"max-width:460px",
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
				}, 6000);
			} catch (err) {
				/* 忽略 */
			}
		}

		// ── 隐藏的文件选择框（模块级单例） ────────────────────────────────────

		var fileInput = null;
		function getFileInput() {
			if (!fileInput) {
				fileInput = document.createElement("input");
				fileInput.type = "file";
				fileInput.accept = "image/*,video/*";
				fileInput.style.display = "none";
				document.documentElement.appendChild(fileInput);
			}
			return fileInput;
		}

		// ── 上传并识别 ────────────────────────────────────────────────────────

		/** POST /plugins/ocr/upload；resolve 为 host 返回的 { ok, name, dest, kind, text, frames }。 */
		function postUpload(payload) {
			return fetch("/plugins/ocr/upload", {
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
					if (data && data.ok) return data;
					throw new Error(String((data && data.error) || "识别失败"));
				});
		}

		/** 把用户选择的文件上传并识别；resolve 为识别结果。 */
		function uploadAndRecognize(file) {
			var bridge = window.dshDesktop;
			if (bridge && typeof bridge.getPathForFile === "function") {
				var realPath = bridge.getPathForFile(file);
				if (realPath) {
					return postUpload({ name: file.name, path: realPath });
				}
			}
			// 浏览器模式：读为 base64 上传。
			return new Promise(function (resolve, reject) {
				var reader = new FileReader();
				reader.onload = function () {
					var dataUrl = String(reader.result || "");
					var comma = dataUrl.indexOf(",");
					postUpload({
						name: file.name,
						base64: comma >= 0 ? dataUrl.slice(comma + 1) : "",
					}).then(resolve).catch(reject);
				};
				reader.onerror = function () {
					reject(new Error("读取文件失败"));
				};
				reader.readAsDataURL(file);
			});
		}

		// ── 按钮组件 ──────────────────────────────────────────────────────────

		var btnStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: "30px",
			height: "30px",
			borderRadius: "8px",
			border: "1px solid rgba(127,127,127,0.35)",
			background: "transparent",
			color: "inherit",
			fontSize: "15px",
			cursor: "pointer",
			lineHeight: 1,
			flex: "0 0 auto",
		};

		/**
		 * 对话输入区工具行左侧的「🖼 识别」按钮。
		 * props 来自 input.left 插槽的 InputZone + 会话标准 kit（useInput / inputActions）。
		 */
		function OcrUploadButton(props) {
			var useState = react.useState;
			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var inputActions = props && props.inputActions;

			function pickAndRecognize() {
				if (busy) return;
				var input = getFileInput();
				input.value = "";
				input.onchange = function () {
					var file = input.files && input.files[0];
					if (!file) return;
					setBusy(true);
					showToast("🔄 正在识别：" + file.name + " …");
					uploadAndRecognize(file)
						.then(function (data) {
							setBusy(false);
							var text = String(data.text || "").trim();
							var frameNote =
								data.kind === "video" && data.frames && data.frames.length > 1
									? "（视频已抽 " + data.frames.length + " 个关键帧）"
									: "";
							if (!text) {
								showToast("⚠️ 未识别到文字" + frameNote);
								return;
							}
							// 把「文件 + 识别文本」写入输入框并自动提交，AI 收到后即可分析。
							var msg = "【OCR 识别】文件：" + data.name + frameNote + "\n识别结果：\n" + text;
							if (inputActions && typeof inputActions.setDraft === "function") {
								inputActions.setDraft(msg);
								if (typeof inputActions.submit === "function") {
									inputActions.submit();
									showToast("✅ 识别完成，已发送给 AI" + frameNote);
								} else {
									showToast("✅ 识别完成，已填入输入框，回车发送" + frameNote);
								}
							} else {
								showToast("✅ 识别完成，请把输入框内容发送给 AI" + frameNote);
							}
						})
						.catch(function (err) {
							setBusy(false);
							showToast("❌ 识别失败：" + String((err && err.message) || err).slice(0, 80));
						});
				};
				input.click();
			}

			return react.createElement("button", {
				type: "button",
				style: btnStyle,
				onClick: pickAndRecognize,
				title: "选择图片或视频，自动识别其中的文字并发送给 AI 分析（支持中文）",
				disabled: busy,
			}, busy ? "⏳" : "🖼");
		}

		// ── 插件主体 ──────────────────────────────────────────────────────────

		/** 注册输入区工具行按钮。 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.left", function () {
				return ctx.slots.register({
					name: "conversation.input.left",
					id: "ocr-upload",
					order: 60,
				}, OcrUploadButton);
			});
		}

		exports.name = name;
		exports.inject = inject;
		exports.description = description;
		exports.apply = apply;
		return module.exports;
	}
});
