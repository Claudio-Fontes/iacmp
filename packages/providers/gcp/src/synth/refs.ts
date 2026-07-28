import { BaseConstruct, Stack, Ref, isRef } from '@iacmp/core';
import { toTfId } from './constructs/common.js';

/**
 * Registro global constructId → construct (todas as stacks do projeto) +
 * mapa reverso constructId → atributos pedidos via ref() em QUALQUER stack.
 * Construído uma vez por `emitGCPTerraform` a partir de `allStacks` — o
 * mesmo papel do buildGraph do AWS, versão mínima para o synth GCP.
 *
 * O tf.json do GCP é um arquivo POR STACK, mas todos os arquivos de um mesmo
 * projeto vivem no MESMO diretório (`synth-out/gcp/`) e o Terraform combina
 * todo `*.tf.json` de um diretório num único root module — por isso uma ref
 * cross-stack pode virar `${google_x.y.z}` direto (sem variable/import),
 * desde que o recurso alvo exista em ALGUM .tf.json do mesmo diretório.
 */
export interface GCPRegistry {
  byId: Map<string, BaseConstruct>;
  refTargets: Map<string, Set<string>>;
}

export function buildRegistry(allStacks: Stack[]): GCPRegistry {
  const byId = new Map<string, BaseConstruct>();
  for (const s of allStacks) {
    for (const c of s.constructs) byId.set(c.id, c);
  }

  const refTargets = new Map<string, Set<string>>();
  const scan = (v: unknown): void => {
    if (isRef(v)) {
      const set = refTargets.get(v.constructId) ?? new Set<string>();
      set.add(v.attribute);
      refTargets.set(v.constructId, set);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) scan(item);
      return;
    }
    if (v && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) scan(val);
    }
  };
  for (const s of allStacks) {
    for (const c of s.constructs) scan(c.props);
  }

  return { byId, refTargets };
}

type AttrResolver = (tfId: string, target: BaseConstruct) => string;

interface GcpTypeDescriptor {
  tfType: string;
  /** tfId do recurso PRINCIPAL do tipo — default: toTfId(constructId). */
  tfId?: (constructId: string) => string;
  /** Atributo GCP por trás de Name (default: 'name'). */
  nameAttr?: string;
  /** Atributo GCP por trás de Id/Arn/*Arn (default: 'id'). */
  idAttr?: string;
  /** Atributo GCP por trás de Endpoint/Host — sem default; sem isto, o par lança erro claro. */
  hostAttr?: string;
  /** Atributo GCP por trás de Port (default: 'port'). */
  portAttr?: string;
  /** Atributo GCP por trás de Url — sem default. */
  urlAttr?: string;
  /** Overrides por atributo — têm prioridade sobre os fallbacks genéricos acima. */
  attrs?: Record<string, AttrResolver>;
}

const ARN_LIKE = new Set(['Arn', 'QueueArn', 'TopicArn', 'SecretArn', 'TargetGroupArn']);

// Mapa engine (Database.SQL) → porta padrão. Cloud SQL não expõe porta como
// atributo computado (é implícita do engine) — por isso é literal, não interpolação.
const SQL_PORT_MAP: Record<string, string> = {
  postgres: '5432',
  mysql: '3306',
  mariadb: '3306',
  sqlserver: '1433',
  oracle: '5432',
};

// Mapa engine (Database.SQL) → usuário default do google_sql_user criado sob
// demanda (só quando Username/Password é de fato referenciado — ver database.ts).
const SQL_DEFAULT_USER: Record<string, string> = {
  postgres: 'postgres',
  mysql: 'root',
  mariadb: 'root',
  sqlserver: 'sqlserver',
  oracle: 'postgres',
};

export function sqlDefaultUsername(engine: string | undefined): string {
  return SQL_DEFAULT_USER[engine ?? 'mysql'] ?? 'appuser';
}

export function sqlDefaultPort(engine: string | undefined): string {
  return SQL_PORT_MAP[engine ?? 'mysql'] ?? '3306';
}

