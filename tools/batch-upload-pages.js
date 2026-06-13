#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { ProgressTracker, UploadLog } = require('../lib/progress-tracker');
const { loadPagesFromDirectory, loadPagesFromManifest } = require('../lib/page-source-loader');
const { normalizePageTitle } = require('../lib/page-title-utils');
const { decidePageAction, buildDryRunEvent } = require('../lib/page-upload-runner');
const { loginWithDiagnostics } = require('../lib/wiki-login');

function parseArgs(args) {
  const options = {
    source: null,
    manifest: null,
    config: './config/upload.config.json',
    progressFile: './page-upload-progress.json',
    logFile: './logs/page-upload.log',
    resume: null,
    retryFailed: null,
    dryRun: false,
    overwrite: false,
    skipExisting: false,
    concurrency: null,
    extensions: null,
    file: null,
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
      case '-m':
      case '--manifest':
        options.manifest = next;
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
      case '--overwrite':
        options.overwrite = true;
        break;
      case '--concurrency':
        {
          const parsed = Number.parseInt(next, 10);
          options.concurrency = Number.isFinite(parsed) ? parsed : null;
        }
        i++;
        break;
      case '--extensions':
        options.extensions = next
          ? next.split(',').map(item => item.trim()).filter(Boolean)
          : null;
        i++;
        break;
      case '--file':
        options.file = next;
        i++;
        break;
      case '-f':
        options.file = next;
        i++;
        break;
      case '--skip-existing':
        options.skipExisting = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
    }
  }

  return options;
}

function validateInputMode(options) {
  if (options.source && options.manifest) {
    throw new Error('source 和 manifest 参数不能同时使用');
  }

  if (!options.source && !options.manifest && !options.resume && !options.retryFailed && !options.file) {
    throw new Error('需要提供 source、manifest 或 file 参数');
  }
}

function resolveSourcePath(options, config) {
  if (options.source) {
    return options.source;
  }
  
  const rootPath = config?.pageUpload?.rootPath;
  
  if (options.file) {
    if (!rootPath || !fs.existsSync(rootPath)) {
      throw new Error(`根路径未配置或不存在。无法使用 --file 参数。`);
    }
    
    const targetFolderPath = path.join(rootPath, options.file);
    if (!fs.existsSync(targetFolderPath)) {
      throw new Error(`文件夹 "${options.file}" 在根路径 "${rootPath}" 中不存在。`);
    }
    
    if (!fs.statSync(targetFolderPath).isDirectory()) {
      throw new Error(`"${options.file}" 不是一个目录。`);
    }
    
    return rootPath;
  }
  
  if (rootPath && fs.existsSync(rootPath)) {
    return rootPath;
  }
  
  return null;
}

function normalizeConcurrency(value) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : null;
}

function resolveConcurrency(requestedConcurrency, config) {
  const normalizedRequested = normalizeConcurrency(requestedConcurrency);
  const configMax = normalizeConcurrency(
    config?.pageUpload?.maxConcurrency ??
    config?.upload?.maxConcurrency ??
    config?.upload?.concurrency
  );

  if (normalizedRequested) {
    return configMax ? Math.min(normalizedRequested, configMax) : normalizedRequested;
  }

  return configMax ?? 1;
}

function getPageExtensions(options, config) {
  if (options.extensions && options.extensions.length > 0) {
    return options.extensions;
  }

  return config?.pageUpload?.defaultExtensions || ['.txt', '.wiki', '.wikitext', '.md'];
}

