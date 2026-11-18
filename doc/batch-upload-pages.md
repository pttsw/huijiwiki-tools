# 批量页面上传工具

将本地页面文本或结构化清单批量上传到 HuijiWiki，支持目录文件模式与 JSON 清单模式。

## 功能特性

- 支持目录文件模式：一个文件对应一个 wiki 页面
- 支持 JSON 清单模式：显式提供 `title` 与 `content`
- 支持只上传更新页面模式（`--update-only`）：仅上传 `replace-logs.json` 中记录的已更改文件
- 默认安全策略：页面已存在时跳过
- 支持 `--overwrite` 显式覆盖
- 支持 dry-run 预览标题规范化与上传决策
- 支持断点续传与失败重试
- 支持并发处理
- 正确保留页面标题中的单引号 `'`

## 安装

```bash
npm install
```

## 配置

复制配置模板并填写实际信息：

```bash
cp config/upload.config.example.json config/upload.config.json
```

或直接使用upload.config.output.json与upload.config.page.json文件。

可在 config\upload.auth.json 中配置上传脚本的机器人信息，若上传用的 upload.config.json 中未配置，则使用 config\upload.auth.json 配置。

新增页面上传配置：

```json
{
  "pageUpload": {
    "comment": "Batch page upload",
    "maxConcurrency": 5,
    "defaultExtensions": [".txt", ".wiki", ".wikitext", ".md"],
    "skipExisting": true
  }
}
```

### 配置说明

| 字段 | 说明 |
|------|------|
| `pageUpload.comment` | 页面上传时的编辑摘要 |
| `pageUpload.maxConcurrency` | 最大并发上传数 |
| `pageUpload.defaultExtensions` | 目录模式默认扫描扩展名 |
| `pageUpload.skipExisting` | 文档化默认策略；实际覆盖由 `--overwrite` 控制 |
| `pageUpload.rootPath` | 目录模式默认上传路径 |
| `pageUpload.enableParentPage` | 是否创建父页面 |
| `pageUpload.excludeParentPagePaths` | 无视pageUpload.enableParentPage规则的文件路径 |

## 使用方法

### 目录文件模式

使用脚本自带的两种默认配置，分别用于上传json文件和普通文件，上传前记得确认配置文件里的rootPath路径是否正确。

```bash
# 上传json文件用
npm run get:json
# 预览
npm run get:json:dry-run
# 只上传有更新的json文件
npm run get:json:update
# 指定子文件夹上传
npm run get:json -- --file <folder>

# 上传普通文件用
npm run get:page
# 预览
npm run get:page:dry-run
# 只上传有更新的普通文件
npm run get:page:update
# 指定子文件夹上传
npm run get:page -- --file <folder>
```

或者使用自定义上传配置文件：

```bash
node tools/batch-upload-pages.js -s ./pages -c ./config/upload.config.json

# 或使用 npm script
npm run upload:pages -- -s ./pages

# 或更改 rootPath 为指定路径后使用
node tools/batch-upload-pages.js
```

目录模式标题规则：

- 去掉文件扩展名
- 相对路径 `/` 转为 `-`
- 然后执行标题规范化

示例：

| 文件路径 | 页面标题 |
|----------|----------|
| `法术/火球术.txt` | `法术/火球术` |
| `spells/FTD/Ashardalon's Stride.wiki` | `spells/FTD/Ashardalon's Stride` |

### 只上传更新页面模式（update-only）

该模式仅上传 `replace-logs.json` 中记录的已更改文件，适用于数据/页面内容更新后只同步变更项的增量上传场景。

#### 前置条件

- 已配置 `pageUpload.rootPath`
- 根目录中存在由数据生成工具产出的 `replace-logs.json`，其记录格式如下：

```json
{
  "generatedAt": "2026-11-17T12:00:00.000Z",
  "inputCommit": "abc12345",
  "changedOutputFiles": [
    { "filePath": "spells/Fireball.wiki" },
    { "filePath": "bestiary/Dragon.wiki" }
  ]
}
```

工具会读取其中 `changedOutputFiles[].filePath` 作为待上传文件列表。

#### 用法

```bash
# 只上传有更新的文件（使用默认配置）
node tools/batch-upload-pages.js --update-only -c ./config/upload.config.json

# 预览哪些文件将被上传
node tools/batch-upload-pages.js --update-only --dry-run -c ./config/upload.config.json
```

