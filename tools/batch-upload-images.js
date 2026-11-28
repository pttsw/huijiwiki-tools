#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { ProgressTracker, UploadLog } = require('../lib/progress-tracker');
const { loginWithDiagnostics } = require('../lib/wiki-login');
const {
  collectImages,
  transformPath,
  processUploadQueue
} = require('../lib/image-uploader');

function parseArgs(args) {
  const options = {
    source: null,
    config: './config/upload.config.json',
    progressFile: './upload-progress.json',
    logFile: './logs/upload.log',
    resume: null,
    retryFailed: null,
    dryRun: false,
    updateOnly: false,
    concurrency: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '-s':
      case '--source':
        options.source = next;
        i++;
        break;
      case '-c':
      case '--config':
        options.config = next;
        i++;
        break;
      case '--progress-file':
        options.progressFile = next;
        i++;
        break;
      case '--log-file':
        options.logFile = next;
        i++;
        break;
      case '--resume':
        options.resume = next;
        i++;
        break;
      case '--retry-failed':
        options.retryFailed = next;
        i++;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--update-only':
        options.updateOnly = true;
        break;
      case '--concurrency':
        {
          const parsed = Number.parseInt(next, 10);
          options.concurrency = Number.isFinite(parsed) ? parsed : null;
        }
        i++;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
    }
  }

  return options;
}

function normalizeConcurrency(value) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : null;
}

