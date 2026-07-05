import { Stack, BaseConstruct } from './stack';
import { SQLEngine } from './constructs/database';
import { defaultPortForEngine, RDS_MIN_AZ_COUNT, isAuroraEngine } from './knowledge/database';
import { EnvironmentProfile } from './profile';
import { CONSTRUCT_TYPES } from './construct-types';

/**
 * Validação semântica provider-agnóstica que roda em SYNTH-TIME, sobre os
 * constructs abstratos — antes de qualquer template ser emitido. O objetivo é
 * transformar erros que hoje só aparecem no DEPLOY real (porta de SG errada,
 * RDS sem cobertura de 2 AZs, conflito de CIDR, referência quebrada) em erros
 * determinísticos que o usuário/IA vê imediatamente. Cada mensagem inclui a
 * correção, pois é reenviada para a IA no loop de auto-correção do `iacmp ai`.
 *
 * Retorna a lista de erros (vazia = ok). Não lança — quem chama decide.
 */
export function validateSemantics(stacks: Stack[], profile?: EnvironmentProfile): string[] {
  const errors: string[] = [];

  // Índice global constructId → { construct, stackName }
  const byId = new Map<string, { c: BaseConstruct; stack: string }>();
  for (const s of stacks) {
    for (const c of s.constructs) byId.set(c.id, { c, stack: s.name });
  }

  // Valor que NÃO é um id de construct gerenciado, e sim uma referência a infra
  // externa/literal (id real da nuvem, ARN, caminho) — esses não validamos.
  const looksLikeExternalRef = (v: string) =>
    /^(vpc|subnet|sg)-[0-9a-zA-Z]+$/.test(v) || v.includes(':') || v.includes('/') || v.startsWith('arn:');

  // Props que carregam referências a outros constructs (id como string).
  const SINGLE_REF_PROPS = ['vpcId', 'subnetId', 'attachTo', 'authorizerLambdaId', 'wafAclId'];
  const LIST_REF_PROPS = ['subnetIds', 'securityGroupIds'];

  for (const s of stacks) {
    for (const c of s.constructs) {
      const props = (c.props ?? {}) as Record<string, unknown>;

      // ── A) Referências quebradas ──────────────────────────────────────────
      // (value, rótulo do campo) para mensagens precisas.
      const refs: Array<[string, string]> = [];
      for (const k of SINGLE_REF_PROPS) {
        if (typeof props[k] === 'string') refs.push([props[k] as string, k]);
      }
      for (const k of LIST_REF_PROPS) {
        if (Array.isArray(props[k])) {
          for (const v of props[k] as unknown[]) if (typeof v === 'string') refs.push([v, k]);
        }
      }
      // routes[].lambdaId e routes[].authorizerLambdaId (Function.ApiGateway)
      if (Array.isArray(props.routes)) {
        for (const r of props.routes as Array<Record<string, unknown>>) {
          if (typeof r?.lambdaId === 'string') refs.push([r.lambdaId, 'routes[].lambdaId']);
          if (typeof r?.authorizerLambdaId === 'string') refs.push([r.authorizerLambdaId, 'routes[].authorizerLambdaId']);
        }
      }
      // origins[].bucketRef (Network.CDN)
      if (Array.isArray(props.origins)) {
        for (const o of props.origins as Array<Record<string, unknown>>) {
          if (typeof o?.bucketRef === 'string') refs.push([o.bucketRef, 'origins[].bucketRef']);
        }
      }
      for (const [ref, label] of refs) {
        if (looksLikeExternalRef(ref)) continue; // id real/externo — não gerenciado
        if (!byId.has(ref)) {
          errors.push(
            `${c.type} "${c.id}" referencia "${ref}" em ${label}, que não existe em nenhuma stack do projeto. ` +
            `Verifique o id — provavelmente um erro de digitação.`,
          );
        }
      }

      // ── G) Referências de env var (ex: "AppDB.Endpoint") ──────────────────
      // O synth resolve "<id>.<Field>" para o recurso real; se o <id> não
      // existe, o valor vira a STRING LITERAL e o app falha em runtime
      // (ENOTFOUND no host, secret inexistente). Pegamos o typo aqui.
      const env = props.environment as Record<string, unknown> | undefined;
      if (env && typeof env === 'object') {
        for (const [key, val] of Object.entries(env)) {
          if (typeof val !== 'string') continue;
          const m = /^([^.]+)\.(Endpoint|Port|SecretArn|Password)$/.exec(val);
          if (!m) continue;
          if (!byId.has(m[1])) {
            errors.push(
              `${c.type} "${c.id}": env var ${key}="${val}" referencia o construct "${m[1]}", que não existe. ` +
              `Sem um construct com esse id, o valor vira a string literal "${val}" e o app falha em runtime. ` +
              `Use o id real do banco (ex: o id do Database.SQL declarado).`,
            );
          }
        }
      }
    }
  }

  // ── B) maxAzs > 0 + Network.Subnet explícitas na mesma VPC ────────────────
  for (const s of stacks) {
    for (const c of s.constructs) {
      if (c.type !== 'Network.VPC') continue;
      const maxAzs = (c.props as Record<string, unknown>).maxAzs as number | undefined;
      if (!maxAzs || maxAzs <= 0) continue;
      const explicitSubnets = stacks.flatMap(st =>
        st.constructs.filter(x => x.type === 'Network.Subnet' && (x.props as Record<string, unknown>).vpcId === c.id),
      );
      if (explicitSubnets.length > 0) {
        errors.push(
          `Network.VPC "${c.id}" usa maxAzs: ${maxAzs} e também tem Network.Subnet explícitas ` +
          `(${explicitSubnets.map(x => x.id).join(', ')}) — são mutuamente exclusivos e geram conflito de CIDR. ` +
          `Use maxAzs: 0 quando declarar subnets manualmente.`,
        );
      }
    }
  }

  // ── C) CIDR de subnet fora do CIDR da VPC ─────────────────────────────────
  for (const s of stacks) {
    for (const c of s.constructs) {
      if (c.type !== 'Network.Subnet') continue;
      const sp = c.props as Record<string, unknown>;
      const vpcId = sp.vpcId as string | undefined;
      const cidr = sp.cidr as string | undefined;
      if (!vpcId || !cidr) continue;
      const vpc = byId.get(vpcId);
      if (!vpc || vpc.c.type !== 'Network.VPC') continue;
      const vpcCidr = (vpc.c.props as Record<string, unknown>).cidr as string | undefined;
      if (!vpcCidr) continue;
      if (!cidrContains(vpcCidr, cidr)) {
        errors.push(
          `Network.Subnet "${c.id}" tem CIDR ${cidr} fora do CIDR da VPC "${vpcId}" (${vpcCidr}). ` +
          `Ajuste o CIDR da subnet para um bloco contido em ${vpcCidr}.`,
        );
      }
    }
  }

  // ── D) RDS/DocumentDB exigem ≥2 AZs distintas nas subnets ──────────────────
  // ── E) Security Group do banco deve abrir a porta do engine ───────────────
  for (const s of stacks) {
    for (const c of s.constructs) {
      const isSql = c.type === 'Database.SQL';
      const isDocDb = c.type === 'Database.DocumentDB';
      if (!isSql && !isDocDb) continue;
      const dp = c.props as Record<string, unknown>;
      const subnetIds = (dp.subnetIds as string[] | undefined) ?? [];

      // Só validamos subnets que são constructs gerenciados — ids literais
      // (subnet-xxxx) são infra externa cuja AZ não conhecemos; confiamos no usuário.
      const managedSubnets = subnetIds
        .map(sid => byId.get(sid))
        .filter((x): x is { c: BaseConstruct; stack: string } => !!x && x.c.type === 'Network.Subnet');
      if (managedSubnets.length > 0) {
        const azs = new Set<string>();
        let withoutAz = 0;
        for (const sub of managedSubnets) {
          const az = (sub.c.props as Record<string, unknown>).availabilityZone as string | undefined;
          if (az) azs.add(az);
          else withoutAz++;
        }
        if (azs.size < RDS_MIN_AZ_COUNT) {
          errors.push(
            `${c.type} "${c.id}" usa subnets que cobrem ${azs.size} Availability Zone(s) distinta(s)` +
            (withoutAz > 0 ? ` (${withoutAz} subnet(s) sem availabilityZone explícito)` : '') +
            `. RDS/DocumentDB exigem ≥${RDS_MIN_AZ_COUNT} AZs. ` +
            `Defina availabilityZone diferente em cada Network.Subnet usada pelo banco (ex: us-east-1a e us-east-1b).`,
          );
        }
      }

      // E) só para SQL (DocumentDB tem porta fixa 27017 — fora do escopo agora)
      if (isSql) {
        const engine = dp.engine as SQLEngine;
        const port = defaultPortForEngine(engine);
        const sgIds = (dp.securityGroupIds as string[] | undefined) ?? [];
        for (const sgId of sgIds) {
          const sg = byId.get(sgId);
          if (!sg || sg.c.type !== 'Network.SecurityGroup') continue;
          const rules = (sg.c.props as Record<string, unknown>).ingressRules as
            | Array<{ protocol: string; fromPort?: number; toPort?: number }>
            | undefined;
          if (!rules || rules.length === 0) continue; // sem regras → não inferimos intenção
          const covers = rules.some(r => ruleCoversPort(r, port));
          if (!covers) {
            errors.push(
              `Network.SecurityGroup "${sgId}" protege o ${c.type} "${c.id}" (engine ${engine}, porta ${port}), ` +
              `mas nenhuma ingressRule abre a porta ${port}. ` +
              `Adicione uma regra { protocol: 'tcp', fromPort: ${port}, toPort: ${port}, cidr: '...' }.`,
            );
          }
        }
      }
    }
  }

  // ── H) Load Balancer 'application' (ALB) exige subnets em ≥2 AZs ───────────
  for (const s of stacks) {
    for (const c of s.constructs) {
      if (c.type !== 'Network.LoadBalancer') continue;
      const lp = c.props as Record<string, unknown>;
      const type = (lp.type as string) ?? 'application';
      if (type !== 'application') continue; // NLB tem regras diferentes — fora do escopo
      const subnetIds = (lp.subnetIds as string[] | undefined) ?? [];

      if (subnetIds.length === 0) {
        errors.push(
          `Network.LoadBalancer "${c.id}" (application/ALB) não tem subnetIds. ` +
          `Um ALB exige subnets em ≥2 Availability Zones. Informe subnetIds com 2 subnets em AZs diferentes.`,
        );
        continue;
      }
      const managed = subnetIds
        .map(sid => byId.get(sid))
        .filter((x): x is { c: BaseConstruct; stack: string } => !!x && x.c.type === 'Network.Subnet');
      if (managed.length > 0) {
        const azs = new Set<string>();
        for (const sub of managed) {
          const az = (sub.c.props as Record<string, unknown>).availabilityZone as string | undefined;
          if (az) azs.add(az);
        }
        if (azs.size < RDS_MIN_AZ_COUNT) {
          errors.push(
            `Network.LoadBalancer "${c.id}" (ALB) usa subnets que cobrem ${azs.size} AZ(s) distinta(s). ` +
            `ALB exige ≥${RDS_MIN_AZ_COUNT}. Use subnets com availabilityZone diferente (ex: us-east-1a e us-east-1b).`,
          );
        }
      }
    }
  }

  // ── I) Compute em VPC exige subnets ───────────────────────────────────────
  // Fargate (Compute.Container) sem subnets: o synth gera cluster+task mas PULA
  // o Service — deploy "passa" mas NADA roda (falha silenciosa). EKS exige ≥2 AZs.
  const countManagedAzs = (ids: string[]): { azs: number; managed: number } => {
    const m = ids.map(i => byId.get(i)).filter((x): x is { c: BaseConstruct; stack: string } => !!x && x.c.type === 'Network.Subnet');
    const azSet = new Set<string>();
    for (const sub of m) {
      const az = (sub.c.props as Record<string, unknown>).availabilityZone as string | undefined;
      if (az) azSet.add(az);
    }
    return { azs: azSet.size, managed: m.length };
  };
  for (const s of stacks) {
    for (const c of s.constructs) {
      const sp = c.props as Record<string, unknown>;
      const subnetIds = (sp.subnetIds as string[] | undefined) ?? [];
      if (c.type === 'Compute.Container') {
        if (subnetIds.length === 0) {
          errors.push(
            `Compute.Container "${c.id}" (Fargate) não tem subnetIds. Sem subnets o ECS Service não é criado ` +
            `e NADA roda (falha silenciosa no deploy). Informe subnetIds com subnets privadas em ≥2 AZs.`,
          );
        }
      }
      if (c.type === 'Compute.Kubernetes') {
        if (subnetIds.length === 0) {
          errors.push(
            `Compute.Kubernetes "${c.id}" (EKS) não tem subnetIds. EKS exige ≥2 subnets em AZs diferentes. Informe subnetIds.`,
          );
        } else {
          const { azs, managed } = countManagedAzs(subnetIds);
          if (managed > 0 && azs < RDS_MIN_AZ_COUNT) {
            errors.push(
              `Compute.Kubernetes "${c.id}" (EKS) usa subnets cobrindo ${azs} AZ(s). EKS exige ≥${RDS_MIN_AZ_COUNT}. ` +
              `Use subnets com availabilityZone diferente.`,
            );
          }
        }
      }
    }
  }

  // ── F) Conta free tier: recursos/configs que a AWS rejeita no deploy ───────
  // Só valida quando o tier é explicitamente 'free' (ou ausente, que assume free).
  if (!profile || profile.accountTier === 'free') {
    for (const s of stacks) {
      for (const c of s.constructs) {
        if (c.type !== 'Database.SQL') continue;
        const dp = c.props as Record<string, unknown>;
        const engine = dp.engine as SQLEngine;

        if (isAuroraEngine(engine)) {
          errors.push(
            `Database.SQL "${c.id}" usa engine Aurora ("${engine}"), que NÃO é elegível para free tier AWS. ` +
            `Para conta free tier use engine 'postgres' ou 'mysql' (instância única). ` +
            `Se a conta for paga, defina "accountTier": "standard" no iacmp.json.`,
          );
        }
        if (typeof dp.backupRetentionDays === 'number' && dp.backupRetentionDays > 0) {
          errors.push(
            `Database.SQL "${c.id}" tem backupRetentionDays: ${dp.backupRetentionDays}, mas free tier AWS só permite 0. ` +
            `Omita a propriedade (o synth deriva 0 do tier free) ou use "accountTier": "standard" se a conta for paga.`,
          );
        }
        if (dp.storageEncrypted === true) {
          errors.push(
            `Database.SQL "${c.id}" tem storageEncrypted: true, que não é suportado em RDS no free tier AWS. ` +
            `Omita a propriedade (o synth deriva false do tier free) ou use "accountTier": "standard" se a conta for paga.`,
          );
        }
      }
    }
  }

  // ── K) websiteHosting + OAC (bucket referenciado por CDN via bucketRef) ────
  // websiteHosting exige bucket PÚBLICO; OAC exige PRIVADO. Um bucket com
  // websiteHosting:true referenciado por um Network.CDN via bucketRef gera duas
  // BucketPolicies contraditórias (Principal:* vs cloudfront) e um bucket público
  // que contradiz o OAC. Para servir via CloudFront/OAC use websiteHosting:false.
  const bucketRefsFromCdn = new Set<string>();
  for (const s of stacks) {
    for (const c of s.constructs) {
      if (c.type !== 'Network.CDN') continue;
      const origins = (c.props as Record<string, unknown>).origins as Array<Record<string, unknown>> | undefined;
      for (const o of origins ?? []) {
        if (typeof o.bucketRef === 'string') bucketRefsFromCdn.add(o.bucketRef);
      }
    }
  }
  for (const s of stacks) {
    for (const c of s.constructs) {
      if (c.type !== 'Storage.Bucket') continue;
      if ((c.props as Record<string, unknown>).websiteHosting === true && bucketRefsFromCdn.has(c.id)) {
        errors.push(
          `Storage.Bucket "${c.id}" tem websiteHosting: true E é referenciado por um Network.CDN via bucketRef (OAC). ` +
          `São mutuamente exclusivos — websiteHosting torna o bucket público, OAC exige privado, gerando policies conflitantes. ` +
          `Para servir o site via CloudFront/OAC, use websiteHosting: false (o CDN serve o defaultRootObject).`,
        );
      }
    }
  }

  // ── J) Separação por camada: uma stack não deve misturar 3+ camadas âncora ─
  // Cada construct "âncora" pertence a uma camada. Uma única stack com âncoras
  // de 3+ camadas distintas é um monolito (ex: VPC + RDS + Lambda + Secret) —
  // dificulta deploy/destroy por camada. 1-2 camadas pode ser legítimo (ex:
  // Lambda + DynamoDB), por isso o limiar é 3 — só pega o caso inequívoco.
  const ANCHOR_LAYER: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(CONSTRUCT_TYPES)
        .filter(([, v]) => v.layer !== null)
        .map(([k, v]) => [k, v.layer as string]),
    ),
    // Alias legado: código gerado antes de Function.Lambda existir usava Fn.Lambda
    'Fn.Lambda': 'compute',
  };
  for (const s of stacks) {
    const layers = new Map<string, string[]>(); // camada → tipos encontrados
    for (const c of s.constructs) {
      const layer = ANCHOR_LAYER[c.type];
      if (!layer) continue;
      const list = layers.get(layer) ?? [];
      list.push(c.type);
      layers.set(layer, list);
    }
    if (layers.size >= 3) {
      errors.push(
        `Stack "${s.name}" mistura ${layers.size} camadas (${[...layers.keys()].join(', ')}) num único arquivo — é um monolito. ` +
        `Separe em stacks distintas por camada (stacks/network/, stacks/database/, stacks/compute/, stacks/storage/, stacks/security/, ...). ` +
        `Cada camada em seu próprio arquivo permite deploy/destroy independente.`,
      );
    }
  }

  return errors;
}

function ruleCoversPort(rule: { protocol: string; fromPort?: number; toPort?: number }, port: number): boolean {
  if (rule.protocol === '-1') return true;
  if (rule.fromPort === undefined || rule.toPort === undefined) return false;
  return rule.fromPort <= port && port <= rule.toPort;
}

// ── CIDR helpers (IPv4) ─────────────────────────────────────────────────────

function ipToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function parseCidr(cidr: string): { network: number; prefix: number } | null {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr.trim());
  if (!m) return null;
  const prefix = Number(m[2]);
  if (prefix < 0 || prefix > 32) return null;
  const ip = ipToInt(m[1]);
  if (ip === null) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ip & mask) >>> 0, prefix };
}

/** true se `inner` está inteiramente contido em `outer`. */
export function cidrContains(outer: string, inner: string): boolean {
  const o = parseCidr(outer);
  const i = parseCidr(inner);
  if (!o || !i) return false;
  if (i.prefix < o.prefix) return false; // inner é maior que outer
  const mask = o.prefix === 0 ? 0 : (0xffffffff << (32 - o.prefix)) >>> 0;
  return ((i.network & mask) >>> 0) === o.network;
}
