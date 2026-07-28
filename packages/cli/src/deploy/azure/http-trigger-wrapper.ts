/**
 * Gera o adapter Lambda event ↔ Azure Functions context (HttpTrigger/index.js).
 *
 * O código retornado roda DENTRO da Function App (Node 20, Functions v4 model
 * clássico) — por isso é uma string de JS puro, não TypeScript compilado.
 * Trata, além do HTTP normal:
 * - preflight de abuse-protection do Web PubSub (OPTIONS + WebHook-Request-Origin)
 * - eventos Event Grid (validação de subscription + BlobCreated → formato S3 Records)
 * - roteamento por route patterns (path params nomeados, greedy {proxy+})
 */
export function renderHttpTriggerWrapper(routePatterns: string[]): string {
  const routePatternsJson = JSON.stringify(routePatterns);

  return `'use strict';
const { handler } = require('../handler');
const routePatterns = ${routePatternsJson};

function matchRoute(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  for (const pattern of routePatterns) {
    const parts = pattern.split('/').filter(Boolean);
    const lastPart = parts.length > 0 ? parts[parts.length - 1] : '';
    const isGreedy = /^\\{\\w+\\+\\}$/.test(lastPart);
    if (isGreedy ? segs.length < parts.length : segs.length !== parts.length) continue;
    const named = {};
    let match = true;
    for (let i = 0; i < parts.length; i++) {
      const gm = parts[i].match(/^\\{(\\w+)\\+\\}$/);
      if (gm) { named[gm[1]] = segs.slice(i).map(decodeURIComponent).join('/'); break; }
      const nm = parts[i].match(/^\\{(\\w+)\\}$/);
      if (nm) { named[nm[1]] = decodeURIComponent(segs[i]); }
      else if (parts[i] !== segs[i]) { match = false; break; }
    }
    if (match) return named;
  }
  return null;
}

module.exports = async function(context, req) {
  const rawUrl = req.url || '/';
  let pathname, queryString;
  try {
    const u = new URL(rawUrl);
    pathname = u.pathname;
    queryString = u.search ? u.search.slice(1) : '';
  } catch (_) {
    const qIdx = rawUrl.indexOf('?');
    pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    queryString = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';
  }

  // Azure Functions passa o pathname com o prefixo /api/HttpTrigger — remove para
  // que os route patterns e o pathParameters.id correspondam ao path real da API.
  if (pathname.startsWith('/api/HttpTrigger')) {
    pathname = pathname.slice('/api/HttpTrigger'.length) || '/';
  }

  // Web PubSub abuse-protection preflight (OPTIONS com WebHook-Request-Origin)
  // Sem este header na resposta o Web PubSub rejeita todos os connects com
  // AbuseProtectionError ("preflight abuse protection request failed").
  if (req.method === 'OPTIONS' && req.headers && req.headers['webhook-request-origin']) {
    context.res = { status: 200, headers: { 'WebHook-Allowed-Origin': '*', 'WebHook-Allowed-Rate': '100' } };
    return;
  }

  // Event Grid blob trigger
  const aegEventType = req.headers && req.headers['aeg-event-type'];
  if (aegEventType || pathname === '/api/events' || pathname.endsWith('/events')) {
    const bodyStr = req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : '[]';
    let egEvents;
    try { egEvents = JSON.parse(bodyStr || '[]'); } catch (_) { egEvents = []; }
    if (!Array.isArray(egEvents)) egEvents = [egEvents];
    if (egEvents.length > 0 && (egEvents[0].eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent' || egEvents[0].eventType === 'Microsoft.EventGrid.SubscriptionValidation')) {
      const validationCode = egEvents[0].data && egEvents[0].data.validationCode;
      context.res = { status: 200, body: JSON.stringify({ validationResponse: validationCode }), headers: { 'Content-Type': 'application/json' } };
      return;
    }
    const blobRecords = egEvents
      .filter(function(e) { return e.eventType === 'Microsoft.Storage.BlobCreated'; })
      .map(function(e) {
        const subject = e.subject || '';
        const blobIdx = subject.indexOf('/blobs/');
        const key = blobIdx >= 0 ? subject.slice(blobIdx + 7) : '';
        const contIdx = subject.indexOf('/containers/');
        const contEnd = subject.indexOf('/', contIdx + 12);
        const container = contIdx >= 0 ? subject.slice(contIdx + 12, contEnd >= 0 ? contEnd : undefined) : '';
        return { eventSource: 'aws:s3', s3: { bucket: { name: container }, object: { key: decodeURIComponent(key) } } };
      });
    if (blobRecords.length > 0) {
      try {
        await handler({ Records: blobRecords }, {});
        context.res = { status: 200, body: '{}', headers: { 'Content-Type': 'application/json' } };
      } catch (egErr) {
        context.res = { status: 500, body: JSON.stringify({ error: String(egErr) }), headers: { 'Content-Type': 'application/json' } };
      }
    } else {
      context.res = { status: 200, body: '{}', headers: { 'Content-Type': 'application/json' } };
    }
    return;
  }

  // Regular HTTP
  const queryStringParameters = {};
  if (queryString) {
    for (const part of queryString.split('&')) {
      if (!part) continue;
      const eqIdx = part.indexOf('=');
      const k = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
      const v = eqIdx >= 0 ? part.slice(eqIdx + 1) : '';
      queryStringParameters[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    headers[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  const titleCase = function(s) { return s.replace(/(?:^|-)([a-z])/g, function(_, c) { return c.toUpperCase(); }); };
  for (const k of Object.keys(headers)) { const tc = titleCase(k); if (tc !== k) headers[tc] = headers[k]; }

  const segments = pathname.split('/').filter(Boolean);
  const namedParams = routePatterns.length > 0 ? matchRoute(pathname) : null;
  const pathParameters = segments.length >= 2
    ? { id: decodeURIComponent(segments[1]), proxy: segments.slice(1).join('/'), ...(namedParams || {}) }
    : (namedParams && Object.keys(namedParams).length > 0 ? namedParams : null);

  const bodyStr2 = req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : null;

  const event = {
    httpMethod: req.method || 'GET',
    path: pathname,
    pathParameters,
    queryStringParameters,
    headers,
    body: bodyStr2,
    isBase64Encoded: false,
  };

  try {
    const result = await handler(event, {});
    context.res = { status: result.statusCode || 200, headers: result.headers || { 'Content-Type': 'application/json' }, body: result.body || '' };
  } catch (err) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(err) }) };
  }
};
`;
}