const TYPE_DESCRIPTORS: Record<string, GcpTypeDescriptor> = {
  'Storage.Bucket': { tfType: 'google_storage_bucket', urlAttr: 'url' },
  'Storage.Archive': { tfType: 'google_storage_bucket', urlAttr: 'url' },
  'Storage.FileSystem': { tfType: 'google_filestore_instance' },

  // Database.DynamoDB não tem recurso TF próprio (ver constructs/database.ts):
  // é uma COLEÇÃO dentro do Firestore database `(default)` singleton (endereço
  // fixo `google_firestore_database.iacmp_default`, ver gcp-terraform.ts). Name/
  // Arn resolvem para o nome literal da coleção — NÃO é interpolação ${...},
  // não há atributo TF por trás de "nome de coleção". tfId aponta pro singleton
  // só como fallback defensivo, caso algum outro atributo caia no fallback
  // genérico abaixo (Name/Arn já são cobertos por attrs, então não chegam lá).
  'Database.DynamoDB': {
    tfType: 'google_firestore_database',
    tfId: () => 'iacmp_default',
    attrs: {
      Name: (_tfId, target) => target.id.toLowerCase(),
      Arn: (_tfId, target) => target.id.toLowerCase(),
    },
  },
  // Mesmo singleton do Database.DynamoDB acima — tfId fixo garante que
  // qualquer ref cai no endereço real (iacmp_default), não em toTfId(constructId)
  // (que não existe mais como recurso desde a dedup).
  'Database.DocumentDB': { tfType: 'google_firestore_database', tfId: () => 'iacmp_default' },
  'Database.SQL': {
    tfType: 'google_sql_database_instance',
    hostAttr: 'public_ip_address',
    attrs: {
      Port: (_tfId, target) => sqlDefaultPort((target.props as Record<string, unknown>).engine as string),
      Username: (tfId) => `\${google_sql_user.${tfId}_dbuser.name}`,
      Password: (tfId) => `\${random_password.${tfId}_dbpassword.result}`,
      // Com vpcId (DB privado — ver constructs/database.ts), ipv4_enabled é
      // false: o instance NÃO tem public_ip_address, só private_ip_address
      // (reachable via VPC peering). Sem este override, Endpoint/Host cairiam
      // no hostAttr fixo acima (public_ip_address) e o handler receberia um
      // valor vazio/inexistente para conectar.
      Endpoint: (tfId, target) => (
        (target.props as Record<string, unknown>).vpcId
          ? `\${google_sql_database_instance.${tfId}.private_ip_address}`
          : `\${google_sql_database_instance.${tfId}.public_ip_address}`
      ),
      Host: (tfId, target) => (
        (target.props as Record<string, unknown>).vpcId
          ? `\${google_sql_database_instance.${tfId}.private_ip_address}`
          : `\${google_sql_database_instance.${tfId}.public_ip_address}`
      ),
    },
  },

  'Cache.Redis': {
    tfType: 'google_redis_instance',
    hostAttr: 'host',
    portAttr: 'port',
    attrs: {
      // auth_enabled:true (ver constructs/database.ts) exige AUTH — sem este
      // atributo o handler não tem como obter o token e leva NOAUTH no connect.
      // auth_string só é conhecido após o apply (known-after-apply), mas o
      // terraform resolve a ordem certa via referência direta no env.
      AuthToken: (tfId) => `\${google_redis_instance.${tfId}.auth_string}`,
      // transit_encryption_mode:SERVER_AUTHENTICATION (ver constructs/database.ts)
      // usa um CA próprio do Memorystore (self-signed), não uma CA pública —
      // sem confiar nele explicitamente (tls.ca), o handshake TLS do cliente
      // (ioredis) rejeita o certificado e a conexão nunca completa. cert é
      // público (não é segredo), só o handler precisa dele para validar o peer.
      CaCert: (tfId) => `\${google_redis_instance.${tfId}.server_ca_certs[0].cert}`,
    },
  },
  'Cache.Memcached': { tfType: 'google_memcache_instance' },

  'Secret.Vault': { tfType: 'google_secret_manager_secret', nameAttr: 'secret_id' },
  'Certificate.TLS': { tfType: 'google_certificate_manager_certificate' },

  'Messaging.Queue': {
    tfType: 'google_pubsub_topic',
    attrs: {
      // GCP não tem "URL de fila" — o valor útil para publicar/consumir é o
      // nome do tópico Pub/Sub (ver notes do fixture gcp-queue-worker).
      QueueUrl: (tfId) => `\${google_pubsub_topic.${tfId}.name}`,
      ConnectionString: (tfId) => `\${google_pubsub_topic.${tfId}.name}`,
    },
  },
  'Messaging.Topic': { tfType: 'google_pubsub_topic' },
  'Messaging.Stream': {
    tfType: 'google_pubsub_topic',
    nameAttr: 'name',
    idAttr: 'id',
    attrs: {
      // Pub/Sub não tem "connection string" (SDK usa credenciais do projeto
      // GCP, não uma string de conexão) — o valor útil pro consumer é o
      // nome do tópico, mesmo padrão de ConnectionString de Messaging.Queue
      // acima (a Function consumidora usa isso pra abrir a subscription).
      ConnectionString: (tfId) => `\${google_pubsub_topic.${tfId}.name}`,
    },
  },

  'Function.Lambda': {
    tfType: 'google_cloudfunctions2_function',
    attrs: {
      Fqdn: (tfId) => `\${google_cloudfunctions2_function.${tfId}.service_config[0].uri}`,
    },
  },
  'Compute.Instance': { tfType: 'google_compute_instance' },
  'Compute.Container': {
    tfType: 'google_cloud_run_v2_service',
    attrs: {
      Fqdn: (tfId) => `\${google_cloud_run_v2_service.${tfId}.uri}`,
      DnsName: (tfId) => `\${google_cloud_run_v2_service.${tfId}.uri}`,
    },
  },
  'Compute.Kubernetes': { tfType: 'google_container_cluster', hostAttr: 'endpoint' },

  'Network.VPC': { tfType: 'google_compute_network', attrs: { VpcId: (tfId) => `\${google_compute_network.${tfId}.id}` } },
  'Network.Subnet': { tfType: 'google_compute_subnetwork', attrs: { SubnetId: (tfId) => `\${google_compute_subnetwork.${tfId}.id}` } },
  'Network.WAF': { tfType: 'google_compute_security_policy' },

  'Workflow.StepFunctions': { tfType: 'google_workflows_workflow' },
};

