# 批量图片上传工具

将本地图片文件夹批量上传到 HuijiWiki，自动进行路径转换和分类标签添加。

## 功能特性

- 递归扫描多层子文件夹中的图片
- 自动路径转换：`spells/FTD/Ashardalon's Stride.webp` → `spells-FTD-Ashardalon's Stride.webp`
- 自动添加维基分类标签（支持中英文分类映射）
- 断点续传：任务中断后可恢复
- 上传日志：记录所有已上传文件，防止重复上传
- 支持并发上传
- 可配置跳过特定文件夹
- dry-run 预览模式
- 仅上传已更新文件模式（`--update-only`）：只上传 `img-replace.json` 记载的更新文件

## 安装

```bash
npm install
```

## 配置

复制配置模板并填写实际信息：

```bash
cp config/upload.config.example.json config/upload.config.json
```

编辑 `config/upload.config.json`：

```json
{
  "wiki": {
    "prefix": "dnd5e",
    "authKey": "your-auth-key-here"
  },
  "auth": {
    "username": "YourUsername@BotName",
    "password": "your-bot-password"
  },
  "upload": {
    "comment": "Batch image upload",
    "maxConcurrency": 10
  },
  "categoryMapping": {
    "adventure": "模组",
    "backgrounds": "背景",
    "spells": "法术",
    ...
  },
  "skip": {
    "folders": ["docker"],
    "files": ["old-banner.png"]
  }
}
```

> **注意**：`auth.username` / `auth.password`（以及 `wiki.prefix` / `wiki.authKey`）若为默认占位符（如 `your-bot-password`）、缺失或为空，会自动回退读取同目录 `config/upload.auth.json` 中的值。

### 配置说明

| 字段 | 说明 |
|------|------|
| `wiki.prefix` | 维基二级域名，如 `dnd5e` 对应 `dnd5e.huijiwiki.com` |
| `wiki.authKey` | API 认证密钥 |
| `auth.username` | 登录用户名，机器人账号格式为 `User@BotName` |
| `auth.password` | 登录密码或机器人密码 |
| `upload.comment` | 上传时的编辑摘要 |
| `upload.maxConcurrency` | 最大并发上传数（默认 10） |
| `categoryMapping` | 一级文件夹的中英文分类映射表 |
| `skip.folders` | 需要跳过的文件夹列表（如 `docker`），支持原名或相对路径 |
| `skip.files` | 需要跳过的文件列表（如 `old-banner.png`），支持文件名或相对路径 |

### 分类映射表

配置文件中预置了完整的分类映射：

| 英文文件夹 | 中文分类 |
|-----------|----------|
| adventure | 模组 |
| backgrounds | 背景 |
| bastions | 据点 |
| bestiary | 怪物 |
| book | 扩展 |
| characters | 人物 |
| charcreationoptions | 职业选项 |
| classes | 职业 |
| conditions | 状态 |
| diseases | 疾病 |
| covers | 封面 |
| decks | 卡牌 |
| deities | 神祇 |
| dmscreen | 帷幕 |
| feats | 专长 |
| hazards | 危害 |
| items | 道具 |
| languages | 语言 |
| object | 物件 |
| optionalfeatures | 职业能力选项 |
| pdf | PDF |
| races | 种族 |
| recipes | 食谱 |
| spells | 法术 |
| traps | 陷阱 |
| variantrules | 术语 |
| vehicles | 载具 |

## 使用方法

### 基本用法

```bash
# 上传图片
node tools/batch-upload-images.js -s ./images -c ./config/upload.config.json

# 或使用 npm script
npm run upload -- -s ./images
```

### 预览模式（dry-run）

不实际上传，仅预览转换结果：

```bash
node tools/batch-upload-images.js -s ./images --dry-run

# 或
npm run upload:dry-run -- -s ./images
```

### 断点续传

任务中断后，可从进度文件恢复：

```bash
node tools/batch-upload-images.js --resume ./upload-progress.json
```

### 重试失败项

仅重试之前失败的文件：

```bash
node tools/batch-upload-images.js --retry-failed ./upload-progress.json
```

### 仅上传已更新文件模式（--update-only）

适用于源仓库更新后只需**增量上传**的场景（例如某个扩展/来源更新了图片）：只上传 `img-replace.json` 中记载的更新过的文件，避免全量重新扫描上传。

使用前会扫描源目录**第一层**是否存在 `img-replace.json`：

- 不存在：在控制台报错，同时写入上传日志（`ERROR` 行），并以非零码退出
- 存在：只上传其中记载的文件，其余文件一律不处理

```bash
node tools/batch-upload-images.js -s ./images --update-only

# 或
npm run upload:update -- -s ./images
```

`img-replace.json` 格式：

```json
{
  "repo": "……",
  "folders": [
    "races"
  ],
  "files": [
    "backgrounds/forest.png"
  ]
}
```

| 字段 | 作用 |
|------|------|
| `repo` | 仓库标识，仅作元信息记录，不参与上传逻辑 |
| `folders` | 新增或全部有更新的文件夹列表；其中所有受支持格式（webp/png/jpg/gif/svg/bmp/ico）的图片都会被递归收集并上传 |
| `files` | 单独列出的更新图片文件，为相对源目录的路径；文件不存在时会输出警告并跳过 |

