# dsh-ocr 插件

DSH（DeepSeek Harness）OCR 插件：识别**图片文字**与**视频关键帧文字**，并在对话输入区提供一个
「🖼 识别」按钮，选图片/视频一键识别后自动把结果发送给 AI 分析。

OCR 引擎使用 **Windows 10+ 内置 WinRT OCR**（`Windows.Media.Ocr`，经 `powershell.exe` 调用），
离线、免费、支持中文（默认 `zh-Hans-CN`）。视频关键帧用 **ffmpeg** 均匀抽样（默认最多 6 帧），
逐帧识别后合并去重。

## 功能

| 入口 | 说明 |
|---|---|
| 工具 `ocr_recognize` | AI 直接调用：传图片/视频路径，返回 `{ kind, text, frames }`。图片直接识别；视频自动抽关键帧逐帧识别。 |
| 对话输入区「🖼」按钮 | 点击选图片/视频 → 自动上传识别 → 把「文件 + 识别文本」写入输入框并提交，AI 收到后即可分析/总结/翻译。 |
| 路由 `POST /plugins/ocr/upload` | 客户端上传入口：桌面模式传本地路径（大文件友好），浏览器模式传 base64（≤200MB）。 |

## 安装（已装好）

本插件已装入 `$DSH_HOME/profiles/web`（`C:\Users\Lenovo\.dsh\profiles\web`）：

1. `web\node_modules\dsh-ocr` —— junction 指向 `C:\Users\Lenovo\Desktop\yht\dsh-desktop-app\dsh-ocr-plugin`；
2. `web\package.json` —— `"dsh-ocr": "link:..."` 依赖；
3. `web\cordis.patch.yml` —— 末尾追加 `- insert: [{ id: ocr, name: 'dsh-ocr', config: { lang: zh-Hans-CN, maxFrames: 6 } }]`。

依赖经工作区根目录 `node_modules\@deepseek-ai` junction 解析（指向 `$DSH_HOME\profiles\node_modules\@deepseek-ai`）。
改源码后无需重装（link 即时生效），**重启 dsh 进程**即可加载新代码。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `lang` | `zh-Hans-CN` | 默认 OCR 语言标签（`zh-Hans-CN` / `en-US` / `en-GB` / `ja-JP` 等，取决于系统安装的语言包） |
| `maxFrames` | `6` | 视频最多抽取的关键帧数（1–20） |
| `ffmpegPath` | `ffmpeg` | ffmpeg 可执行文件（PATH 中找不到时改为绝对路径） |
| `ocrTimeoutMs` | `30000` | 单张图片 OCR 超时（毫秒） |
| `ffmpegTimeoutMs` | `120000` | 视频截帧超时（毫秒） |
| `uploadDir` | `ocr-uploads` | 上传文件保存目录（相对工作区） |

## 源码结构

```
dsh-ocr-plugin/
├── lib/index.js        # 插件 host 面：ocr_recognize 工具 + 上传路由 + 截帧/识别逻辑 + 提示词注入
├── lib/client.js       # 插件客户端面：输入区「🖼」按钮（__ModuleLoader__ factory 格式）
├── lib/ocr.ps1         # WinRT OCR 脚本（powershell.exe 调用，输出 UTF-8 文本文件）
├── test/selftest.mjs   # 自检：mock ctx + 真实图片 OCR + 视频截帧 OCR + 上传路由 + 错误路径
└── package.json        # 含 exports["./client"] 与 dsh.client 元数据
```

## 自检

```sh
cd dsh-ocr-plugin
node test/selftest.mjs
```

自检会：生成一张带中英文的测试图并识别 → 生成 3 秒测试视频并抽帧识别 → 模拟上传路由 → 验证
错误路径与不支持类型报错。2026-08-20 实测全部通过（图片/视频中文识别正常）。

## 注意事项

- 视频抽帧依赖 ffmpeg；OCR 依赖 Windows 内置引擎（Windows 10 1607+）。两者缺失时工具会明确报错。
- 识别出的中文间可能带空格（`你 好 世 界`），这是 Windows OCR 的输出特性，非 bug。
- 上传的文件保存在工作区 `ocr-uploads/` 目录，识别完成可手动清理。
