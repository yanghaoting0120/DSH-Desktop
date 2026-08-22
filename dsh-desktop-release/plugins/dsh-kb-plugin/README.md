# dsh-kb 插件（知识中心）

DSH 知识中心插件：在会话标题栏添加「知识库」视图标签，以左侧导航 + 卡片布局（颜色全部使用 DSH 主题变量 → 深浅主题自动适配）展示知识库 / 图谱 / 技能 / 记忆 / 任务。

## 功能

| 视图 | 说明 |
|---|---|
| 知识库 | **整个工作区的全部文件**（含平时创建的工作文件，按目录展开）+ Markdown 预览 |
| 技能 | `skills/` 目录（SKILL.md） |
| 记忆 | 按日期一列展示日记（每月分组、日期 + 星期 + 当天摘要 + 今天徽章），点击某天查看全文 |
| 任务 | `tasks/` 任务归档与调度说明 |
| 图谱 | 知识关系网：力导向图可视化文件间的引用关系 |
| 搜索 | 全库文本搜索（文件名 + 内容片段） |

> 配色说明：所有颜色使用 DSH 主题变量（`--dsw-alias-bg-base` / `--dsw-alias-label-primary` / `--dsw-alias-border-l1` / `--dsw-alias-brand-primary` 等），**自动跟随应用深浅主题**，不写死两套。

### 知识库分区（全部工作文件）

- 数据源：`GET /plugins/kb/workspace`——扫描 `workspaceRoot`（默认 `C:\Users\Lenovo\Desktop\yht`）下的所有目录，收集文档类文件，排除 node_modules/dist/日志等
- 展示：进入「知识库」分区即可看到整个工作区的嵌套目录树（工具脚本 / Codex / DeepSeek Harness / YHT个人文件 / 顶层文档），目录可点击展开，文件点击打开
- **平时工作中创建的任何文件都会自动出现在这里**，无需额外操作
- 文件读取：file API 同时支持 kbRoot 与 workspaceRoot 两个基准，任一命中即可读

### 知识图谱

- 节点 = 各分区下的 Markdown 文件，按分区着色（知识库=青绿 / 技能=琥珀 / 记忆=紫 / 任务=蓝）
- 边 = 文件间的 Markdown 链接引用（自动解析 `[..](path)` 并规范化相对路径）
- 交互：滚轮缩放、拖拽平移、悬停高亮关联边、点击节点打开文件内容
- 数据源：`GET /plugins/kb/graph`（host 面自动构建节点与边）

### 记忆（按日期一列）

- 数据源：`GET /plugins/kb/diary`——扫描 `memory/` 下 `YYYY-MM-DD.md` 日记，按日期倒序，自动提取摘要
- 展示：按月份分组 → 每月一条日期行（日期 + 星期 + 摘要 + 「今天」徽章）→ 点击打开当天全文
- 约定：每日日记固定含「今日做了什么 / 用户今天讲过的内容 / 布置的任务」三节（见 `memory/README.md`）

## 源码结构

```
dsh-kb-plugin/
├── lib/index.js        # 插件 host 面（webServer 路由：tree/file/search API）
├── lib/client.js       # 插件客户端面（conversation.view 注册 + AutoBox 风格 UI）
├── test/selftest.mjs   # 自检脚本（mock ctx 验证 host 路由逻辑）
└── package.json        # 含 exports["./client"] 与 dsh.client 元数据
```

> 客户端面由 `dsh-client-modules` 自动发现（扫描启用的 loader 条目中声明
> `dsh.client` 的包），经 `/plugins/dsh-kb/client.js` 提供给浏览器。
> 修改 `lib/client.js` 后重启 dsh 进程生效。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `kbRoot` | 工作区 `DeepSeek Harness\学习Outbox排版功能并拓展（AutoBox深度分析）` | 知识中心根目录 |
| `sections` | `["knowledge","skills","memory","tasks"]` | 允许读取的顶层目录 |
| `maxFileBytes` | 4MB | 单文件读取上限 |

## 如何安装到 DSH profile

1. `dsh plugin --profile web add <本目录路径>` —— 以 `link:` 依赖装入 profile 的 node_modules；
2. 在 `cordis.patch.yml` 末尾追加插件行：

   ```yaml
   - insert:
       - id: kb
         name: 'dsh-kb'
         config:
           kbRoot: 'C:\Users\Lenovo\Desktop\yht\DeepSeek Harness\学习Outbox排版功能并拓展（AutoBox深度分析）'
   ```

3. 依赖解析：插件源码位于工作区，`@deepseek-ai/*` 依赖经工作区根目录的
   `node_modules\@deepseek-ai` junction 指向 `$DSH_HOME\profiles\node_modules\@deepseek-ai` 解析。
   若该 junction 不存在，用以下命令重建：

   ```powershell
   New-Item -ItemType Junction -Path "C:\Users\Lenovo\Desktop\yht\node_modules\@deepseek-ai" `
     -Target "C:\Users\Lenovo\.dsh\profiles\node_modules\@deepseek-ai"
   ```

4. 重启 `dsh web` 生效。可用 `dsh --profile web --dump-config | findstr kb` 确认组合结果。

> 提示：修改插件源码后无需重装（link 方式即时生效），重启 dsh 进程即可加载新代码。

## 自检

```sh
cd dsh-kb-plugin
node test/selftest.mjs
```
