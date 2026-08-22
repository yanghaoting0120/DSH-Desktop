---
name: dsh-desktop
version: 1.0.0
description: "DSH 桌面版插件：为本机会话提供真实桌面能力——用系统默认应用打开文件/文件夹/网址或在资源管理器中定位（desktop_open）、发送 Windows 桌面通知（desktop_notify）、查询桌面运行环境（desktop_status）、调节工作台界面字号（desktop_set_font_scale）、设置/查询/取消定时提醒（desktop_remind / desktop_reminders / desktop_remind_cancel）、识别图片与视频中的文字（ocr_recognize）。当用户要求打开/预览/启动本机文件或网址、在文件管理器中定位文件、任务完成时发桌面通知、稍后提醒、放大或缩小界面文字、识别图片/截图/视频文字时使用。"
---

# DSH 桌面版能力（dsh-desktop + dsh-ocr）

本技能对应的能力来自 `dsh-desktop` / `dsh-ocr` 两个插件。插件安装后，会话中会出现
`desktop_*` 与 `ocr_recognize` 工具；本技能文档告诉智能体**何时、如何**调用这些工具。

## 环境检测

- 调用 `desktop_status` 读取运行环境，无需参数，返回：`mode`（`desktop` = 桌面版应用，
  `browser` = 浏览器版，两种形态下工具均可用）、`platform`、`desktopApp`、
  `serverUrl`、`dshHome`、`workspace`、`node` 版本、`fontScale`（当前界面字号系数）。
- 判断「当前是不是桌面版」、查询字号、环境排障时先调用本工具。

## 工具清单

| 工具 | 用途 |
| --- | --- |
| `desktop_open` | 用系统默认应用打开文件 / 文件夹 / 网址；`reveal: true` 时在资源管理器中定位文件（Windows） |
| `desktop_notify` | 发送 Windows 桌面通知（右下角气泡，自动消失） |
| `desktop_status` | 查询桌面运行环境与当前界面字号 |
| `desktop_set_font_scale` | 调节工作台界面字号（0.8–1.4 或 small/medium/large），立即生效并同步所有窗口 |
| `desktop_remind` | 设置 N 分钟后发桌面通知的定时提醒，返回 id |
| `desktop_reminders` | 列出所有未触发的提醒 |
| `desktop_remind_cancel` | 按 id 取消一个待触发的提醒 |
| `ocr_recognize` | 识别图片文字；视频自动抽关键帧逐帧识别后合并去重 |

## 各工具使用指引

### desktop_open
- 参数：`target`（必填，文件/文件夹的绝对路径，或 `http(s)/mailto` 等 URL）、
  `reveal`（可选布尔，为 true 且目标是文件时，在文件管理器中定位该文件）。
- 适用：用户说「打开这个文件 / 打开这个文件夹 / 打开某网址 / 打开我的文档」、
  「在资源管理器里显示这个文件」。不要把相对路径直接传进去，先用文件系统工具解析为绝对路径。
- 注意：本地路径会先做存在性检查，路径不存在会直接报错（避免系统弹窗卡住）。

### desktop_notify
- 参数：`title`（必填，短标题）、`body`（必填，正文）、`durationMs`（可选，默认 5000，最大 60000）。
- 适用：需要跳出聊天窗口提醒用户的场合，例如长任务完成/失败时告知结果。
- 约定：**预计耗时约 1 分钟以上**的任务（长时间命令、脚本执行、构建、批量处理等）
  完成时必须调用本工具通知用户结果（完成或失败，简要说明即可）；即时完成的小任务无需通知。

### desktop_status
- 无参数。返回 `{ mode, platform, desktopApp, serverUrl, dshHome, workspace, node, fontScale }`。
- 适用：判断运行形态（桌面版 / 浏览器版）、查询当前字号、环境排障。

### desktop_set_font_scale
- 参数：`scale`（数字 0.8 = 缩小 20% … 1.4 = 放大 40%，1.0 = 默认）或
  `level`（`small` = 0.85 / `medium` = 1.0 / `large` = 1.2，level 优先于 scale）。
- 适用：用户要求「把界面字调大/调小」「字太小了」等。立即生效并同步到所有窗口；
  用 `desktop_status` 的 `fontScale` 字段查询当前值。

### desktop_remind / desktop_reminders / desktop_remind_cancel
- `desktop_remind`：`minutes`（必填，>0）、`text`（必填）；返回 `{ id, at }`。
  到点会发桌面通知（标题「⏰ 定时提醒」）。
- `desktop_reminders`：无参数，列出所有未触发提醒（id、文本、触发时间、剩余秒数）。
- `desktop_remind_cancel`：传 `id` 取消；id 未知时是安全空操作。
- 适用：用户说「20 分钟后提醒我喝水」「帮我设个提醒」「取消那个提醒」。

### ocr_recognize
- 参数：`path`（必填，图片或视频的绝对路径）、`lang`（可选，默认 `zh-Hans-CN`）。
- 图片直接识别；视频先均匀抽取最多 6 个关键帧（可配置），逐帧识别后合并去重。
- 适用：用户要求识别图片/截图/扫描件/视频中的文字，或提供图片/视频文件希望提取文字
  用于分析、总结、翻译、转写。
- 说明：识别结果在 `text` 字段；识别不出文字时 `text` 为空字符串，属正常情况。
  中文输出可能带空格（如「你 好 世 界」），是 Windows OCR 的输出特性，非 bug。

## 使用约定

1. **长任务通知约定**：见 `desktop_notify`——耗时约 1 分钟以上的任务完成时发桌面通知。
2. **OCR 约定**：图片/视频文字提取一律走 `ocr_recognize`。
3. 工具在桌面版与浏览器版均可用；`desktop_status.mode` 用于区分运行形态。

## 若工具不可用

若当前会话中不存在上述 `desktop_*` 或 `ocr_recognize` 工具，说明 `dsh-desktop` / `dsh-ocr`
插件尚未安装到本机 DSH profile：运行发布包里的 `install.ps1`（或按同目录
`README.md` 手动安装），重启 dsh 后工具即出现，本技能自动生效。
