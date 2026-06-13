function decidePageAction({ exists, overwrite, isPublicationHomePage }) {
  // 出版物首页文件夹里的文件，即使设置了 overwrite，只要存在就跳过
  if (exists && isPublicationHomePage) {
    return 'skip';
  }
  
  if (exists && overwrite) {
    return 'overwrite';
  }
  if (exists) {
    return 'skip';
  }
  return 'create';
}

function buildDryRunEvent({ rawTitle, normalizedTitle, exists, action, content, isPublicationHomePage }) {
  const event = {
    type: 'dry-run',
    file: rawTitle,
    title: normalizedTitle,
    exists,
    action,
    contentLength: String(content || '').length
  };
  
  if (isPublicationHomePage) {
    event.isPublicationHomePage = true;
  }
  
  return event;
}

module.exports = {
  decidePageAction,
  buildDryRunEvent
};
