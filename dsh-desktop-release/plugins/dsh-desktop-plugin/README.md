# dsh-desktop 插件

DSH（DeepSeek Harness）桌面版插件（host 面 + 客户端设置页 UI）。为智能体提供真实桌面能力，并暴露桌面运行环境状态。

## 功能

| 工具 | 说明 |
|---|---|
| `desktop_open` | 用操作系统默认应用打开文件 / 文件夹 / 网址；`reveal: true` 时在资源管理器中定位文件（Windows）。 |
| `desktop_notify` | 发送 Windows 桌面通知（右下角气泡，自动消失）。 |
| `desktop_status` | 读取运行环境：`mode`、平台、服务器地址、DSH_HOME、工作目录、版本信息、当前界面字号系数 `fontScale`。 |
| `desktop_set_font_scale` | 调节工作台界面字号：`scale`（0.8–1.4）或 `level`（`small` / `medium` / `large`），立即生效并同步到所有窗口。 |
| `desktop_remind` | 设置定时提醒（分钟后发桌面通知），返回 id。 |
| `desktop_reminders` | 列出所有待触发的提醒。 |
| `desktop_remind_cancel` | 按 id 取消一个提醒。 |

**系统提示词注入（host 面）**：注册一条 `desktop:long-task-notify` 提示词，约定
预计耗时较长的任务（约 1 分钟以上）完成后调用 `desktop_notify` 通知用户结果。

**客户端 UI（`lib/client.js`）**：
- **会话标题栏控件**（挂在 `conversation.session.header.actions`，位于导出按钮右侧）：
  - 🌙/☀️ **主题切换**按钮（走官方 `ctx.theme.setTheme`，与设置页外观同步）；
  - **字号滑块**（80%–140%），点击百分比恢复默认，`localStorage` 持久化（键 `dsh-desktop.fontScale`）。
- **会话标题栏**（`conversation.session.header.actions`）：📤 **导出 Markdown** 按钮（桌面版弹保存对话框，浏览器模式直接下载）。
- **拖拽文件进窗口**：把文件拖到窗口空白处 → 自动复制进工作区并提示（输入框区域不拦截，留给 composer 自身的图片附件逻辑）。
- **智能体运行状态上报**（`conversation.composer.dock`，不可见）：会话运行状态变化时通知桌面版 → 托盘图标切换「运行中」、任务栏进度条转圈。

**设置页 UI**：DSH 设置页「通用」区渲染「桌面版状态」卡片，显示运行模式、服务器地址、
工作目录与版本信息，带刷新按钮（数据来自 `window.dshDesktop` preload 桥）。

**Cordis 服务 `desktop`**：`ctx.desktop.get()` 读取环境状态；`getFontScale()` /
`setFontScale(scale)` 读写界面字号；host 侧事件 `desktop/font-scale`、
`desktop/reminder`（`ctx.on(...)` 可监听）。

**插件路由**（host 面，`ctx.webServer`）：
`GET /plugins/desktop/events`（SSE 字号下行）、`POST /plugins/desktop/font-scale`、
`POST /plugins/desktop/drop-file`（拖拽文件入工作区）。

- 工具注册在 host 层的工具注册表（global 层），因此对使用任意 agent preset 的会话都可见。
- 在桌面版（Electron）中运行，`desktop_status.mode` 为 `desktop`；在浏览器版中运行则为 `browser`，工具同样可用。
- 本地路径会先做存在性检查，不存在时快速报错（避免系统弹窗卡住）。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `notifyDurationMs` | `5000` | 通知默认显示时长（毫秒） |
| `openTimeoutMs` | `10000` | 打开外部程序的最长等待时间（毫秒） |

## 源码结构

```
dsh-desktop-plugin/
├── lib/index.js        # 插件 host 面（7 个工具 + desktop 服务 + 路由 + 系统提示词注入 + 定时提醒）
├── lib/client.js       # 插件客户端面（状态卡片 + 标题栏字号/主题控件 + 导出/拖放/运行状态，__ModuleLoader__ factory 格式）
├── test/selftest.mjs   # 自检脚本：mock ctx 调用工具并验证字号钳制/路由/服务/提醒
└── package.json        # 含 exports["./client"] 与 dsh.client 元数据
```

> 客户端面由 `dsh-client-modules` 自动发现（扫描启用的 loader 条目中声明
> `dsh.client` 的包），经 `/plugins/dsh-desktop/client.js` 提供给浏览器。
> 修改 `lib/client.js` 后重启 dsh 进程生效。

自检：

```sh
cd dsh-desktop-plugin
node test/selftest.mjs
```

## 如何安装到 DSH profile

本插件已安装到 `$DSH_HOME/profiles/web`（`C:\Users\Lenovo\.dsh\profiles\web`）：

1. `dsh plugin --profile web add <本目录路径>` —— 以 `link:` 依赖装入 profile 的 node_modules；
2. 在 `cordis.patch.yml` 末尾追加插件行：

   ```yaml
   - insert:
       - id: desktop
         name: 'dsh-desktop'
         config:
           notifyDurationMs: 5000
           openTimeoutMs: 10000
   ```

3. 依赖解析：插件源码位于工作区，`@deepseek-ai/*` 依赖经工作区根目录的
   `node_modules\@deepseek-ai` junction 指向 `$DSH_HOME\profiles\node_modules\@deepseek-ai` 解析。
   若该 junction 不存在，用以下命令重建：

   ```powershell
   New-Item -ItemType Junction -Path "C:\Users\Lenovo\Desktop\yht\node_modules\@deepseek-ai" `
     -Target "C:\Users\Lenovo\.dsh\profiles\node_modules\@deepseek-ai"
   ```

4. 重启 `dsh web` 生效。可用 `dsh --profile web --dump-config | findstr desktop` 确认组合结果。

> 提示：修改插件源码后无需重装（link 方式即时生效），重启 dsh 进程即可加载新代码。
