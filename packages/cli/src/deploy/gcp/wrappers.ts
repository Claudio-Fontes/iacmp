/**
 * Adapters de invocação que rodam DENTRO do Cloud Functions gen2 (Node 20) —
 * por isso são strings de JS puro, não TypeScript compilado.
 */

/**
 * Gera o código-fonte do adapter `(req, res)` do functions-framework GCP —
 * ESPELHA o adapter Lambda-event↔Azure-Functions-context de
 * `deploy/azure/http-trigger-wrapper.ts`, adaptado ao contrato do Cloud
 * Functions gen2 (o handler já recebe `(req, res)` no estilo Express, não
 * `(context, req)`).
 *
 * Escrito como arquivo separado (`index.js`) que faz `require('./handler.js')`
 * — o bundle esbuild do código do usuário continua intocado (preserva o
 * export nomeado `entryPoint`), e o adapter só precisa requerê-lo, nunca
 * passa pelo esbuild (sem dependências externas, roda direto no Node 20 do
 * runtime do Cloud Functions).
 *
 * Distingue handler nativo `(req,res)` (ex: `(req,res)=>res.send()`) de
 * handler formato Lambda (`async (event) => ({statusCode,headers,body})`)
 * pela ARIDADE da função exportada (`userFn.length >= 2` → já é `(req,res)`,
 * chama direto; senão envolve). Não há sinal explícito do synth pra essa
 * distinção (ao contrário do Azure, que SEMPRE assume Lambda-style) — arity
 * é a única heurística disponível em runtime, documentada aqui.
 *
 * pathParameters (branch Lambda): heurística "último segmento = id" idêntica
 * à do Azure (`{ id: segments[1], proxy: segments.slice(1).join('/') }`) —
 * DÍVIDA documentada: como o Gateway usa `path_translation: APPEND_PATH_TO_ADDRESS`
 * (ver constructs/function.ts synthFunction/buildOpenApiPaths), a Function
 * recebe o path bruto do cliente sem o route pattern original (`{param}`),
 * e o meta GCP (`GCPFunctionMeta`) não carrega `routePatterns` como o Azure
 * carrega — não dá pra fazer match nomeado exato, só a heurística posicional.
 */
export function renderGcpFunctionWrapper(entryPoint: string): string {
  const entryPointLiteral = JSON.stringify(entryPoint);
  return `'use strict';
const mod = require('./handler.js');
const ENTRY_POINT = ${entryPointLiteral};
const userFn = mod[ENTRY_POINT];

if (typeof userFn !== 'function') {
  throw new Error('GCP entry point "' + ENTRY_POINT + '" não encontrado em handler.js (bundle do usuário).');
}

function buildLambdaEvent(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    headers[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  let body = null;
  if (req.body != null) {
    body = typeof req.body === 'string' ? req.body : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
  } else if (req.rawBody) {
    body = req.rawBody.toString('utf8');
  }
  const pathname = req.path || '/';
  const segments = pathname.split('/').filter(Boolean);
  const pathParameters = segments.length >= 2
    ? { id: decodeURIComponent(segments[1]), proxy: segments.slice(1).join('/') }
    : null;
  return {
    httpMethod: req.method || 'GET',
    path: pathname,
    pathParameters,
    queryStringParameters: req.query || {},
    headers,
    body,
    isBase64Encoded: false,
  };
}

module.exports[ENTRY_POINT] = async function (req, res) {
  if (userFn.length >= 2) {
    return userFn(req, res);
  }
  try {
    const result = await userFn(buildLambdaEvent(req), {});
    res.status((result && result.statusCode) || 200);
    const resHeaders = (result && result.headers) || { 'Content-Type': 'application/json' };
    for (const [k, v] of Object.entries(resHeaders)) res.set(k, v);
    res.send(result && result.body != null ? result.body : '');
  } catch (err) {
    res.status(500).set('Content-Type', 'application/json').send(JSON.stringify({ error: String(err) }));
  }
};
`;
}

/**
 * Gera o código-fonte do adapter de uma Fn.Lambda **event-triggered**
 * (`eventSources[].queueId` → Pub/Sub, ver `GCPFunctionMeta.trigger` /
 * `event_trigger` em `constructs/function.ts`) para Cloud Functions gen2.
 *
 * AO CONTRÁRIO do wrapper HTTP acima (`renderGcpFunctionWrapper`), aqui o
 * functions-framework entrega ao handler um **CloudEvent** — não um `req`
 * estilo Express. Registrar via `functions.cloudEvent(entryPoint, userFn)`
 * (API do `@google-cloud/functions-framework`) garante que o framework
 * invoque o handler do usuário com o CloudEvent DIRETO
 * (`event.data.message.data` preenchido com o payload Pub/Sub em base64),
 * em vez de passar pelo adapter HTTP-Lambda — que monta um "Lambda event"
 * vazio a partir de campos (`req.path`/`req.headers`/`req.body`) que um
 * CloudEvent não tem. Bug provado em deploy real: o worker era disparado e
 * executava, mas `event.data.message.data` chegava vazio porque o handler
 * recebia o event HTTP-Lambda montado pelo wrapper errado, não o CloudEvent.
 *
 * `@google-cloud/functions-framework` precisa estar em `dependencies` do
 * `package.json` do bundle (ver buildFunctionBundle) para o buildpack do
 * Cloud Functions instalá-lo durante o build remoto — o require aqui não
 * passa pelo esbuild (mesmo padrão do index.js do wrapper HTTP).
 */
export function renderGcpEventWrapper(entryPoint: string): string {
  const entryPointLiteral = JSON.stringify(entryPoint);
  return `'use strict';
const functions = require('@google-cloud/functions-framework');
const mod = require('./handler.js');
const ENTRY_POINT = ${entryPointLiteral};
const userFn = mod[ENTRY_POINT];

if (typeof userFn !== 'function') {
  throw new Error('GCP entry point "' + ENTRY_POINT + '" não encontrado em handler.js (bundle do usuário).');
}

functions.cloudEvent(ENTRY_POINT, userFn);
`;
}
