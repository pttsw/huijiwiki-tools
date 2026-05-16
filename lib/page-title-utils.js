const path = require('path');

const ESCAPE_MAP = {
  '_0_': '\\',
  '_1_': '-', // 原是/，但为了避免变成子页面，故将转成-
  '_2_': ':',
  '_3_': '*',
  '_4_': '"',
  '_5_': '<',
  '_6_': '>',
  '_7_': '-', // 原是|，但为了报错，故将转成-
  '_8_': '?',
  '#': '_',
  '[': '_',
  ']': '_',
  '{': '_',
  '}': '_'
};

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePageTitle(rawTitle) {
  let result = normalizeWhitespace(String(rawTitle || ''));
  
  const escapeKeys = Object.keys(ESCAPE_MAP).sort((a, b) => b.length - a.length);
  for (const key of escapeKeys) {
    result = result.split(key).join(ESCAPE_MAP[key]);
  }
  
  return result;
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
