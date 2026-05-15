const fs = require('fs');
const path = require('path');
const {
  derivePageTitleFromRelativePath,
  normalizePageTitle
} = require('./page-title-utils');

function loadPagesFromDirectory(sourceDir, options = {}) {
  const pages = [];
  const extensions = new Set(
    (options.extensions || ['.txt']).map(ext => String(ext).toLowerCase())
  );
  const skipFolders = new Set(
    (options.skipFolders || []).map(name => String(name).toLowerCase())
  );

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

      const title = derivePageTitleFromRelativePath(nextRelativePath);
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
    const title = normalizePageTitle(item.title || `item-${index}`);
    return {
      itemId: title,
      rawTitle: item.title || `item-${index}`,
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
