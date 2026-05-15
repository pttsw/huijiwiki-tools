const path = require('path');

const INVALID_TITLE_CHARS = /[#<>[\]{}|\u0000-\u001f]/g;

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePageTitle(rawTitle) {
  return normalizeWhitespace(String(rawTitle || ''))
    .replace(/\//g, ':')
    .replace(/:+/g, ':')
    .replace(/^:+|:+$/g, '')
    .replace(INVALID_TITLE_CHARS, '_');
}

function derivePageTitleFromRelativePath(relativePath) {
  const normalizedPath = String(relativePath || '').replace(/\\/g, '/');
  const ext = path.extname(normalizedPath);
  const withoutExt = ext ? normalizedPath.slice(0, -ext.length) : normalizedPath;
  return normalizePageTitle(withoutExt);
}

module.exports = {
  normalizePageTitle,
  derivePageTitleFromRelativePath
};
