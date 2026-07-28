import { BaseConstruct, ref } from '@iacmp/core';
import { TFOutput, toTfId, addResource, gcpName } from './common.js';
import { resolveGcpRef } from '../refs.js';

/**
 * Converte uma expressão cron do formato AWS EventBridge (5-6 campos:
 * minutos horas dia-do-mês mês dia-da-semana [ano], com '?' aceito num dos
 * campos dia) para o formato unix-cron do Cloud Scheduler (5 campos, SEM
 * ano, SEM '?' — ver https://cloud.google.com/scheduler/docs/configuring/cron-job-schedules).
 * Best-effort, cobre os casos comuns dos fixtures (campos numéricos, '*',
 * listas/ranges simples, nomes de mês/dia JAN-DEC/SUN-SAT que o Cloud
 * Scheduler também aceita nativamente):
 *  - campo "ano" (6º campo AWS) é sempre descartado — Cloud Scheduler não
 *    tem esse conceito, agendamentos "só neste ano" não têm equivalente;
 *  - '?' vira '*' (unix-cron não tem coringa "sem valor");
 *  - dia-da-semana NUMÉRICO desloca de 1-7(SUN=1) [AWS] pra 0-6(SUN=0)
 *    [unix-cron] — nomes (SUN..SAT) passam inalterados, os dois formatos
 *    usam os mesmos nomes;
 *  - caracteres especiais L/W/# (sintaxe Quartz, sem equivalente em
 *    unix-cron) passam sem tradução, com warning.
 */