function normalizePathForMatch(value) {
  return (value || '').replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

const HOMEBREW_IMG_ROOT = 'd:/homebrew-img';
const IMG_REPLACE_FILE = 'img-replace.json';

/**
 * 读取 config/upload.config.output.json 中 pageUpload.rootPath 下的
 * non-partnered-sources.json，返回其中记载的非合作方来源列表
 * @returns {Array<string>} 非合作方来源列表
 */
function loadNonPartneredSources() {
  const outputConfigPath = path.join(__dirname, '..', 'config', 'upload.config.output.json');
  if (!fs.existsSync(outputConfigPath)) {
    return [];
  }
  try {
    const outputConfig = JSON.parse(fs.readFileSync(outputConfigPath, 'utf8'));
    const rootPath = outputConfig?.pageUpload?.rootPath;
    if (!rootPath) {
      return [];
    }
    const nonPartneredPath = path.join(rootPath, 'non-partnered-sources.json');
    if (!fs.existsSync(nonPartneredPath)) {
      return [];
    }
    const data = JSON.parse(fs.readFileSync(nonPartneredPath, 'utf8'));
    const sources = Array.isArray(data?.sources) ? data.sources.filter(s => typeof s === 'string' && s) : [];
    if (sources.length > 0) {
      console.log(`[非合作方资源] 从 ${nonPartneredPath} 加载 ${sources.length} 个来源，将跳过这些来源的图片`);
    }
    return sources;
  } catch (error) {
    console.warn(`读取 non-partnered-sources.json 失败: ${error.message}`);
    return [];
  }
}

/**
 * 仅上传已更新文件模式（--update-only）：
 * 扫描指定目录第一层是否有 img-replace.json。
 * 有则只上传其中 folders（整个文件夹内的图片）与 files（个别文件）记载的更新文件。
 * @param {Object} options - 命令行选项（含 source）
 * @returns {{sourceDir: string, images: Array<{absolutePath: string, relativePath: string}>}}
 */
function loadUpdateImages(options) {
  const sourceArg = options.source;
  const replaceFilePath = path.join(sourceArg, IMG_REPLACE_FILE);

  if (!fs.existsSync(replaceFilePath)) {
    throw new Error(`在指定目录第一层未找到 ${IMG_REPLACE_FILE}: ${replaceFilePath}`);
  }

  let jsonData;
  try {
    jsonData = JSON.parse(fs.readFileSync(replaceFilePath, 'utf8'));
  } catch (error) {
    throw new Error(`读取 ${replaceFilePath} 失败: ${error.message}`);
  }

  const folders = Array.isArray(jsonData.folders)
    ? jsonData.folders.filter(s => typeof s === 'string' && s.trim())
    : [];
  const files = Array.isArray(jsonData.files)
    ? jsonData.files.filter(s => typeof s === 'string' && s.trim())
    : [];

  if (folders.length === 0 && files.length === 0) {
    throw new Error(`[update-only 模式] ${replaceFilePath} 中的 folders 与 files 均为空`);
  }

  // 解析图片根目录（与普通模式相同的 homebrew-img 特殊处理）
  let imageRoot = sourceArg;
  if (normalizePathForMatch(sourceArg) === HOMEBREW_IMG_ROOT) {
    const imgDir = path.join(sourceArg, 'img');
    if (fs.existsSync(imgDir)) {
      imageRoot = imgDir;
      console.log(`检测到 homebrew-img 目录，图片源目录: ${imgDir}`);
    }
  }

  const images = [];
  const seen = new Set();

  function addImage(absolutePath, relativePath) {
    const normalizedRel = relativePath.replace(/\\/g, '/');
    if (seen.has(normalizedRel)) {
      return;
    }
    seen.add(normalizedRel);
    images.push({ absolutePath, relativePath: normalizedRel });
  }

  // 1) folders：整文件夹内的所有受支持图片（视为新增或全部有更新）
  for (const folder of folders) {
    const folderFull = path.join(imageRoot, folder);
    if (!fs.existsSync(folderFull) || !fs.statSync(folderFull).isDirectory()) {
      console.warn(`[update-only 模式] 警告: 记录中的文件夹不存在，已跳过: ${folder}`);
      continue;
    }
    const folderImages = collectImages(folderFull, {});
    if (folderImages.length === 0) {
      console.warn(`[update-only 模式] 警告: 记录中的文件夹内没有受支持的图片: ${folder}`);
    }
    for (const img of folderImages) {
      addImage(img.absolutePath, `${folder}/${img.relativePath}`);
    }
  }

  // 2) files：单独列出的更新图片文件
  for (const relativeFile of files) {
    const normalizedFile = relativeFile.replace(/\\/g, '/').replace(/^\/+/, '');
    const absolutePath = path.join(imageRoot, normalizedFile);
    if (!fs.existsSync(absolutePath)) {
      console.warn(`[update-only 模式] 警告: 记录中的文件不存在，已跳过: ${normalizedFile}`);
      continue;
    }
    addImage(absolutePath, normalizedFile);
  }

  return { sourceDir: imageRoot, images };
}

function resolveConcurrency(requestedConcurrency, config) {
  const normalizedRequested = normalizeConcurrency(requestedConcurrency);
  const configMax = normalizeConcurrency(
    config?.upload?.maxConcurrency ?? config?.upload?.concurrency
  );

  if (normalizedRequested) {
    return configMax ? Math.min(normalizedRequested, configMax) : normalizedRequested;
  }

  return configMax ?? 1;
}

function printHelp() {
  console.log(`
Batch Upload Images to HuijiWiki

Usage:
  node tools/batch-upload-images.js [options]

Options:
  -s, --source <dir>        Source directory containing images (required for new task)
  -c, --config <file>       Config file path (default: ./config/upload.config.json)
  --progress-file <file>    Progress file path (default: ./upload-progress.json)
  --log-file <file>         Upload log file path (default: ./logs/upload.log)
  --resume <file>           Resume from a progress file
  --retry-failed <file>     Retry only failed files from a progress file
  --dry-run                 Preview without uploading
  --update-only             Only upload updated files recorded in img-replace.json
  --concurrency <n>         Number of concurrent uploads (default: config upload.maxConcurrency or 1)
  -h, --help                Show this help message

Examples:
  # New upload task
  node tools/batch-upload-images.js -s ./images -c ./config/upload.config.json

  # Dry run to preview
  node tools/batch-upload-images.js -s ./images --dry-run

  # Only upload updated files recorded in <dir>/img-replace.json
  node tools/batch-upload-images.js -s ./images --update-only

  # Resume interrupted task
  node tools/batch-upload-images.js --resume ./upload-progress.json

  # Retry failed uploads
  node tools/batch-upload-images.js --retry-failed ./upload-progress.json
`);
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const content = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(content);
  
  // 尝试从 upload.auth.json 加载默认认证配置
  const authConfigPath = path.join(path.dirname(configPath), 'upload.auth.json');
  if (fs.existsSync(authConfigPath)) {
    try {
      const authConfig = JSON.parse(fs.readFileSync(authConfigPath, 'utf8'));

      // wiki 部分为默认值时替换
      const isDefaultWikiConfig = !config.wiki ||
                                  config.wiki?.prefix === 'dnd5e' ||
                                  config.wiki?.authKey === 'your-auth-key-here' ||
                                  !config.wiki?.prefix ||
                                  !config.wiki?.authKey;
      if (isDefaultWikiConfig && authConfig.wiki) {
        config.wiki = { ...authConfig.wiki, ...config.wiki };
      }

      // auth 部分为默认值（占位符、缺失或为空）时替换
      const auth = config.auth || {};
      const isDefaultAuthConfig = !auth.username ||
                                  !auth.password ||
                                  auth.username?.includes('YourUsername@BotName') ||
                                  auth.password === 'your-bot-password';
      if (isDefaultAuthConfig && authConfig.auth) {
        config.auth = { ...authConfig.auth, ...config.auth };
      }
    } catch (error) {
      console.warn(`读取认证配置文件时出错: ${error.message}`);
    }
  }

  return config;
}

function printProgress(event) {
  const now = new Date().toLocaleTimeString();
  switch (event.type) {
    case 'uploading':
      console.log(`[${now}] Uploading: ${event.file}`);
      break;
    case 'success':
      console.log(`[${now}] ✓ Success: ${event.file}`);
      break;
    case 'warning':
      console.log(`[${now}] ⚠ Warning: ${event.file} - ${event.message}`);
      break;
    case 'skip':
      console.log(`[${now}] ○ Skipped: ${event.file} (${event.reason})`);
      break;
    case 'error':
      console.log(`[${now}] ✗ Failed: ${event.file} - ${event.message}`);
      break;
    case 'dry-run':
      console.log(`[${now}] [DRY-RUN] ${event.file}`);
      console.log(`          -> ${event.sanitizedName}`);
      console.log(`          FilePage: ${event.filePageTitle}`);
      console.log(`          Categories: ${JSON.stringify(event.categories)}`);
      console.log(`          WikiText: ${event.wikiText}`);
      break;
  }
}

function requireHuijiWiki() {
  try {
    return require('huijiwiki-api').HuijiWiki;
  } catch (error) {
    throw new Error(
      'Missing dependency "huijiwiki-api". Run npm install before actual uploads.'
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  let config;
  try {
    config = loadConfig(options.config);
  } catch (err) {
    console.error(`Error loading config: ${err.message}`);
    process.exit(1);
  }

  options.concurrency = resolveConcurrency(options.concurrency, config);

  const tracker = new ProgressTracker(options.progressFile);
  const uploadLog = new UploadLog(options.logFile);

  let filesToProcess = [];
  let updateImages = null;
  let sourceDir = options.source;

  if (options.resume) {
    const data = tracker.load();
    if (!data) {
      console.error(`Progress file not found: ${options.resume}`);
      process.exit(1);
    }
    sourceDir = data.sourceDir;
    filesToProcess = tracker.getPendingFiles();
    console.log(`Resuming task ${data.taskId}: ${filesToProcess.length} files pending`);
  } else if (options.retryFailed) {
    tracker.filePath = options.retryFailed;
    const data = tracker.load();
    if (!data) {
      console.error(`Progress file not found: ${options.retryFailed}`);
      process.exit(1);
    }
    sourceDir = data.sourceDir;
    filesToProcess = tracker.getFailedFiles();
    for (const file of filesToProcess) {
      if (!data.pendingFiles.includes(file)) {
        data.pendingFiles.push(file);
      }
    }
    data.failed = [];
    tracker.save();
    console.log(`Retrying ${filesToProcess.length} failed files from task ${data.taskId}`);
  } else if (options.updateOnly) {
    if (!options.source) {
      console.error('Error: --source is required for --update-only mode');
      printHelp();
      process.exit(1);
    }

    if (!fs.existsSync(options.source)) {
      console.error(`Source directory not found: ${options.source}`);
      process.exit(1);
    }

    let updateResult;
    try {
      updateResult = loadUpdateImages(options);
    } catch (err) {
      console.error(`[update-only 模式] ${err.message}`);
      uploadLog.logError(err.message);
      process.exit(1);
    }

    if (updateResult.images.length === 0) {
      console.log(`[update-only 模式] ${IMG_REPLACE_FILE} 中没有记载可上传的文件。`);
      process.exit(0);
    }

    updateImages = updateResult;
    const uniqueTargets = [];
    const seen = new Set();
    for (const img of updateResult.images) {
      const target = transformPath(img.relativePath);
      if (!seen.has(target)) {
        seen.add(target);
        uniqueTargets.push(target);
      }
    }
    filesToProcess = uniqueTargets;
    sourceDir = updateResult.sourceDir;

    tracker.init(sourceDir, filesToProcess, {
      taskType: 'image',
      sourceType: 'update-only'
    });
    console.log(`[update-only 模式] 从 ${path.join(options.source, IMG_REPLACE_FILE)} 加载了 ${filesToProcess.length} 个待更新文件`);
  } else {
    if (!options.source) {
      console.error('Error: --source is required for new upload task');
      printHelp();
      process.exit(1);
    }

    if (!fs.existsSync(options.source)) {
      console.error(`Source directory not found: ${options.source}`);
      process.exit(1);
    }

    console.log(`Scanning source directory: ${options.source}`);
    const skipConfig = config.skip || {};
    const skipFolders = [...(config.skipFolders || []), ...(skipConfig.folders || [])];
    const skipFiles = skipConfig.files || [];

    // 上传路径为 D:\homebrew-img 时，实际图片位于其 img 子目录，
    // 同时读取 output 目录中 non-partnered-sources.json 记载的非合作方来源并跳过
    let scanSource = options.source;
    if (normalizePathForMatch(options.source) === HOMEBREW_IMG_ROOT) {
      const imgDir = path.join(options.source, 'img');
      if (fs.existsSync(imgDir)) {
        scanSource = imgDir;
        console.log(`检测到 homebrew-img 目录，图片源目录: ${imgDir}`);
      }
      const nonPartnered = loadNonPartneredSources();
      for (const src of nonPartnered) {
        if (!skipFolders.some(f => normalizePathForMatch(f) === normalizePathForMatch(src))) {
          skipFolders.push(src);
        }
      }
    }

    if (skipFolders.length > 0) {
      console.log(`Skipping folders: ${skipFolders.join(', ')}`);
    }
    if (skipFiles.length > 0) {
      console.log(`Skipping files: ${skipFiles.join(', ')}`);
    }
    const skipOptions = { folders: skipFolders, files: skipFiles };
    const images = collectImages(scanSource, skipOptions);
    console.log(`Found ${images.length} images`);

    if (images.length === 0) {
      console.log('No images found. Exiting.');
      process.exit(0);
    }

    filesToProcess = images.map(img => transformPath(img.relativePath));

    const alreadyUploaded = filesToProcess.filter(f => uploadLog.isUploaded(f));
    if (alreadyUploaded.length > 0) {
      console.log(`${alreadyUploaded.length} files already uploaded (will be skipped)`);
      filesToProcess = filesToProcess.filter(f => !uploadLog.isUploaded(f));
    }

    tracker.init(scanSource, filesToProcess, {
      taskType: 'image',
      sourceType: 'directory'
    });
    console.log(`Task ${tracker.data.taskId} created: ${filesToProcess.length} files to upload`);
    sourceDir = scanSource;
  }

  if (filesToProcess.length === 0) {
    console.log('No files to process. Exiting.');
    process.exit(0);
  }

  let wiki = null;

  if (!options.dryRun) {
    const HuijiWiki = requireHuijiWiki();
    console.log(`Connecting to wiki: ${config.wiki.prefix}`);
    wiki = new HuijiWiki(config.wiki.prefix, config.wiki.authKey);

    console.log('Logging in...');
    const loginSuccess = await loginWithDiagnostics(wiki, config.auth.username, config.auth.password, {
      logRawResponse: message => console.log(message)
    });

    if (!loginSuccess) {
      console.error(`Login failed: ${wiki.getLastErrorMessage()}`);
      process.exit(1);
    }
    console.log('Login successful');
  } else {
    console.log('[DRY-RUN MODE] No actual uploads will be performed');
  }

  console.log(`\nStarting upload (concurrency: ${options.concurrency})...\n`);

  const startTime = Date.now();
  const result = await processUploadQueue(
    wiki,
    filesToProcess,
    sourceDir,
    config,
    tracker,
    uploadLog,
    {
      concurrency: options.concurrency,
      dryRun: options.dryRun,
      onProgress: printProgress,
      ...(options.updateOnly ? { imageFiles: updateImages.images, skipUploaded: false } : {})
    }
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n========== Upload Complete ==========');
  console.log(`Total time: ${elapsed}s`);
  console.log(`Completed: ${result.completed}`);
  console.log(`Skipped: ${result.skipped}`);
  console.log(`Failed: ${result.failed}`);

  if (result.failed > 0) {
    console.log(`\nFailed files are recorded in: ${options.progressFile}`);
    console.log('Run with --retry-failed to retry them.');
  }

  const stats = tracker.getStats();
  if (stats && stats.pending === 0 && stats.failed === 0) {
    console.log('\nAll files processed successfully!');
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});