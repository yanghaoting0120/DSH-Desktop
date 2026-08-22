# DSH 桌面版插件发布包（dsh-desktop-release）

> 让任意 DeepSeek Harness（DSH）智能体**自动接入桌面版能力**：桌面通知、打开文件/网址、
> 界面字号调节、定时提醒、OCR 识别。
>
> 原理：DSH 会自动发现技能目录里的 `SKILL.md`（本项目 `SKILL.md`），把桌面工具的使用方法
> 注入给智能体；插件源码（`plugins/`）提供真实的 `desktop_*` / `ocr_recognize` 工具。

## 目录结构

```
dsh-desktop-release/
├── 桌面版应用/
│   └── DSH桌面版-0.3.0.exe      ← 桌面版应用安装程序（双击即可安装完整桌面版，自带全部插件）
├── SKILL.md                    ← 技能文档：放到技能目录，智能体自动接入（核心）
├── install.ps1                 ← 一键安装脚本（把插件装进已有 DSH + 部署技能）
├── README.md                   ← 本说明
└── plugins/                    ← 插件源码（给已有 DSH 手动/脚本安装时使用）
    ├── dsh-desktop-plugin/     ← 桌面能力：打开/通知/状态/字号/提醒（7 个工具）
    ├── dsh-ocr-plugin/         ← OCR：图片/视频文字识别（1 个工具 + 输入区「🖼」按钮）
    └── dsh-kb-plugin/          ← 知识中心：知识库/技能/记忆/任务/图谱视图（可选）
```

拿到这个压缩包后有两种用法：

- **还没有 DSH**：先装 `桌面版应用\DSH桌面版-0.3.0.exe`（桌面版应用自带全部插件和技能），装完即可用；
- **已有 DSH / 浏览器版**：运行 `install.ps1`（方式 B）或只放 `SKILL.md`（方式 A），即可接入桌面能力。


## 两种使用方式

### 方式 A：只装技能（最快，5 秒）

如果目标机器**已经装了桌面插件**（比如就是 DSH 桌面版应用），只需让智能体看到技能文档：

1. 把 `SKILL.md` 所在的文件夹放到任意技能根目录，例如：
   - 用户级：`<DSH_HOME>/skills/dsh-desktop/SKILL.md`（`DSH_HOME` 默认 `~/.dsh`）
   - 项目级：`<项目根目录>/.agents/skills/dsh-desktop/SKILL.md`
2. 新开会话，智能体自动在技能目录里看到 `dsh-desktop`，即可使用桌面能力。

### 方式 B：一键完整安装（推荐，给没有装插件的机器）

在 PowerShell 里执行（建议以管理员身份运行一次）：

```powershell
cd dsh-desktop-release
./install.ps1
```

脚本会：
1. 把 3 个插件以 `link:` 方式装进 DSH web profile（`dsh plugin --profile web add <目录>`）；
2. 在 `cordis.patch.yml` 末尾追加 `desktop` / `ocr` / `kb` 三个插件条目；
3. 把 `SKILL.md` 复制到 `<DSH_HOME>/skills/dsh-desktop/`；
4. 提示重启 `dsh web`。

完成后**重启 dsh**，新会话即自动获得桌面能力（可用「调用 desktop_status 看看环境」验证）。

## 手动安装步骤（等价于 install.ps1）

以 DSH_HOME = `C:\Users\<你>\.dsh`、profile = `web` 为例：

```powershell
# 1. 安装插件（link 方式，改源码即时生效）
dsh plugin --profile web add "C:\path\to\dsh-desktop-release\plugins\dsh-desktop-plugin"
dsh plugin --profile web add "C:\path\to\dsh-desktop-release\plugins\dsh-ocr-plugin"
dsh plugin --profile web add "C:\path\to\dsh-desktop-release\plugins\dsh-kb-plugin"

# 2. 在 cordis.patch.yml 末尾追加（文件位于 <DSH_HOME>\profiles\web\cordis.patch.yml）
#    - insert:
#        - id: desktop
#          name: 'dsh-desktop'
#          config: { notifyDurationMs: 5000, openTimeoutMs: 10000 }
#    - insert:
#        - id: ocr
#          name: 'dsh-ocr'
#          config: { lang: zh-Hans-CN, maxFrames: 6 }
#    - insert:
#        - id: kb
#          name: 'dsh-kb'
#          config:
#            kbRoot: 'C:\你的知识库根目录'
#            workspaceRoot: 'C:\你的工作区根目录'

# 3. 放技能文档（用户级技能根目录）
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills\dsh-desktop" | Out-Null
Copy-Item ".\SKILL.md" "$env:USERPROFILE\.dsh\skills\dsh-desktop\SKILL.md"

# 4. 重启
dsh web
```

依赖解析说明：插件源码位于发布包内，`@deepseek-ai/*` 依赖经 profile 自身的
`node_modules`（`<DSH_HOME>\profiles\node_modules\@deepseek-ai`）解析。若你的工作区需要
junction，可执行：

```powershell
New-Item -ItemType Junction -Path "<工作区>\node_modules\@deepseek-ai" `
  -Target "<DSH_HOME>\profiles\node_modules\@deepseek-ai"
```

## 桌面能力一览

| 工具 | 说明 |
| --- | --- |
| `desktop_open` | 用系统默认应用打开文件 / 文件夹 / 网址；`reveal: true` 在资源管理器中定位文件 |
| `desktop_notify` | 发送 Windows 桌面通知（右下角气泡） |
| `desktop_status` | 读取运行环境：mode / platform / serverUrl / DSH_HOME / 工作目录 / 版本 / 字号 |
| `desktop_set_font_scale` | 调节界面字号（0.8–1.4 或 small/medium/large），立即生效 |
| `desktop_remind` | 设置定时提醒（N 分钟后发桌面通知），返回 id |
| `desktop_reminders` | 列出所有待触发的提醒 |
| `desktop_remind_cancel` | 按 id 取消提醒 |
| `ocr_recognize` | 识别图片文字；视频自动抽关键帧逐帧识别 |

此外还注入一条系统提示词约定：**预计耗时较长（约 1 分钟以上）的任务完成后，调用
`desktop_notify` 通知用户结果**；输入区提供「🖼 识别」按钮（OCR 一键识别发送给 AI）。

## 验证安装

新开会话后对智能体说一句：

> 用 desktop_status 看一下当前运行环境，然后 desktop_notify 发一条测试通知。

若返回 `mode: desktop`（或 `browser`）且通知弹出，即安装成功。

## 常见问题

- **会话里看不到 desktop_* 工具**：插件未装上或 dsh 未重启。重跑 `install.ps1` 后重启。
- **OCR 报错**：需要 Windows 10+ 内置 OCR 引擎；视频抽帧需要 ffmpeg（`ffmpeg` 在 PATH 中，
  否则在插件 config 里配 `ffmpegPath` 绝对路径）。
- **技能没被自动发现**：确认 `SKILL.md` 所在目录名与 frontmatter 的 `name` 一致（`dsh-desktop`），
  且位于受支持的技能根目录（用户级 `<DSH_HOME>/skills/` 或项目级 `.agents/skills/`）。
