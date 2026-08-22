# DSH-Desktop · DSH 桌面版

> 让 DeepSeek Harness（DSH）智能体获得真实桌面能力：桌面通知、打开文件/网址、界面字号调节、
> 定时提醒、OCR 识别。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-blue)]()
[![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.7-green)]()

## 项目简介

DSH（DeepSeek Harness）是一个智能体工作台框架。**DSH-Desktop（DSH 桌面版）** 为它提供一套
桌面版插件 + 技能文档 + 桌面应用，让智能体从「只会聊天和读写文件」升级为能直接操作本机桌面的
助手：

- 🔔 任务完成时发 **Windows 桌面通知**
- 📂 用系统默认应用**打开文件 / 文件夹 / 网址**，或在资源管理器中定位文件
- 🔍 查询运行环境（桌面版 / 浏览器版、版本、字号等）
- 🔠 调节工作台界面字号（80%–140%）
- ⏰ 定时提醒（N 分钟后发桌面通知），可查看 / 取消
- 🖼 **OCR 识别**：图片文字与视频关键帧文字（Windows 内置引擎，离线、免费、支持中文）
- 📚 知识中心（可选）：工作区文件、技能、记忆、任务、知识图谱、全文搜索

## 快速开始

从 **Release** 下载单个压缩包即可，一个文件包含全部内容：

```
DSH桌面版-0.3.0-完整发布包.zip
├── 桌面版应用/DSH桌面版-0.3.0.exe   ← 桌面版应用安装程序（自带全部插件与技能）
├── SKILL.md                        ← 技能文档（智能体自动接入的核心）
├── install.ps1                     ← 一键安装脚本（给已有 DSH 使用）
├── README.md                       ← 使用说明
└── plugins/                        ← 插件源码（dsh-desktop / dsh-ocr / dsh-kb）
```

**还没有 DSH**：解压 → 双击 `桌面版应用\DSH桌面版-0.3.0.exe` 安装，装完即可使用。

**已有 DSH（含浏览器版）**：解压 → 运行 `install.ps1` 一键安装插件与技能；或只把 `SKILL.md`
放进技能目录（用户级 `~/.dsh/skills/dsh-desktop/` 或项目级 `.agents/skills/`），新开会话自动接入。

## 桌面能力一览

| 工具 | 说明 |
| --- | --- |
| `desktop_open` | 用系统默认应用打开文件 / 文件夹 / 网址；`reveal: true` 在资源管理器中定位文件 |
| `desktop_notify` | 发送 Windows 桌面通知（右下角气泡） |
| `desktop_status` | 读取运行环境：mode / platform / serverUrl / DSH_HOME / 工作目录 / 版本 / 字号 |
| `desktop_set_font_scale` | 调节界面字号（0.8–1.4 或 small / medium / large），立即生效 |
| `desktop_remind` | 设置定时提醒（N 分钟后发桌面通知），返回 id |
| `desktop_reminders` | 列出所有待触发的提醒 |
| `desktop_remind_cancel` | 按 id 取消提醒 |
| `ocr_recognize` | 识别图片文字；视频自动抽关键帧逐帧识别 |

同时注入一条系统提示词约定：**预计耗时约 1 分钟以上的任务完成后，调用 `desktop_notify`
通知用户结果**。

## 仓库结构

```
DSH-Desktop/
├── release/
│   └── DSH桌面版-0.3.0-完整发布包.zip   ← 发布产物（单文件，含 exe + 插件 + 技能 + 说明）
├── dsh-desktop-release/                ← 发布包源目录（同 zip 内容）
│   ├── 桌面版应用/                      ← 桌面版应用安装程序
│   ├── SKILL.md                        ← 技能文档
│   ├── install.ps1                     ← 一键安装脚本
│   ├── README.md                       ← 发布包内说明
│   └── plugins/                        ← 插件源码
│       ├── dsh-desktop-plugin/         ← 桌面能力（7 个工具 + 客户端 UI）
│       ├── dsh-ocr-plugin/             ← OCR（工具 + 输入区「🖼」按钮）
│       └── dsh-kb-plugin/              ← 知识中心（可选 UI）
├── README.md                           ← 本文件（GitHub 项目主页）
├── LICENSE                             ← MIT 许可证
└── .gitignore                          ← Git 忽略规则
```

## 安装到 DSH（手动）

```powershell
# 1. 安装插件（link 方式，改源码即时生效）
dsh plugin --profile web add ".\dsh-desktop-release\plugins\dsh-desktop-plugin"
dsh plugin --profile web add ".\dsh-desktop-release\plugins\dsh-ocr-plugin"
dsh plugin --profile web add ".\dsh-desktop-release\plugins\dsh-kb-plugin"

# 2. 在 <DSH_HOME>\profiles\web\cordis.patch.yml 末尾追加插件条目（见 dsh-desktop-release\README.md）
# 3. 部署技能文档
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills\dsh-desktop" | Out-Null
Copy-Item ".\dsh-desktop-release\SKILL.md" "$env:USERPROFILE\.dsh\skills\dsh-desktop\SKILL.md"

# 4. 重启
dsh web
```

## 验证安装

新开会话对智能体说：

> 用 desktop_status 看一下当前运行环境，然后 desktop_notify 发一条测试通知。

若返回 `mode: desktop`（或 `browser`）且通知弹出，即安装成功。

## 技术说明

- **插件框架**：DSH Cordis 插件（host 面注册工具 / 服务 / 路由，client 面提供 UI），
  工具注册在 host 层 global 工具注册表，对任意 agent preset 可见。
- **技能机制**：DSH 自动发现技能目录中的 `SKILL.md`，把桌面工具的使用方法注入智能体。
- **OCR 引擎**：Windows 10+ 内置 WinRT OCR（离线）；视频关键帧用 ffmpeg 均匀抽样。
- **运行形态**：桌面版（Electron）与浏览器版均可使用，`desktop_status.mode` 区分。

## 贡献

欢迎提交 Issue 与 Pull Request。本地自检：

```sh
cd dsh-desktop-release/plugins/dsh-desktop-plugin && node test/selftest.mjs
cd dsh-desktop-release/plugins/dsh-ocr-plugin     && node test/selftest.mjs
cd dsh-desktop-release/plugins/dsh-kb-plugin      && node test/selftest.mjs
```

## 许可证

[MIT](LICENSE)