也提供了内置 npm 脚本（基于 json 上传配置）：

```bash
# 上传有更新的 json 文件
npm run get:json:update
# 预览
npm run get:json:update:dry-run
```

> 说明：此模式下无需提供 `-s`/`-m` 参数，路径来自 `pageUpload.rootPath`。若根目录下找不到 `replace-logs.json` 或其中没有记录的已更改文件，工具会打印提示并退出。

## JSON 清单模式

```bash
node tools/batch-upload-pages.js -m ./pages.json -c ./config/upload.config.json
```

清单格式：

```json
[
  {
    "title": "法术:火球术",
    "content": "页面正文",
    "summary": "Batch page upload"
  },
  {
    "title": "法术:Ashardalon's Stride",
    "content": "页面正文"
  }
]
```

## 预览模式

不实际上传，仅预览标题规范化与存在性决策：

```bash
node tools/batch-upload-pages.js -m ./pages.json --dry-run

# 或
npm run upload:pages:dry-run -- -m ./pages.json
```

dry-run 输出包含：

- 原始标题
- 规范化标题
- 页面是否已存在
- 实际决策：`create` / `skip` / `overwrite`
- 正文长度

## 覆盖策略

默认行为：

- 若目标页面已存在，则跳过
- 若目标页面不存在，则创建

显式覆盖：

```bash
node tools/batch-upload-pages.js -m ./pages.json --overwrite
```

## 断点续传与失败重试

```bash
node tools/batch-upload-pages.js --resume ./page-upload-progress.json

node tools/batch-upload-pages.js --retry-failed ./page-upload-progress.json
```

## 命令行参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-s, --source <dir>` | 目录文件模式输入目录 | - |
| `-m, --manifest <file>` | JSON 清单模式输入文件 | - |
| `-c, --config <file>` | 配置文件路径 | `./config/upload.config.json` |
| `-file, --file <file>` | 指定上传文件路径模式 | - |
| `--progress-file <file>` | 进度文件路径 | `./page-upload-progress.json` |
| `--log-file <file>` | 上传日志文件路径 | `./logs/page-upload.log` |
| `--resume <file>` | 从进度文件恢复 | - |
| `--retry-failed <file>` | 重试失败页面 | - |
| `--dry-run` | 预览模式，不实际上传 | `false` |
| `--overwrite` | 页面存在时执行覆盖 | `false` |
| `--concurrency <n>` | 并发上传数 | `pageUpload.maxConcurrency` 或 `1` |
| `--extensions <list>` | 目录模式文件扩展名列表，逗号分隔 | `pageUpload.defaultExtensions` |
| `--update-only` | 只上传 `replace-logs.json` 中记录的已更改文件（需配置 `pageUpload.rootPath`） | `false` |
| `-h, --help` | 显示帮助信息 | - |

## 页面标题规范化

### 保留字符

- 中文
- 英文大小写
- 数字
- 空格
- 单引号 `'`
- 连字符 `-`
- 下划线 `_`
- 命名空间分隔符 `:`

### 替换规则

| 字符 | 处理方式 |
|------|----------|
| `/` | 转换为 `:` |
| `#`, `<`, `>`, `[`, `]`, `{`, `}`, `\|` | 转换为 `_` |
| 连续空白 | 压缩为单个空格 |
| 首尾空白 | 去除 |
| 多个连续 `:` | 压缩为单个 `:` |
| 标题首尾 `:` | 去除 |

### 说明

- 单引号 `'` 会保留，不会被转义掉。
- 标题若在规范化后为空，将直接失败，不发起上传。

## 日志文件

### 进度文件 (`page-upload-progress.json`)

```json
{
  "taskId": "20260515150000",
  "taskType": "page",
  "sourceType": "manifest",
  "manifestPath": "/path/to/pages.json",
  "pendingFiles": ["法术:火球术"],
  "completed": [],
  "failed": []
}
```

### 上传日志 (`logs/page-upload.log`)

```text
[2026-05-15T15:00:00.000Z] SUCCESS 法术:火球术 -> dnd5e
[2026-05-15T15:00:01.000Z] FAILED  法术:失效页 (invalid title)
```