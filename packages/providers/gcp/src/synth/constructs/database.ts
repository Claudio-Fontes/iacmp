import { BaseConstruct } from '@iacmp/core';
import { CACHE_TIER_MAP, CACHE_CAPACITY_MAP } from '../common.js';
import { sqlDefaultUsername } from '../refs.js';
import { TFOutput, toTfId, addResource, gcpName } from './common.js';

/**
 * Sinaliza que o projeto precisa do Firestore database `(default)` — usado
 * por Database.DynamoDB (tabela → coleção) e Database.DocumentDB (banco
 * nativo). NUNCA emite o recurso aqui: o Firestore só permite UM `(default)`
 * por projeto, e este código roda por construct/stack — declarar o mesmo
 * `name: "(default)"` em endereços TF diferentes por stack faria o Terraform
 * tentar criar 2+ vezes o mesmo database real (a API do Firestore rejeita
 * com "already exists" no 2º apply). Quem emite o singleton, uma vez por
 * projeto, é `emitGCPProviders` (gcp-terraform.ts) — ver TFOutput.needsFirestoreDefault.
 */
function markFirestoreDefault(ctx: TFOutput, props: Record<string, unknown>): boolean {
  ctx.needsFirestoreDefault = true;
  if (props.deletionProtection as boolean) ctx.firestoreDeletionProtection = true;
  return true;
}