/**
 * ÚNICO ponto de resolução de Ref → interpolação Terraform no synth GCP.
 * Espelha `resolveRef` do AWS (packages/providers/aws/src/synth/resolvers.ts):
 * valida existência do constructId, valida o atributo para o tipo, resolve.
 */
export function resolveGcpRef(r: Ref, registry: GCPRegistry): unknown {
  const target = registry.byId.get(r.constructId);
  if (!target) {
    throw new Error(`Referência "${r.constructId}" não foi encontrada em nenhuma stack do projeto.`);
  }

  const descriptor = TYPE_DESCRIPTORS[target.type];
  if (!descriptor) {
    throw new Error(`Tipo "${target.type}" não tem atributos referenciáveis definidos no synth GCP. constructId: "${r.constructId}".`);
  }

  const tfId = descriptor.tfId ? descriptor.tfId(r.constructId) : toTfId(r.constructId);

  const override = descriptor.attrs?.[r.attribute];
  if (override) return override(tfId, target);

  let gcpAttr: string | undefined;
  if (r.attribute === 'Name') {
    gcpAttr = descriptor.nameAttr ?? 'name';
  } else if (r.attribute === 'Id' || ARN_LIKE.has(r.attribute)) {
    gcpAttr = descriptor.idAttr ?? 'id';
  } else if (r.attribute === 'Endpoint' || r.attribute === 'Host') {
    gcpAttr = descriptor.hostAttr;
  } else if (r.attribute === 'Port') {
    gcpAttr = descriptor.portAttr ?? 'port';
  } else if (r.attribute === 'Url') {
    gcpAttr = descriptor.urlAttr;
  }

  if (!gcpAttr) {
    throw new Error(
      `Atributo "${r.attribute}" não é suportado para o tipo "${target.type}" no synth GCP. ` +
      `constructId: "${r.constructId}".`,
    );
  }

  return `\${${descriptor.tfType}.${tfId}.${gcpAttr}}`;
}

/**
 * Aplica `resolveGcpRef` recursivamente em objetos/arrays — um `environment`
 * pode carregar vários ref() (ex: DB_HOST + DB_PORT + DB_USER + DB_PASSWORD).
 */
export function resolveRefsDeep(value: unknown, registry: GCPRegistry): unknown {
  if (isRef(value)) return resolveGcpRef(value, registry);
  if (Array.isArray(value)) return value.map((v) => resolveRefsDeep(v, registry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveRefsDeep(v, registry)]),
    );
  }
  return value;
}
