import { IacmpConfig } from '../utils';
import { tierWarnings, AccountTier } from '../deploy/resource-tier-map';
import {
  LoadedStack,
  validateHandlerFiles,
  validateHandlerCloudSdk,
  validateHandlerSql,
  validateHandlerVpcSecrets,
  validateHandlerDynamoNoSql,
  validateLambdaVpcGatewayEndpoint,
  validateHandlerPgSsl,
  validateHandlerEnvVars,
  validateHandlerDynamoGsi,
  validateHandlerDynamoReservedWords,
  validateDbUserRef,
  validateRedisPortRef,
  validateStackDomainSeparation,
} from '../validators';
import { SynthUI } from './types';
import { t } from '../i18n';

/**
 * Roda todos os guards de synth-time na ordem original. Cada guard barra em
 * synth-time um erro que só apareceria em runtime na cloud — o cabeçalho de
 * cada um documenta o sintoma. A ordem importa: os primeiros são estruturais
 * (monólito, handler sem arquivo), os demais são de conteúdo de handler.
 */
export function runSynthGuards(
  loadedStacks: LoadedStack[],
  cwd: string,
  provider: string,
  config: IacmpConfig,
  ui: SynthUI,
): void {
  // ── Aviso de tier/disponibilidade ───────────────────────────────────────
  // Se um construct é restrito/indisponível no tier da conta, o usuário é
  // avisado aqui, antes do deploy real falhar. Só avisa, não bloqueia.
  if (provider === 'aws' || provider === 'azure') {
    const tier = (config.accountTier as AccountTier) ?? 'free';
    const constructTypes = loadedStacks.flatMap(l => l.stack.constructs.map(c => c.type));
    for (const w of tierWarnings(constructTypes, provider, tier)) ui.warn(w);
  }

  const guards: Array<{ header: string; run: () => string[] }> = [
    {
      // A convenção é UMA stack por domínio (rede, dados, compute…), ligadas por
      // ref() cross-stack. O modelo às vezes gera um main-stack.ts com tudo junto.
      header: t('Stack monolítica (mistura domínios de infra num arquivo só):', 'Monolithic stack (mixes infra domains in a single file):'),
      run: () => validateStackDomainSeparation(loadedStacks),
    },
    {
      // Um Fn.Lambda com handler 'dist/listItems.handler' precisa de src/listItems.ts
      // (que compila para dist/listItems.js). Sem isso, o deploy falha em runtime
      // com "Cannot find module".
      header: t('Handler(s) de Lambda sem arquivo de origem correspondente:', 'Lambda handler(s) with no matching source file:'),
      run: () => validateHandlerFiles(loadedStacks, cwd),
    },
    {
      // Projeto gerado para AWS deployado na Azure (ou vice-versa) empacota
      // handlers com o SDK errado e falha só em runtime.
      header: t('Handler(s) com SDK da cloud errada (falharia em runtime):', 'Handler(s) using the wrong cloud SDK (would fail at runtime):'),
      run: () => validateHandlerCloudSdk(cwd, provider),
    },
    {
      // INSERT com contagem de colunas != valores — bug recorrente da IA que só
      // apareceria em runtime ("INSERT has more target columns than expressions").
      header: t('SQL inválido em handler(s):', 'Invalid SQL in handler(s):'),
      run: () => validateHandlerSql(cwd),
    },
    {
      // Lambda em subnet privada não alcança o Secrets Manager sem NAT/VPC
      // endpoint — o SDK pendura e a função dá timeout de 30s. A senha do banco
      // já vem resolvida na env DB_PASSWORD.
      header: t('Handler de Lambda em VPC acessa Secrets Manager em runtime (vai dar timeout no deploy):', 'Lambda-in-VPC handler accesses Secrets Manager at runtime (will time out on deploy):'),
      run: () => validateHandlerVpcSecrets(loadedStacks, cwd),
    },
    {
      // A IA às vezes gera pg/mysql + SELECT/INSERT para um projeto que só tem
      // DynamoDB. DynamoDB não é SQL — trava em runtime.
      header: t('Handler acessa DynamoDB como banco SQL (vai falhar em runtime):', 'Handler accesses DynamoDB as a SQL database (will fail at runtime):'),
      run: () => validateHandlerDynamoNoSql(loadedStacks, cwd),
    },
    {
      // Subnet privada sem NAT não alcança serviços da AWS fora da VPC; o SDK
      // pendura e a Lambda dá timeout. Gateway Endpoint (grátis) resolve.
      header: t('Lambda em VPC acessa serviço AWS sem Gateway VPC Endpoint (vai dar timeout no deploy):', 'Lambda in a VPC accesses an AWS service without a Gateway VPC Endpoint (will time out on deploy):'),
      run: () => validateLambdaVpcGatewayEndpoint(loadedStacks, cwd),
    },
    {
      // RDS Postgres 14+ exige conexão encriptada (pg_hba: "no encryption").
      // Handler com pg.Client sem `ssl:` falha TODO request em runtime.
      header: t('Handler conecta no PostgreSQL sem SSL (RDS rejeita com "no pg_hba.conf entry ... no encryption"):', 'Handler connects to PostgreSQL without SSL (RDS rejects with "no pg_hba.conf entry ... no encryption"):'),
      run: () => validateHandlerPgSsl(loadedStacks, cwd),
    },
    {
      // A IA gera o handler certo mas ESQUECE o environment no Fn.Lambda — o CRUD
      // inteiro falha em runtime (ex: TABLE_NAME undefined → 502).
      header: t("Handler usa process.env que o Fn.Lambda não declara em 'environment' (vai falhar em runtime):", "Handler reads process.env keys the Fn.Lambda does not declare in 'environment' (will fail at runtime):"),
      run: () => validateHandlerEnvVars(loadedStacks, cwd),
    },
    {
      // Handler com QueryCommand({ IndexName }) que a Database.DynamoDB não declara
      // deploya, mas a query falha em runtime (ValidationException).
      header: t('Handler consulta um GSI que a tabela DynamoDB não declara (ValidationException em runtime):', 'Handler queries a GSI the DynamoDB table does not declare (ValidationException at runtime):'),
      run: () => validateHandlerDynamoGsi(loadedStacks, cwd),
    },
    {
      // FilterExpression: 'ttl < :now' → 'ttl' é reserved keyword → ValidationException
      // em runtime. Forçar o alias '#ttl' aqui dá o gatilho pro loop se auto-corrigir.
      header: t('Handler usa nome reservado do DynamoDB cru numa expressão (ValidationException em runtime):', 'Handler uses a raw DynamoDB reserved name in an expression (ValidationException at runtime):'),
      run: () => validateHandlerDynamoReservedWords(loadedStacks, cwd),
    },
    {
      // A IA crava DB_USER: 'postgres' na env do Fn.Lambda, mas o admin real do
      // Database.SQL varia por cloud (AWS/Azure = 'dbadmin'). Só ref('<Db>','Username')
      // resolve pro admin certo de cada cloud.
      header: t('DB_USER hardcoded no Fn.Lambda (a auth do banco falha em runtime):', 'DB_USER hardcoded in the Fn.Lambda (database auth fails at runtime):'),
      run: () => validateDbUserRef(loadedStacks),
    },
    {
      // Redis Enterprise (Azure) usa TLS na porta 10000 — não existe porta 6379.
      header: t("REDIS_PORT hardcoded no Fn.Lambda (Redis Enterprise usa TLS:10000 — '6379' não existe):", "REDIS_PORT hardcoded in the Fn.Lambda (Redis Enterprise uses TLS:10000 — '6379' does not exist):"),
      run: () => validateRedisPortRef(loadedStacks),
    },
  ];

  for (const guard of guards) {
    const errors = guard.run();
    if (errors.length > 0) {
      ui.error(`${guard.header}\n\n` + errors.map(e => `  • ${e}`).join('\n'));
    }
  }
}
