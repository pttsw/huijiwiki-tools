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
  const { enableParentPage, excludeParentPagePaths } = options;

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
        relativePath: nextRelativePath
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

module.exports = {
  loadPagesFromDirectory,
  loadPagesFromManifest
};
