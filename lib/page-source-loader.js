const fs = require('fs');
const path = require('path');
const {
  derivePageTitleFromRelativePath,
  normalizePageTitle
} = require('./page-title-utils');

function shouldExcludeFromParentPage(relativePath, excludePaths) {
  if (!excludePaths || !Array.isArray(excludePaths)) {
    return false;
  }
  const normalizedRelPath = relativePath.replace(/\\/g, '/');
  return excludePaths.some(exclude => {
    const normalizedExclude = exclude.replace(/\\/g, '/');
    return normalizedRelPath.startsWith(normalizedExclude) || normalizedRelPath === normalizedExclude;
  });
}

function isInPublicationHomePageFolder(relativePath) {
  const normalizedRelPath = relativePath.replace(/\\/g, '/');
  return normalizedRelPath.startsWith('出版物首页/') || normalizedRelPath === '出版物首页';
}

function derivePageTitleWithParent(relativePath, options = {}) {
  const { enableParentPage = true, excludeParentPagePaths = [] } = options;
  const normalizedPath = relativePath.replace(/\\/g, '/');
  
  if (enableParentPage) {
    const excluded = shouldExcludeFromParentPage(normalizedPath, excludeParentPagePaths);
    
    if (excluded) {
      let title = normalizedPath;
      const firstSlashIndex = title.indexOf('/');
      if (firstSlashIndex !== -1) {
        title = title.substring(firstSlashIndex + 1);
      }
      const ext = path.extname(title).toLowerCase();
      if (ext && ext !== '.json') {
        title = title.slice(0, -ext.length);
      }
      return normalizePageTitle(title);
    }
    
    const ext = path.extname(normalizedPath).toLowerCase();
    let title = normalizedPath;
    if (ext !== '.json') {
      title = ext ? normalizedPath.slice(0, -ext.length) : normalizedPath;
    }
    return normalizePageTitle(title);
  }
  
  return derivePageTitleFromRelativePath(relativePath);
}

function loadPagesFromDirectory(sourceDir, options = {}) {
  const pages = [];
  const extensions = new Set(
    (options.extensions || ['.txt']).map(ext => String(ext).toLowerCase())
  );
  const skipFolders = new Set(
    (options.skipFolders || []).map(name => String(name).toLowerCase())
  );
  const { enableParentPage, excludeParentPagePaths, filterFolder } = options;

  function walk(currentDir, relativePath = '') {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (!skipFolders.has(entry.name.toLowerCase())) {
          walk(absolutePath, nextRelativePath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!extensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      if (filterFolder) {
        const normalizedRelPath = nextRelativePath.replace(/\\/g, '/');
        const normalizedFilter = filterFolder.replace(/\\/g, '/');
        if (!normalizedRelPath.startsWith(normalizedFilter + '/') && normalizedRelPath !== normalizedFilter) {
          continue;
        }
      }

      let title = derivePageTitleWithParent(nextRelativePath, { enableParentPage, excludeParentPagePaths });
      const fileExt = path.extname(entry.name).toLowerCase();
      
      if (fileExt === '.json') {
        title = normalizePageTitle(`Data:${title}`);
      }
      
      pages.push({
        itemId: title,
        rawTitle: nextRelativePath,
        title,
        content: fs.readFileSync(absolutePath, 'utf8'),
        sourcePath: absolutePath,
        relativePath: nextRelativePath,
        isPublicationHomePage: isInPublicationHomePageFolder(nextRelativePath)
      });
    }
  }

  walk(sourceDir);
  return pages;
}

function loadPagesFromManifest(manifestPath) {
  const rawContent = fs.readFileSync(manifestPath, 'utf8');
  const items = JSON.parse(rawContent);

  return items.map((item, index) => {
    const rawTitle = item.title || `item-${index}`;
    const title = normalizePageTitle(`Data:${rawTitle}`);
    return {
      itemId: title,
      rawTitle,
      title,
      content: String(item.content || ''),
      summary: item.summary || null,
      sourcePath: item.sourcePath || manifestPath,
      meta: item.meta || null
    };
  });
}

/**
 * 按指定的相对路径列表加载页面文件
 * 用于根据 json-page.json 映射刷新指定 wiki 页面的场景
 * @param {string} rootDir - 根目录
 * @param {Array} relativePaths - 相对路径列表
 * @param {Object} options - 选项
 * @returns {Array} 页面项数组
 */
function loadPagesByRelativePaths(rootDir, relativePaths, options = {}) {
  const { enableParentPage = true, excludeParentPagePaths = [] } = options;
  const pages = [];

  for (const relativePath of relativePaths) {
    const normalizedRelPath = relativePath.replace(/\\/g, '/');
    const absolutePath = path.join(rootDir, normalizedRelPath);

    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      continue;
    }

    let title = derivePageTitleWithParent(normalizedRelPath, {
      enableParentPage,
      excludeParentPagePaths
    });

    const fileExt = path.extname(normalizedRelPath).toLowerCase();
    if (fileExt === '.json') {
      title = normalizePageTitle(`Data:${title}`);
    }

    pages.push({
      itemId: title,
      rawTitle: normalizedRelPath,
      title,
      content: fs.readFileSync(absolutePath, 'utf8'),
      sourcePath: absolutePath,
      relativePath: normalizedRelPath,
      isPublicationHomePage: isInPublicationHomePageFolder(normalizedRelPath)
    });
  }

  return pages;
}

/**
 * 加载已更改文件列表。
 * 兼容两种记录文件及两种结构：
 *   1. replace-logs.json         -> changedOutputFiles[].filePath
 *   2. updated-wiki-files.json   -> wikiFiles[].wikiPath
 * @param {string} rootPath - 根目录路径（记录文件应位于此目录顶层）
 * @returns {Object|null} { files: Array<string>, log: Object, logFile: string } 或 null（文件不存在）
 */
function loadChangedFilesList(rootPath) {
  const candidates = ['replace-logs.json', 'updated-wiki-files.json'];
  let logsPath = null;
  let fileName = null;

  for (const name of candidates) {
    const candidatePath = path.join(rootPath, name);
    if (fs.existsSync(candidatePath)) {
      logsPath = candidatePath;
      fileName = name;
      break;
    }
  }

  if (!logsPath) {
    return null;
  }

  try {
    const content = fs.readFileSync(logsPath, 'utf8');
    const data = JSON.parse(content);
    let files = [];

    // 旧格式：replace-logs.json 的 changedOutputFiles[].filePath
    if (data.changedOutputFiles && Array.isArray(data.changedOutputFiles)) {
      files = data.changedOutputFiles
        .filter(item => item && item.filePath)
        .map(item => item.filePath);
    }
    // 新格式：updated-wiki-files.json 的 wikiFiles[].wikiPath
    else if (data.wikiFiles && Array.isArray(data.wikiFiles)) {
      files = data.wikiFiles
        .filter(item => item && item.wikiPath)
        .map(item => item.wikiPath);
    }

    return { files, log: data, logFile: fileName };
  } catch (error) {
    console.warn(`读取 ${fileName || '记录文件'} 失败: ${error.message}`);
    return null;
  }
}

module.exports = {
  loadPagesFromDirectory,
  loadPagesFromManifest,
  loadPagesByRelativePaths,
  loadChangedFilesList,
  isInPublicationHomePageFolder
};