export function synthDatabase(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const edition = (props.edition as string) ?? '';
      const dbVersionMap: Record<string, string> = {
        mysql: 'MYSQL_8_0',
        postgres: 'POSTGRES_15',
        mariadb: 'MYSQL_8_0',
        sqlserver: `SQLSERVER_2019_${(edition || 'EXPRESS').toUpperCase()}`,
        oracle: 'POSTGRES_15',
      };
      const dbVersion = dbVersionMap[engine] ?? 'MYSQL_8_0';
      // vpcId presente = intenção de DB privado (sem IP público), alcançável só
      // por quem está na mesma VPC (ex: Cloud Function com VPC Access Connector).
      // Cloud SQL exige "private services access" para isso: um range de IPs
      // internos reservado (google_compute_global_address, purpose VPC_PEERING)
      // + um peering de serviço (google_service_networking_connection) entre a
      // VPC e a rede gerenciada do Cloud SQL — SEM os dois o apply do
      // google_sql_database_instance com ipv4_enabled:false falha (a rede
      // privada ainda não existe). Esses dois recursos são de ESCOPO DE VPC
      // (não por-instância) e são emitidos uma vez por VPC em emitGCPProviders
      // (ver ctx.privateNetworkVpcIds + buildPrivateServiceNetworkingResources
      // em gcp-terraform.ts) — mesmo raciocínio de dedup do Firestore
      // `(default)` singleton acima, mas chaveado por VPC em vez de projeto
      // inteiro, já que dá pra ter várias VPCs num projeto GCP.
      const vpcId = props.vpcId as string | undefined;
      const vpcTfId = vpcId ? toTfId(vpcId) : undefined;
      if (vpcId) ctx.privateNetworkVpcIds.add(vpcId);
      addResource(r, 'google_sql_database_instance', id, {
        name: gcpName(construct.id),
        database_version: dbVersion,
        region: '${var.gcp_region}',
        settings: [{
          tier: (props.instanceType as string) ?? 'db-f1-micro',
          backup_configuration: [{ enabled: true }],
          availability_type: (props.multiAz as boolean) ? 'REGIONAL' : 'ZONAL',
          ...(vpcId ? {
            ip_configuration: [{
              ipv4_enabled: false,
              private_network: `\${google_compute_network.${vpcTfId}.id}`,
            }],
          } : {}),
        }],
        deletion_protection: false,
        // Ordem de apply: a private network precisa existir ANTES do Cloud SQL
        // tentar se conectar a ela (ver comentário acima) — sem este depends_on
        // o terraform pode tentar criar os dois em paralelo e o SQL falha.
        ...(vpcId ? { depends_on: [`google_service_networking_connection.${vpcTfId}_psa`] } : {}),
      });
      ctx.outputs[`${construct.id}ConnectionName`] = { value: `\${google_sql_database_instance.${id}.connection_name}` };

      // google_sql_user + random_password só existem quando alguma outra stack
      // do projeto de fato referencia Username/Password via ref() (ver refs.ts
      // TYPE_DESCRIPTORS['Database.SQL'].attrs) — sem isso não há valor real de
      // senha para resolver (Terraform nunca expõe senha como atributo computado).
      const refAttrs = ctx.registry.refTargets.get(construct.id);
      if (refAttrs && (refAttrs.has('Username') || refAttrs.has('Password'))) {
        addResource(r, 'random_password', `${id}_dbpassword`, {
          length: 20,
          special: false,
        });
        addResource(r, 'google_sql_user', `${id}_dbuser`, {
          name: sqlDefaultUsername(engine),
          instance: `\${google_sql_database_instance.${id}.name}`,
          password: `\${random_password.${id}_dbpassword.result}`,
          // ABANDON: no destroy, o terraform NÃO tenta dropar o user — só o
          // remove do state. Para postgres o `name` é o superuser built-in
          // (`postgres`), que não pode ser dropado quando há objetos dependentes
          // (tabelas criadas pelo handler) → "role postgres cannot be dropped".
          // A instância é deletada de qualquer forma e leva o user junto.
          deletion_policy: 'ABANDON',
        });
        ctx.needsRandomProvider = true;
      }
      return true;
    }

    case 'Database.DocumentDB':
      return markFirestoreDefault(ctx, props);

    // GCP não tem um KV/documento equivalente ao DynamoDB — o runtime table()
    // (packages/runtime/src/gcp/index.ts) fala com Firestore
    // (getFirestore().collection(name)), não Bigtable: cada Database.DynamoDB
    // é apenas uma COLEÇÃO dentro do Firestore database `(default)` do
    // projeto, criada on-write, sem recurso TF próprio (uma "tabela" não
    // precisa ser provisionada). Só garantimos que o `(default)` existe —
    // mesmo singleton que Database.DocumentDB usa acima (dedup em
    // gcp-terraform.ts). Name/Arn resolvem para o nome literal da coleção
    // (ver TYPE_DESCRIPTORS['Database.DynamoDB'] em refs.ts) — não há
    // interpolação ${...} porque não há atributo TF por trás.
    case 'Database.DynamoDB':
      return markFirestoreDefault(ctx, props);

    case 'Cache.Redis': {
      const nodeType = (props.nodeType as string) ?? 'small';
      // authorized_network: o Memorystore precisa ficar na MESMA VPC do VPC
      // Access Connector da function (senão a Cloud Function em VPC não alcança
      // o private IP do Redis → timeout de conexão). Sem vpcId, cai na `default`.
      // Referência cross-stack (a VPC costuma estar em outra stack) — o terraform
      // resolve no módulo combinado.
      const vpcId = props.vpcId as string | undefined;
      addResource(r, 'google_redis_instance', id, {
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        tier: CACHE_TIER_MAP[nodeType] ?? 'BASIC',
        memory_size_gb: CACHE_CAPACITY_MAP[nodeType] ?? 1,
        region: '${var.gcp_region}',
        redis_version: 'REDIS_7_0',
        auth_enabled: true,
        transit_encryption_mode: 'SERVER_AUTHENTICATION',
        ...(vpcId ? { authorized_network: `\${google_compute_network.${toTfId(vpcId)}.id}` } : {}),
      });
      ctx.outputs[`${construct.id}RedisHost`] = { value: `\${google_redis_instance.${id}.host}` };
      ctx.outputs[`${construct.id}RedisPort`] = { value: `\${google_redis_instance.${id}.port}` };
      // auth_enabled:true exige AUTH — sem expor o auth_string, o handler não
      // tem como obter o token e leva NOAUTH Authentication required no connect
      // (ver ref() attrs.AuthToken em refs.ts para consumo via env da function).
      // sensitive:true obrigatório — auth_string é marcado sensitive pelo provider;
      // um output que o referencia sem sensitive:true faz o terraform recusar o apply.
      ctx.outputs[`${construct.id}RedisAuthString`] = { value: `\${google_redis_instance.${id}.auth_string}`, sensitive: true };
      // transit_encryption_mode:SERVER_AUTHENTICATION faz o Memorystore emitir
      // seu próprio CA (self-signed), diferente das CAs do sistema — sem expor
      // este cert, o handshake TLS do handler (ioredis) rejeita o servidor
      // (ver ref() attrs.CaCert em refs.ts para consumo via env da function).
      // Não é sensitive: é o certificado público da CA, não uma chave/segredo.
      ctx.outputs[`${construct.id}RedisCaCert`] = { value: `\${google_redis_instance.${id}.server_ca_certs[0].cert}` };
      return true;
    }

    case 'Cache.Memcached': {
      addResource(r, 'google_memcache_instance', id, {
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        region: '${var.gcp_region}',
        node_count: (props.numCacheNodes as number) ?? 2,
        node_config: [{ cpu_count: 1, memory_size_mb: 1024 }],
      });
      return true;
    }

    case 'Secret.Vault': {
      const secretId = construct.id.replace(/[^a-zA-Z0-9_-]/g, '-');
      addResource(r, 'google_secret_manager_secret', id, {
        secret_id: secretId,
        replication: [{ auto: [{}] }],
      });
      // Secret.Vault sempre nasce com valor auto-gerado (ver AWS GenerateSecretString)
      // — sem uma google_secret_manager_secret_version, o secret existe mas não tem
      // nenhuma versão, e `accessSecretVersion(.../versions/latest)` falha com
      // 5 NOT_FOUND "has no versions" (confirmado em deploy real). Mesmo padrão do
      // random_password usado em Database.SQL acima.
      addResource(r, 'random_password', `${id}_secretvalue`, {
        length: 32,
        special: false,
      });
      addResource(r, 'google_secret_manager_secret_version', `${id}_v1`, {
        secret: `\${google_secret_manager_secret.${id}.id}`,
        secret_data: `\${random_password.${id}_secretvalue.result}`,
      });
      ctx.needsRandomProvider = true;
      ctx.outputs[`${construct.id}SecretName`] = { value: `\${google_secret_manager_secret.${id}.secret_id}` };
      return true;
    }

    case 'Certificate.TLS': {
      const sans = (props.subjectAlternativeNames as string[]) ?? [];
      addResource(r, 'google_certificate_manager_certificate', id, {
        name: construct.id.replace(/[^a-zA-Z0-9-]/g, '-'),
        managed: [{ domains: [props.domainName as string, ...sans] }],
      });
      return true;
    }

    default:
      return false;
  }
}
