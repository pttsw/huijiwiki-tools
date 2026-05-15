function extractHtmlTitle(response) {
  const match = response.match(/<title[^>]*>(.*?)<\/title>/i);
  if (!match) {
    return '';
  }

  return match[1].replace(/\s+/g, ' ').trim();
}

function summarizeStringResponse(response) {
  const normalized = response.trim();
  const looksLikeHtml = /^<!doctype html\b/i.test(normalized) || /<html\b/i.test(normalized);
  const hasManyLines = normalized.split('\n').length > 3;
  const isLongText = normalized.length > 200;

  if (!looksLikeHtml && !hasManyLines && !isLongText) {
    return response;
  }

  const title = looksLikeHtml ? extractHtmlTitle(normalized) : '';
  const summaryParts = [
    'string response summary:',
    `length=${response.length}`,
    `looksLikeHtml=${looksLikeHtml}`
  ];

  if (title) {
    summaryParts.push(`title="${title}"`);
  }

  if (!looksLikeHtml) {
    summaryParts.push(`lineCount=${normalized.split('\n').length}`);
  }

  return summaryParts.join(' ');
}

function stringifyRawResponse(response) {
  if (typeof response === 'string') {
    return summarizeStringResponse(response);
  }

  try {
    return JSON.stringify(response);
  } catch (error) {
    return String(response);
  }
}

function setWikiError(wiki, message) {
  if (typeof wiki.error === 'function') {
    wiki.error(message);
    return;
  }

  wiki.lastError = message;
}

function rememberLogin(wiki, username, password, resolvedUsername) {
  wiki.username = resolvedUsername;
  wiki.loginUsername = username;
  wiki.loginPassword = password;
}

function ensureResponseField(response, fieldName, actionLabel) {
  if (!response || typeof response !== 'object' || !response[fieldName]) {
    throw new Error(
      `Unexpected response from wiki ${actionLabel}: missing "${fieldName}". ` +
      `Raw response: ${stringifyRawResponse(response)}`
    );
  }

  return response[fieldName];
}

function emitRawResponse(logRawResponse, label, response) {
  if (typeof logRawResponse !== 'function') {
    return;
  }

  logRawResponse(`Raw ${label}: ${stringifyRawResponse(response)}`);
}

async function loginWithLegacyApi(wiki, username, password, { logRawResponse } = {}) {
  const firstResponse = await wiki.request({
    action: 'login',
    lgname: username,
    lgpassword: password
  });
  emitRawResponse(logRawResponse, 'login response (step 1)', firstResponse);

  const firstLogin = ensureResponseField(firstResponse, 'login', 'login (step 1)');
  if (firstLogin.result !== 'NeedToken') {
    if (firstLogin.result === 'Failed') {
      setWikiError(wiki, `登录失败，错误信息：${firstLogin.reason}`);
      return false;
    }

    setWikiError(wiki, `登录失败，未知结果：${firstLogin.result || 'empty result'}`);
    return false;
  }

  const secondResponse = await wiki.request({
    action: 'login',
    lgname: username,
    lgpassword: password,
    lgtoken: firstLogin.token
  });
  emitRawResponse(logRawResponse, 'login response (step 2)', secondResponse);

  const secondLogin = ensureResponseField(secondResponse, 'login', 'login (step 2)');
  if (secondLogin.result === 'Success') {
    rememberLogin(wiki, username, password, secondLogin.lgusername);
    return true;
  }

  if (secondLogin.result === 'Failed') {
    setWikiError(wiki, `登录失败，错误信息：${secondLogin.reason}`);
    return false;
  }

  setWikiError(wiki, `登录失败，未知结果：${secondLogin.result || 'empty result'}`);
  return false;
}

async function loginWithClientApi(wiki, username, password, { logRawResponse } = {}) {
  const tokenResponse = await wiki.request({
    action: 'query',
    meta: 'tokens',
    type: 'login'
  });
  emitRawResponse(logRawResponse, 'clientlogin token response', tokenResponse);

  const query = ensureResponseField(tokenResponse, 'query', 'clientlogin token query');
  const tokens = ensureResponseField(query, 'tokens', 'clientlogin token query');
  const loginToken = tokens.logintoken;

  if (!wiki.requester || typeof wiki.requester.hasHuijiSession !== 'function') {
    throw new Error('Unexpected wiki client state: requester.hasHuijiSession is unavailable');
  }

  if (!wiki.requester.hasHuijiSession()) {
    const bootstrapResponse = await wiki.request({
      action: 'clientlogin',
      username,
      password,
      logintoken: '+\\',
      loginreturnurl: `https://${wiki.prefix}.huijiwiki.com`,
      rememberMe: '1'
    });
    emitRawResponse(logRawResponse, 'clientlogin response (bootstrap)', bootstrapResponse);
    return await loginWithClientApi(wiki, username, password, { logRawResponse });
  }

  const loginResponse = await wiki.request({
    action: 'clientlogin',
    username,
    password,
    logintoken: loginToken,
    loginreturnurl: `https://${wiki.prefix}.huijiwiki.com`,
    rememberMe: '1'
  });
  emitRawResponse(logRawResponse, 'clientlogin response (step 2)', loginResponse);

  const clientLogin = ensureResponseField(loginResponse, 'clientlogin', 'clientlogin (step 2)');
  if (clientLogin.status === 'PASS') {
    rememberLogin(wiki, username, password, clientLogin.username);
    return true;
  }

  setWikiError(wiki, `登录失败，错误信息：${clientLogin.message || clientLogin.status || 'unknown error'}`);
  return false;
}

async function loginWithDiagnostics(wiki, username, password, options = {}) {
  const normalizedUsername = String(username || '').trim();
  const normalizedPassword = String(password || '').trim();

  if (normalizedUsername.indexOf('@') === -1) {
    return await loginWithClientApi(wiki, normalizedUsername, normalizedPassword, options);
  }

  return await loginWithLegacyApi(wiki, normalizedUsername, normalizedPassword, options);
}

module.exports = {
  loginWithDiagnostics,
  stringifyRawResponse
};