function awsCronToUnixCron(cron: string, constructId: string): string {
  const raw = cron.trim().replace(/^cron\((.*)\)$/i, '$1').trim();
  const fields = raw.split(/\s+/).filter(Boolean);
  if (fields.length < 5) {
    console.warn(`[gcp] Events.EventBridge "${constructId}": cron "${cron}" tem menos de 5 campos — usando como está; Cloud Scheduler pode rejeitar.`);
    return raw;
  }
  if (/[LW#]/i.test(raw)) {
    console.warn(`[gcp] Events.EventBridge "${constructId}": cron "${cron}" usa L/W/# (sintaxe Quartz) — sem equivalente em unix-cron, mantido sem tradução (Cloud Scheduler pode rejeitar).`);
  }
  const [minute, hour, dom, month, dow] = fields; // 6º campo (ano), se existir, é descartado
  const norm = (f: string) => (f === '?' ? '*' : f);
  return `${norm(minute)} ${norm(hour)} ${norm(dom)} ${norm(month)} ${normalizeDow(norm(dow))}`;
}

function normalizeDow(field: string): string {
  if (field === '*') return '*';
  return field.split(',').map((part) => {
    const m = /^(\d+)(-(\d+))?$/.exec(part);
    if (!m) return part; // nomes (SUN..SAT) ou expressões compostas (*/2 etc.) passam como estão
    const shift = (n: string) => ((parseInt(n, 10) - 1 + 7) % 7).toString();
    return m[3] !== undefined ? `${shift(m[1])}-${shift(m[3])}` : shift(m[1]);
  }).join(',');
}

/**
 * Converte um rate() do EventBridge ('1 hour', '5 minutes', '2 days') pra um
 * unix-cron equivalente. Só um passo fixo ("a cada N" no campo) expressa
 * exatamente um rate — por isso só é exato quando N divide igualmente a
 * janela (60min/24h); fora disso aproxima pro maior N válido abaixo do
 * pedido e avisa que a frequência real vai ser diferente da pedida.
 */
function awsRateToUnixCron(rate: string, constructId: string): string {
  const m = /^(\d+)\s+(minute|minutes|hour|hours|day|days)$/i.exec(rate.trim());
  if (!m) {
    console.warn(`[gcp] Events.EventBridge "${constructId}": rate "${rate}" não reconhecido — usando "* * * * *" (a cada minuto) como fallback.`);
    return '* * * * *';
  }
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase().replace(/s$/, '');
  if (unit === 'minute') {
    if (n >= 1 && n <= 59 && 60 % n === 0) return `*/${n} * * * *`;
    const approx = Math.min(Math.max(n, 1), 59);
    console.warn(`[gcp] Events.EventBridge "${constructId}": rate "${rate}" não divide 60min igualmente — Cloud Scheduler não expressa esse intervalo num único cron; aproximando pra "*/${approx} * * * *".`);
    return `*/${approx} * * * *`;
  }
  if (unit === 'hour') {
    if (n >= 1 && n <= 23 && 24 % n === 0) return `0 */${n} * * *`;
    if (n % 24 === 0) return `0 0 */${Math.max(1, Math.round(n / 24))} * *`;
    const approx = Math.min(Math.max(n, 1), 23);
    console.warn(`[gcp] Events.EventBridge "${constructId}": rate "${rate}" não divide 24h igualmente — aproximando pra "0 */${approx} * * *".`);
    return `0 */${approx} * * *`;
  }
  return `0 0 */${Math.max(1, n)} * *`; // day
}

/**
 * Resolve o alvo (`rule.targetLambdaId`) de uma rule AGENDADA (cron/rate) pra
 * um bloco `http_target`/`pubsub_target` do google_cloud_scheduler_job, via o
 * registro global do projeto — mesmo mecanismo de resolveStepUrl em
 * constructs/workflow.ts (Function.Lambda/Compute.Container → Fqdn) mais o
 * caso extra que o Cloud Scheduler resolve nativamente: Messaging.Queue/
 * Messaging.Topic → pubsub_target (dispara pro tópico em vez de um HTTP
 * endpoint).
 */
function resolveScheduleTarget(rule: Record<string, unknown>, constructId: string, ruleName: string, registry: TFOutput['registry']): Record<string, unknown> | undefined {
  const targetLambdaId = rule.targetLambdaId as string | undefined;
  if (targetLambdaId) {
    const target = registry.byId.get(targetLambdaId);
    if (!target) {
      console.warn(`[gcp] Events.EventBridge "${constructId}" rule "${ruleName}": targetLambdaId "${targetLambdaId}" não encontrado no projeto — job criado sem target.`);
      return undefined;
    }
    if (target.type === 'Function.Lambda' || target.type === 'Compute.Container') {
      const uri = resolveGcpRef(ref(targetLambdaId, 'Fqdn'), registry) as string;
      return { http_target: [{ uri, http_method: 'POST' }] };
    }
    if (target.type === 'Messaging.Queue' || target.type === 'Messaging.Topic') {
      const topicName = resolveGcpRef(ref(targetLambdaId, 'Id'), registry) as string;
      return { pubsub_target: [{ topic_name: topicName }] };
    }
    console.warn(`[gcp] Events.EventBridge "${constructId}" rule "${ruleName}": targetLambdaId "${targetLambdaId}" aponta pra um "${target.type}", sem http_target/pubsub_target conhecido pro Cloud Scheduler — job criado sem target.`);
    return undefined;
  }
  if (typeof rule.targetArn === 'string' && rule.targetArn) {
    // ARN/URL literal (sem construct correspondente no projeto) — tratado como
    // endpoint HTTP, mesmo comportamento do push_endpoint anterior.
    return { http_target: [{ uri: rule.targetArn as string, http_method: 'POST' }] };
  }
  return undefined;
}

/**
 * account_id de `google_service_account` — mesma restrição de
 * `apiGatewayInvokerAccountId` (constructs/function.ts): `[a-z][a-z0-9-]{4,28}[a-z0-9]`
 * (6-30 chars). Base truncada pra sobrar espaço pro sufixo fixo `-pubsub-push`.
 */
function pubsubPushInvokerAccountId(constructId: string): string {
  const base = gcpName(constructId).slice(0, 17).replace(/-+$/, '') || 'topic';
  return `${base}-pubsub-push`.slice(0, 30).replace(/-+$/, '');
}

/**
 * SA dedicada para assinar (OIDC) os push subscriptions Pub/Sub→Cloud Function
 * de UM Messaging.Topic — mesmo padrão do gw-invoker de Function.ApiGateway
 * (ver constructs/function.ts, `apiGatewayInvokerAccountId`/`gatewayConfig`):
 * Cloud Functions gen2 rodam sobre Cloud Run e exigem IAM auth por padrão —
 * um push_config sem `oidc_token` chega ao Cloud Run com "Empty Authorization
 * header value" e é rejeitado com 401 "The request was not authenticated"
 * (confirmado em deploy real de fan-out: os consumers nunca recebiam a
 * mensagem publicada). A SA dedicada precisa de:
 *
 *  1. `roles/run.invoker` no Cloud Run service por trás de CADA
 *     Function.Lambda consumidora (uma vez por lambdaId DISTINTO, não por
 *     subscription — 2 subscriptions pra mesma function não duplicam o
 *     binding, mesma regra do gw-invoker);
 *  2. o service agent do Pub/Sub (`service-<projectNumber>@gcp-sa-pubsub...`)
 *     com `roles/iam.serviceAccountTokenCreator` NESTA SA — sem essa
 *     permissão o Pub/Sub não pode gerar um OIDC token assinado por ela ao
 *     fazer o push.
 *
 * Resolvemos o service agent via `google_project_service_identity`
 * (google-beta) em vez de montar o e-mail manualmente a partir do project
 * number (que exigiria um `data.google_project` auxiliar): o recurso expõe
 * `.email` já resolvido pelo próprio provider — o synth fica auto-contido,
 * sem depender do pré-flight do CLI (`REQUIRED_COMPUTE_SA_ROLES` em
 * packages/cli/src/deploy/gcp.ts, que cobre a default compute SA, não esta
 * SA dedicada). Emitido com tfId FIXO (`pubsub_sa`) — compartilhado entre
 * TODOS os Messaging.Topic do projeto (addResource com mesmo tfType/tfId é
 * idempotente, não duplica), mesmo raciocínio de dedupe do VPC connector
 * compartilhado (ver `vpcConnectorId` em constructs/function.ts).
 */
function buildPubsubPushInvoker(
  id: string,
  constructId: string,
  lambdaConsumerIds: Set<string>,
  r: TFOutput['resources'],
  ctx: TFOutput,
): string {
  ctx.needsGoogleBetaProvider = true;

  const saId = `${id}_push_sa`;
  addResource(r, 'google_service_account', saId, {
    account_id: pubsubPushInvokerAccountId(constructId),
    display_name: `Pub/Sub push invoker for ${constructId}`,
  });

  for (const lambdaId of lambdaConsumerIds) {
    const fnTfId = toTfId(lambdaId);
    addResource(r, 'google_cloud_run_v2_service_iam_member', `${id}_push_invoker_${fnTfId}`, {
      project: '${var.project_id}',
      location: '${var.gcp_region}',
      // Mesmo detalhe do gw-invoker (ver constructs/function.ts): o Cloud Run
      // service subjacente a uma Cloud Function gen2 usa o nome em lowercase,
      // não o `.name` da function (que preserva o PascalCase do construct.id).
      name: `\${lower(google_cloudfunctions2_function.${fnTfId}.name)}`,
      role: 'roles/run.invoker',
      member: `serviceAccount:\${google_service_account.${saId}.email}`,
    });
  }

  addResource(r, 'google_project_service_identity', 'pubsub_sa', {
    provider: 'google-beta',
    project: '${var.project_id}',
    service: 'pubsub.googleapis.com',
  });
  addResource(r, 'google_service_account_iam_member', `${saId}_token_creator`, {
    service_account_id: `\${google_service_account.${saId}.name}`,
    role: 'roles/iam.serviceAccountTokenCreator',
    member: `serviceAccount:\${google_project_service_identity.pubsub_sa.email}`,
  });

  return saId;
}

export function synthMessaging(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Messaging.Queue': {
      addResource(r, 'google_pubsub_topic', id, {
        name: construct.id,
        message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
      });
      addResource(r, 'google_pubsub_subscription', `${id}_sub`, {
        name: `${construct.id}-sub`,
        topic: `\${google_pubsub_topic.${id}.id}`,
        ack_deadline_seconds: (props.visibilityTimeoutSeconds as number) ?? 30,
        message_retention_duration: `${(props.messageRetentionSeconds as number) ?? 345600}s`,
      });
      return true;
    }

    case 'Messaging.Stream': {
      // Kinesis Data Stream (AWS) / Event Hub (Azure) → o análogo GCP é
      // Pub/Sub: um tópico onde produtores publicam e consumidores fazem
      // pull/push, sem o particionamento explícito de shards do Kinesis.
      // `shards` NÃO tem equivalente aqui — Pub/Sub é serverless e escala
      // automaticamente (sem provisionar throughput por shard) — é
      // silenciosamente ignorado, igual ao caveat de scaling do
      // Cache.Redis/Cache.Memcached documentado noutros construct.ts.
      const retentionHours = (props.retentionHours as number) ?? 24;
      addResource(r, 'google_pubsub_topic', id, {
        name: construct.id,
        message_retention_duration: `${retentionHours * 3600}s`,
        message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
      });
      return true;
    }

    case 'Messaging.Topic': {
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];
      addResource(r, 'google_pubsub_topic', id, {
        name: construct.id,
        message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
      });

      // Consumers Fn.Lambda distintos entre as subscriptions 'lambda' — coletado
      // ANTES do forEach pra criar a SA dedicada (+ bindings run.invoker/tokenCreator)
      // uma vez só por topic, não por subscription (ver buildPubsubPushInvoker).
      const lambdaConsumerIds = new Set(
        subscriptions.filter((s) => s.protocol === 'lambda').map((s) => s.endpoint),
      );
      const pushSaId = lambdaConsumerIds.size > 0
        ? buildPubsubPushInvoker(id, construct.id, lambdaConsumerIds, r, ctx)
        : undefined;

      subscriptions.forEach((s, i) => {
        const subProps: Record<string, unknown> = {
          name: `${construct.id}-sub-${i}`,
          topic: `\${google_pubsub_topic.${id}.id}`,
          ack_deadline_seconds: 30,
        };
        if (s.protocol === 'https' || s.protocol === 'http') {
          subProps.push_config = [{ push_endpoint: s.endpoint }];
        } else if (s.protocol === 'lambda') {
          subProps.push_config = [{
            push_endpoint: `\${google_cloudfunctions2_function.${toTfId(s.endpoint)}.service_config[0].uri}`,
            // Sem oidc_token, o push chega ao Cloud Run (Cloud Functions gen2)
            // sem Authorization header e é rejeitado com 401 "The request was
            // not authenticated" — ver buildPubsubPushInvoker.
            oidc_token: [{ service_account_email: `\${google_service_account.${pushSaId}.email}` }],
          }];
        }
        addResource(r, 'google_pubsub_subscription', `${id}_sub_${i}`, subProps);
      });
      return true;
    }

    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const busName = props.busName as string | undefined;
      if (busName && busName !== 'default') {
        const busId = toTfId(busName);
        addResource(r, 'google_pubsub_topic', busId, {
          name: busName,
          message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
        });
      }
      for (const rule of rules) {
        const ruleName = (rule.name as string) ?? 'rule';

        // Regra AGENDADA (cron/rate) — o equivalente GCP não é um tópico
        // Pub/Sub esperando evento nenhum (nada publica nele), é o Cloud
        // Scheduler chamando o alvo direto no horário — mesma exclusividade
        // mútua ScheduleExpression×EventPattern do AWS::Events::Rule (ver
        // packages/providers/aws/src/synth/constructs/messaging.ts).
        const schedule = rule.cron
          ? awsCronToUnixCron(rule.cron as string, construct.id)
          : rule.rate
            ? awsRateToUnixCron(rule.rate as string, construct.id)
            : undefined;

        if (schedule) {
          const jobId = toTfId(`${construct.id}_${ruleName}_schedule`);
          const target = resolveScheduleTarget(rule, construct.id, ruleName, ctx.registry);
          addResource(r, 'google_cloud_scheduler_job', jobId, {
            name: gcpName(`${construct.id}-${ruleName}-schedule`),
            description: (rule.description as string) ?? `Schedule ${ruleName} de ${construct.id}`,
            schedule,
            time_zone: 'Etc/UTC',
            region: '${var.gcp_region}',
            ...(target ?? {}),
          });
          continue;
        }

        const topicName = `${construct.id}-${ruleName}`;
        const topicId = toTfId(topicName);
        addResource(r, 'google_pubsub_topic', topicId, {
          name: topicName,
          message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
        });
        if (rule.targetArn) {
          addResource(r, 'google_pubsub_subscription', `${topicId}_sub`, {
            name: `${topicName}-sub`,
            topic: `\${google_pubsub_topic.${topicId}.id}`,
            push_config: [{ push_endpoint: rule.targetArn as string }],
            ack_deadline_seconds: 30,
          });
        }
      }
      return true;
    }

    default:
      return false;
  }
}
