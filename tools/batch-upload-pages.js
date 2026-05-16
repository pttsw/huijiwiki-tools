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
    concurrency: null,
    extensions: null,
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
    throw new Error('source and manifest are mutually exclusive');
  }

  if (!options.source && !options.manifest && !options.resume && !options.retryFailed) {
    throw new Error('source or manifest is required');
  }
}

function resolveSourcePath(options, config) {
  if (options.source) {
    return options.source;
  }
  
  const rootPath = config?.pageUpload?.rootPath;
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
Batch Upload Pages to HuijiWiki

Usage:
  node tools/batch-upload-pages.js [options]

Options:
  -s, --source <dir>        Source directory containing page files
  -m, --manifest <file>     JSON manifest containing page title/content entries
  -c, --config <file>       Config file path (default: ./config/upload.config.json)
  --progress-file <file>    Progress file path (default: ./page-upload-progress.json)
  --log-file <file>         Upload log file path (default: ./logs/page-upload.log)
  --resume <file>          Resume from a progress file
  --retry-failed <file>   Retry only failed items from a progress file
  --dry-run                 Preview without uploading
  --overwrite               Overwrite existing pages instead of skipping them
  --concurrency <n>         Number of concurrent uploads
  --extensions <list>       Directory-mode file extensions, comma-separated
  -h, --help                Show this help message

Note:
  If --source can be omitted if rootPath is configured in config.
`);
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
    case 'skip':
      console.log(`[${now}] ○ Skipped: ${event.file} (${event.reason})`);
      break;
    case 'error':
      console.log(`[${now}] ✗ Failed: ${event.file} - ${event.message}`);
      break;
    case 'dry-run':
      console.log(`[${now}] [DRY-RUN] ${event.file}`);
      console.log(`          -> ${event.title}`);
      console.log(`          Exists: ${event.exists}`);
      console.log(`          Action: ${event.action}`);
      console.log(`          ContentLength: ${event.contentLength}`);
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

  const exists = wiki ? await pageExists(wiki, normalizedTitle) : false;
  const action = decidePageAction({ exists, overwrite: options.overwrite });

  if (options.dryRun) {
    return {
      success: true,
      dryRun: buildDryRunEvent({
        rawTitle,
        normalizedTitle,
        exists,
        action,
        content: item.content
      })
    };
  }

  if (action === 'skip') {
    return { success: true, skipped: true, message: 'Already exists' };
  }

  try {
    const result = await wiki.editPage(normalizedTitle, item.content, {
      isBot: true,
      summary: item.summary || summary
    });

    if (result.error) {
      return { success: false, error: `${result.error.code}: ${result.error.info}` };
    }

    return { success: true, skipped: false };
  } catch (error) {
    if (error.response && error.response.status === 413) {
      return { success: false, error: 'Request entity too large (413)', statusCode: 413 };
    }
    throw error;
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
  let tooLarge = 0;
  let nextIndex = 0;
  const tooLargeFiles = [];

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
        if (result.statusCode === 413) {
          if (onProgress) {
            onProgress({ type: 'skip', file: normalizedTitle, reason: 'Content too large (413)' });
          }
          tooLarge++;
          tooLargeFiles.push({ title: normalizedTitle, rawTitle: item.rawTitle, contentLength: item.content?.length });
        } else {
          if (onProgress) {
            onProgress({ type: 'error', file: item.title, message: result.error });
          }
          tracker.markFailed(itemId, result.error);
          uploadLog.logFailed(itemId, result.error);
          failed++;
        }
      }
    }
  }

  const workerCount = Math.max(1, concurrency || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { completed, failed, skipped, tooLarge, tooLargeFiles };
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
        excludeParentPagePaths: config?.pageUpload?.excludeParentPagePaths || []
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

  const tracker = new ProgressTracker(options.progressFile);
  const uploadLog = new UploadLog(options.logFile);

  let items = [];
  let sourceDir = null;
  let metadata = { taskType: 'page', sourceType: 'directory' };

  const loaderOptions = {
    extensions: getPageExtensions(options, config),
    skipFolders: config.skipFolders || [],
    enableParentPage: config?.pageUpload?.enableParentPage ?? true,
    excludeParentPagePaths: config?.pageUpload?.excludeParentPagePaths || []
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
    console.log('No pages to process. Exiting.');
    process.exit(0);
  }

  let wiki = null;

  if (!options.dryRun) {
    const HuijiWiki = requireHuijiWiki();
    wiki = new HuijiWiki(config.wiki.prefix, config.wiki.authKey);

    console.log(`Connecting to wiki: ${config.wiki.prefix}`);
    console.log('Logging in...');

    const loginSuccess = await loginWithDiagnostics(wiki, config.auth.username, config.auth.password, {
      logRawResponse: message => console.log(message)
    });
    if (!loginSuccess) {
      throw new Error(`Login failed: ${wiki.getLastErrorMessage()}`);
    }
  } else {
    console.log('[DRY-RUN MODE] No actual page uploads will be performed');
  }

  const result = await processPageQueue(wiki, items, config, tracker, uploadLog, {
    concurrency: options.concurrency,
    dryRun: options.dryRun,
    overwrite: options.overwrite,
    onProgress: printProgress
  });

  console.log('\n========== Page Upload Complete ==========');
  console.log(`Completed: ${result.completed}`);
  console.log(`Skipped: ${result.skipped}`);
  console.log(`Failed: ${result.failed}`);
  
  if (result.tooLarge && result.tooLargeFiles.length > 0) {
    console.log(`\n⚠️  Too Large (skipped): ${result.tooLarge}`);
    console.log('\nFiles skipped due to size limit (413):');
    for (const file of result.tooLargeFiles) {
      console.log(`  - ${file.title} (${(file.contentLength / 1024).toFixed(1)} KB)`);
    }
    console.log('\nPlease manually upload these files or reduce their size.');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Unexpected error:', error.message);
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