function printHelp() {
  console.log(`
批量上传页面到慧技Wiki

用法:
  node tools/batch-upload-pages.js [选项]

选项:
  -s, --source <目录>        目录文件模式输入目录
  -m, --manifest <文件>      JSON清单模式输入文件
  -c, --config <文件>        配置文件路径（默认: ./config/upload.config.json）
  --progress-file <文件>       进度文件路径（默认: ./page-upload-progress.json）
  --log-file <文件>           上传日志文件路径（默认: ./logs/page-upload.log）
  --resume <文件>             从进度文件恢复上传
  --retry-failed <文件>      重试失败的文件
  --dry-run                  预览模式，不实际执行上传
  --overwrite                覆盖已存在的页面（默认行为）
  --skip-existing            跳过已存在的页面而不是覆盖
  --concurrency <数量>        并发上传数量
  --extensions <列表>          目录模式的文件扩展名，逗号分隔
  --file <文件夹>             只上传指定文件夹的文件（需要配置rootPath）
  -f <文件夹>                --file 的简写形式
  -h, --help                 显示帮助信息

说明:
  如果配置了 rootPath，可以省略 --source 参数。
  使用 --file 可以只上传指定文件夹的文件。如果文件夹不存在，会报错。
  默认行为是覆盖已存在的页面。如需跳过，使用 --skip-existing 参数。
`);
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`配置文件未找到: ${configPath}`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  // 尝试从 upload.auth.json 加载默认认证配置
  const authConfigPath = path.join(path.dirname(configPath), 'upload.auth.json');
  if (fs.existsSync(authConfigPath)) {
    try {
      const authConfig = JSON.parse(fs.readFileSync(authConfigPath, 'utf8'));
      
      // 检查是否是默认值，如果是，则从 authConfig 替换
      const isDefaultWikiConfig = config.wiki?.prefix === 'dnd5e' || 
                                  config.wiki?.authKey === 'your-auth-key-here';
      const isDefaultAuthConfig = config.auth?.username?.includes('YourUsername@BotName') || 
                                  config.auth?.password === 'your-bot-password';
      
      if (isDefaultWikiConfig && authConfig.wiki) {
        config.wiki = authConfig.wiki;
      }
      if (isDefaultAuthConfig && authConfig.auth) {
        config.auth = authConfig.auth;
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
      console.log(`[${now}] 正在上传: ${event.file}`);
      break;
    case 'success':
      console.log(`[${now}] ✓ 成功: ${event.file}`);
      break;
    case 'skip':
      console.log(`[${now}] ○ 跳过: ${event.file} (${event.reason})`);
      break;
    case 'error':
      console.log(`[${now}] ✗ 失败: ${event.file} - ${event.message}`);
      break;
    case 'dry-run':
      console.log(`[${now}] [预览模式] ${event.file}`);
      console.log(`          -> ${event.title}`);
      console.log(`          已存在: ${event.exists}`);
      console.log(`          操作: ${event.action}`);
      console.log(`          内容长度: ${event.contentLength}`);
      if (event.isPublicationHomePage) {
        console.log(`          出版物首页: 是`);
      }
      break;
  }
}

function requireHuijiWiki() {
  try {
    return require('huijiwiki-api').HuijiWiki;
  } catch (error) {
    throw new Error(
      '缺少依赖 "huijiwiki-api"。请在执行上传前运行 npm install。'
    );
  }
}

async function pageExists(wiki, title) {
  const page = await wiki.getPageRawTextByTitle(title);
  return Boolean(page && page.pageTitle);
}

async function uploadSinglePage(wiki, item, options, summary) {
  const normalizedTitle = normalizePageTitle(item.title);
  const rawTitle = item.rawTitle || item.title;

  if (!normalizedTitle) {
    return { success: false, error: 'Empty title after normalization' };
  }

  try {
    const exists = wiki ? await pageExists(wiki, normalizedTitle) : false;
    const action = decidePageAction({ 
      exists, 
      overwrite: options.overwrite,
      isPublicationHomePage: item.isPublicationHomePage 
    });

    if (options.dryRun) {
      return {
        success: true,
        dryRun: buildDryRunEvent({
          rawTitle,
          normalizedTitle,
          exists,
          action,
          content: item.content,
          isPublicationHomePage: item.isPublicationHomePage
        })
      };
    }

    if (action === 'skip') {
      let message = 'Already exists';
      if (item.isPublicationHomePage && exists) {
        message = 'Already exists (Publication Home Page, always skip)';
      }
      return { success: true, skipped: true, message };
    }

    const result = await wiki.editPage(normalizedTitle, item.content, {
      isBot: true,
      summary: item.summary || summary
    });

    if (result.error) {
      return { success: false, error: `${result.error.code}: ${result.error.info}` };
    }

    return { success: true, skipped: false };
  } catch (error) {
    let errorMessage = String(error.message || error);
    let statusCode = null;

    if (error.response) {
      statusCode = error.response.status;
      errorMessage = `HTTP ${statusCode}: ${error.response.statusText || error.message}`;
      
      if (error.response.data) {
        if (error.response.data.error) {
          errorMessage = `${error.response.data.error.code}: ${error.response.data.error.info}`;
        } else if (typeof error.response.data.message) {
          errorMessage = error.response.data.message;
        }
      }
    } else if (error.code) {
      errorMessage = `Network error (${error.code}): ${error.message}`;
    }

    return { success: false, error: errorMessage, statusCode };
  }
}

function createItemMap(items) {
  const map = new Map();
  for (const item of items) {
    map.set(item.itemId, item);
  }
  return map;
}

async function processPageQueue(wiki, items, config, tracker, uploadLog, options = {}) {
  const { concurrency, dryRun = false, overwrite = false, onProgress } = options;
  const summary = config?.pageUpload?.comment || 'Batch page upload';
  const wikiPrefix = config?.wiki?.prefix || 'unknown';

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let nextIndex = 0;
  
  // 收集所有失败和被跳过的文件信息（除了"已存在"的跳过情况
  const failedFiles = [];
  const skippedFiles = [];

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }

      const item = items[index];
      const itemId = item.itemId;
      const normalizedTitle = normalizePageTitle(item.title);

      if (uploadLog.isUploaded(itemId) && !overwrite) {
        if (onProgress) {
          onProgress({ type: 'skip', file: normalizedTitle, reason: 'Already uploaded' });
        }
        tracker.markCompleted(itemId);
        skipped++;
        continue;
      }

      if (onProgress && !dryRun) {
        onProgress({ type: 'uploading', file: item.title });
      }

      const result = await uploadSinglePage(wiki, item, { dryRun, overwrite }, summary);

      if (result.success) {
        if (result.dryRun) {
          if (onProgress) {
            onProgress(result.dryRun);
          }
          tracker.markCompleted(itemId);
          completed++;
          continue;
        }

        if (result.skipped) {
          if (onProgress) {
            onProgress({ type: 'skip', file: normalizedTitle, reason: result.message });
          }
          skipped++;
        } else {
          if (onProgress) {
            onProgress({ type: 'success', file: normalizedTitle });
          }
          completed++;
        }

        tracker.markCompleted(itemId);
        uploadLog.logSuccess(itemId, wikiPrefix);
      } else {
        // 所有失败都被归类到 failed 或 skipped 中
        if (onProgress) {
          onProgress({ type: 'error', file: normalizedTitle, message: result.error });
        }
        
        // 根据不同的错误类型分类收集
        const fileInfo = { 
          title: normalizedTitle, 
          rawTitle: item.rawTitle || item.title, 
          contentLength: item.content?.length,
          error: result.error,
          statusCode: result.statusCode
        };
        
        if (result.statusCode === 413) {
          skippedFiles.push({ 
            ...fileInfo, 
            category: 'Too large'
          });
        } else {
          failedFiles.push({ 
            ...fileInfo, 
            category: 'Failed'
          });
          tracker.markFailed(itemId, result.error);
          uploadLog.logFailed(itemId, result.error);
          failed++;
        }
      }
    }
  }

  const workerCount = Math.max(1, concurrency || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { 
    completed, 
    failed, 
    skipped, 
    failedFiles,
    skippedFiles
  };
}

