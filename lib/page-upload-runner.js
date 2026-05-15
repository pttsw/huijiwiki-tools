function decidePageAction({ exists, overwrite }) {
  if (exists && overwrite) {
    return 'overwrite';
  }
  if (exists) {
    return 'skip';
  }
  return 'create';
}

function buildDryRunEvent({ rawTitle, normalizedTitle, exists, action, content }) {
  return {
    type: 'dry-run',
    file: rawTitle,
    title: normalizedTitle,
    exists,
    action,
    contentLength: String(content || '').length
  };
}

module.exports = {
  decidePageAction,
  buildDryRunEvent
};