行为约定：

- **路径转换与分类标签**与普通模式完全一致（如 `races/MM/Dragon.png` → `races-MM-Dragon.png`，分类自动带上二级文件夹 `MM` 及对应中文分类）
- **以 `img-replace.json` 为准**：不再应用配置中的 `skip` 文件夹过滤
- **不受上传日志去重限制**：列表中每个文件都会尝试上传；内容与维基现有文件一致时由媒体库以 `fileexists-no-change` 自动跳过，内容有变化的同名文件会覆盖更新
- **支持 `--dry-run`**：`node tools/batch-upload-images.js -s ./images --update-only --dry-run` 可先预览本次更新将处理的文件、转换结果和分类标签
- **支持断点续传与失败重试**：`--resume ./upload-progress.json`、`--retry-failed ./upload-progress.json` 均可用于该模式
- 若源目录为 `D:\homebrew-img`，会自动切换到其 `img` 子目录作为图片根目录，`img-replace.json` 仍位于源目录第一层

### 并发上传

设置并发数提高上传速度，且不会超过配置中的 `upload.maxConcurrency`：

```bash
node tools/batch-upload-images.js -s ./images --concurrency 3
```

## 命令行参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-s, --source <dir>` | 源图片文件夹路径 | 必填（新任务） |
| `-c, --config <file>` | 配置文件路径 | `./config/upload.config.json` |
| `--progress-file <file>` | 进度文件路径 | `./upload-progress.json` |
| `--log-file <file>` | 上传日志文件路径 | `./logs/upload.log` |
| `--resume <file>` | 从进度文件恢复 | - |
| `--retry-failed <file>` | 重试失败的文件 | - |
| `--dry-run` | 预览模式，不实际上传 | `false` |
| `--update-only` | 仅上传 `img-replace.json` 记载的更新文件 | `false` |
| `--concurrency <n>` | 并发上传数（不超过 `upload.maxConcurrency`） | `upload.maxConcurrency` 或 `1` |
| `-h, --help` | 显示帮助信息 | - |

## 分类标签规则

### 生成格式

```
[[Category:插图]][[Category:扩展id]][[Category:大分类]][[Category:扩展id插图]]
```

### 目录结构示例

```
images/
├── spells/
│   ├── FTD/
│   │   ├── Ashardalon's Stride.webp
│   │   └── Fireball.webp
│   └── Magic Missile.webp
├── monsters/
│   └── MM/
│       └── Dragon.png
└── docker/          # 会被跳过
    └── some-file.png
```

### 转换规则

| 原始路径 | 上传文件名 | 分类标签 |
|----------|------------|----------|
| `spells/FTD/Ashardalon's Stride.webp` | `spells-FTD-Ashardalon's Stride.webp` | `[[Category:插图]][[Category:FTD]][[Category:法术]][[Category:FTD插图]]` |
| `spells/Magic Missile.webp` | `spells-Magic Missile.webp` | `[[Category:插图]][[Category:法术]]` |
| `bestiary/MM/Dragon.png` | `bestiary-MM-Dragon.png` | `[[Category:插图]][[Category:MM]][[Category:怪物]][[Category:MM插图]]` |

### 分类说明

- **`[[Category:插图]]`**：固定分类，所有图片都会添加
- **`[[Category:扩展id]]`**：二级文件夹名称（保留原始大小写），如 `FTD`、`MM`
- **`[[Category:大分类]]`**：一级文件夹对应的中文分类（通过 `categoryMapping` 映射）
- **`[[Category:扩展id插图]]`**：扩展id + "插图"，如 `FTD插图`

## 日志文件

### 进度文件 (`upload-progress.json`)

记录当前任务状态，用于断点续传：

```json
{
  "taskId": "20260112133000",
  "sourceDir": "/path/to/images",
  "totalFiles": 150,
  "pendingFiles": ["..."],
  "completed": ["..."],
  "failed": [{"file": "...", "error": "...", "attempts": 3}]
}
```

### 上传日志 (`logs/upload.log`)

记录所有上传历史，防止重复上传：

```
[2026-01-12T13:30:00.000Z] SUCCESS spells-FTD-Fireball.webp -> dnd5e
[2026-01-12T13:30:01.000Z] SKIPPED spells-FTD-Fireball.webp (Already uploaded)
[2026-01-12T13:30:02.000Z] FAILED  monsters-MM-Dragon.png (Network timeout)
```

## 支持的图片格式

- `.webp`
- `.png`
- `.jpg` / `.jpeg`
- `.gif`
- `.svg`
- `.bmp`
- `.ico`

## 特殊字符处理

图片上传中的文件名清洗规则与页面标题规则不同；页面上传请参见独立文档。

| 字符 | 处理方式 |
|------|----------|
| `/` | 转换为 `-`（目录分隔符） |
| `:` | 转换为 `_` |
| `#`, `?`, `<`, `>`, `\|`, `"`, `\` | 转换为 `_` |
| 空格 | 保留 |
| 单引号 `'` | 保留 |