function loadItemsForNewTask(options, config) {
  let actualSource = resolveSourcePath(options, config);
  
  if (actualSource) {
    if (!fs.existsSync(actualSource)) {
      throw new Error(`Source directory not found: ${actualSource}`);
    }

    return {
      items: loadPagesFromDirectory(actualSource, {
        extensions: getPageExtensions(options, config),
        skipFolders: config.skipFolders || [],
        enableParentPage: config?.pageUpload?.enableParentPage ?? true,
        excludeParentPagePaths: config?.pageUpload?.excludeParentPagePaths || [],
        filterFolder: options.file || null
      }),
      sourceDir: actualSource,
      metadata: {
        taskType: 'page',
        sourceType: 'directory'
      }
    };
  }

  if (!fs.existsSync(options.manifest)) {
    throw new Error(`Manifest file not found: ${options.manifest}`);
  }

  return {
    items: loadPagesFromManifest(options.manifest),
    sourceDir: path.dirname(path.resolve(options.manifest)),
    metadata: {
      taskType: 'page',
      sourceType: 'manifest',
      manifestPath: path.resolve(options.manifest)
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const config = loadConfig(options.config);
  
  if (!options.source && !options.manifest && !options.resume && !options.retryFailed) {
    options.source = resolveSourcePath(options, config);
  }
  
  validateInputMode(options);
  
  options.concurrency = resolveConcurrency(options.concurrency, config);
  
  // 如果指定了 --skip-existing，则强制设置为跳过
  if (options.skipExisting) {
    options.overwrite = false;
  } else if (options.overwrite === false && config?.pageUpload?.skipExisting !== undefined) {
    // 否则，使用配置文件中的值（skipExisting 为 false 时表示要覆盖）
    options.overwrite = !config.pageUpload.skipExisting;
  }

  const tracker = new ProgressTracker(options.progressFile);
  const uploadLog = new UploadLog(options.logFile);

  let items = [];
  let sourceDir = null;
  let metadata = { taskType: 'page', sourceType: 'directory' };

  const loaderOptions = {
    extensions: getPageExtensions(options, config),
    skipFolders: config.skipFolders || [],
    enableParentPage: config?.pageUpload?.enableParentPage ?? true,
    excludeParentPagePaths: config?.pageUpload?.excludeParentPagePaths || [],
    filterFolder: options.file || null
  };

  if (options.resume) {
    tracker.filePath = options.resume;
    const data = tracker.load();
    if (!data) {
      throw new Error(`Progress file not found: ${options.resume}`);
    }

    sourceDir = data.sourceDir;
    metadata = {
      taskType: data.taskType || 'page',
      sourceType: data.sourceType || 'directory',
      manifestPath: data.manifestPath || null
    };

    const loaded = data.sourceType === 'manifest'
      ? loadPagesFromManifest(data.manifestPath)
      : loadPagesFromDirectory(sourceDir, loaderOptions);
    const itemMap = createItemMap(loaded);
    items = tracker.getPendingFiles().map(itemId => itemMap.get(itemId)).filter(Boolean);
  } else if (options.retryFailed) {
    tracker.filePath = options.retryFailed;
    const data = tracker.load();
    if (!data) {
      throw new Error(`Progress file not found: ${options.retryFailed}`);
    }

    sourceDir = data.sourceDir;
    metadata = {
      taskType: data.taskType || 'page',
      sourceType: data.sourceType || 'directory',
      manifestPath: data.manifestPath || null
    };

    const loaded = data.sourceType === 'manifest'
      ? loadPagesFromManifest(data.manifestPath)
      : loadPagesFromDirectory(sourceDir, loaderOptions);
    const itemMap = createItemMap(loaded);
    items = tracker.getFailedFiles().map(itemId => itemMap.get(itemId)).filter(Boolean);
    data.pendingFiles = items.map(item => item.itemId);
    data.failed = [];
    tracker.save();
  } else {
    const loaded = loadItemsForNewTask(options, config);
    items = loaded.items;
    sourceDir = loaded.sourceDir;
    metadata = loaded.metadata;
    tracker.init(sourceDir, items.map(item => item.itemId), metadata);
  }

  if (items.length === 0) {
    console.log('没有页面需要处理。退出。');
    process.exit(0);
  }

  let wiki = null;

  if (!options.dryRun) {
    const HuijiWiki = requireHuijiWiki();
    wiki = new HuijiWiki(config.wiki.prefix, config.wiki.authKey);

    console.log(`正在连接到 Wiki: ${config.wiki.prefix}`);
    console.log('正在登录...');

    const loginSuccess = await loginWithDiagnostics(wiki, config.auth.username, config.auth.password, {
      logRawResponse: message => console.log(message)
    });
    if (!loginSuccess) {
      throw new Error(`登录失败: ${wiki.getLastErrorMessage()}`);
    }
  } else {
    console.log('[预览模式] 不会实际执行上传操作');
  }

  const result = await processPageQueue(wiki, items, config, tracker, uploadLog, {
    concurrency: options.concurrency,
    dryRun: options.dryRun,
    overwrite: options.overwrite,
    onProgress: printProgress
  });

  console.log('\n========== 页面上传完成 ==========');
  console.log(`完成: ${result.completed}`);
  console.log(`跳过: ${result.skipped}`);
  console.log(`失败: ${result.failed}`);
  
  const hasErrors = (result.failedFiles && result.failedFiles.length > 0) || 
                    (result.skippedFiles && result.skippedFiles.length > 0);
  
  if (!hasErrors) {
    console.log('\n✅ 所有文件上传成功！');
    return;
  }
  
  console.log('\n──────────────────────────────────────────────');
  console.log('❌ 未上传文件报告');
  console.log('──────────────────────────────────────────────');
  
  if (result.skippedFiles && result.skippedFiles.length > 0) {
    console.log(`\n⚠️  跳过的文件 (${result.skippedFiles.length}):`);
    
    const tooLargeFiles = result.skippedFiles.filter(f => f.category === 'Too large');
    if (tooLargeFiles.length > 0) {
      console.log(`  -- 内容太大 (413) --`);
      for (const file of tooLargeFiles) {
        const sizeStr = file.contentLength ? `(${Math.round(file.contentLength / 1024)} KB)` : '';
        console.log(`  • ${file.title} ${sizeStr}`);
        console.log(`    原因: ${file.error}`);
      }
    }
    
    const otherSkipped = result.skippedFiles.filter(f => f.category !== 'Too large');
    if (otherSkipped.length > 0) {
      console.log(`  -- 其他跳过 --`);
      for (const file of otherSkipped) {
        const sizeStr = file.contentLength ? `(${Math.round(file.contentLength / 1024)} KB)` : '';
        console.log(`  • ${file.title} ${sizeStr}`);
        console.log(`    原因: ${file.error}`);
      }
    }
  }
  
  // 处理失败的文件
  if (result.failedFiles && result.failedFiles.length > 0) {
    console.log(`\n❌ 失败的文件 (${result.failedFiles.length}):`);
    
    const errorGroups = {};
    for (const file of result.failedFiles) {
      const key = file.error.substring(0, 60);
      if (!errorGroups[key]) {
        errorGroups[key] = {
          error: file.error,
          files: []
        };
      }
      errorGroups[key].files.push(file);
    }
    
    for (const [key, group] of Object.entries(errorGroups)) {
      console.log(`  -- ${group.error.substring(0, 60)}${group.error.length > 60 ? '...' : ''} --`);
      for (const file of group.files) {
        const sizeStr = file.contentLength ? `(${Math.round(file.contentLength / 1024)} KB)` : '';
        console.log(`  • ${file.title} ${sizeStr}`);
      }
    }
    
    console.log('\n详细错误列表:');
    for (const file of result.failedFiles) {
      const sizeStr = file.contentLength ? `(${Math.round(file.contentLength / 1024)} KB)` : '';
      console.log(`  • ${file.title} ${sizeStr}`);
      console.log(`    错误: ${file.error}`);
    }
  }
  
  console.log('\n──────────────────────────────────────────────');
  const totalUnuploaded = (result.failedFiles?.length || 0) + (result.skippedFiles?.length || 0);
  if (totalUnuploaded > 0) {
    console.log(`📝 共 ${totalUnuploaded} 个文件未成功上传。`);
    console.log('💡 你可以使用 --retry-failed 重试失败的文件。');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('意外错误:', error.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  validateInputMode,
  resolveConcurrency,
  processPageQueue,
  uploadSinglePage
};
