import { BaseConstruct, isRef, ref } from '@iacmp/core';
import { TFOutput, toTfId, addResource, gcpName } from './common.js';
import { resolveGcpRef } from '../refs.js';

/**
 * Acha os Compute.Container (Cloud Run) que este Network.LoadBalancer deve
 * atender — via o registro GLOBAL do projeto (cross-stack, mesmo padrão de
 * vpcId/queueId em constructs/function.ts), em duas etapas:
 *
 * 1. Wiring EXPLÍCITO: `Compute.Container.targetGroupArn` apontando pra este
 *    LB (Ref('<lbId>','TargetGroupArn') ou o atalho string '<lbId>.TargetGroupArn'
 *    — mesma convenção documentada em ComputeContainerProps e usada pelo synth
 *    AWS real, ver packages/providers/aws/src/synth/constructs/compute.ts).
 * 2. Fallback por CONVENÇÃO: nenhum Compute.Container do projeto usa
 *    targetGroupArn explícito, mas compartilha subnetIds com o LB — sinal de
 *    que foram desenhados pra andar juntos (ver notes do fixture
 *    gcp-container-lb, que documentou esse gap sem wiring explícito).
 */
function findLoadBalancerTargets(lbId: string, lbSubnets: Set<string>, ctx: TFOutput): BaseConstruct[] {
  const targets: BaseConstruct[] = [];
  for (const candidate of ctx.registry.byId.values()) {
    if (candidate.type !== 'Compute.Container') continue;
    const cProps = candidate.props as Record<string, unknown>;
    const tgArn = cProps.targetGroupArn;
    const explicitMatch = isRef(tgArn)
      ? tgArn.constructId === lbId && tgArn.attribute === 'TargetGroupArn'
      : typeof tgArn === 'string' && tgArn.replace(/\.TargetGroupArn$/, '') === lbId;
    if (explicitMatch) {
      targets.push(candidate);
      continue;
    }
    const cSubnets = (cProps.subnetIds as string[]) ?? [];
    if (lbSubnets.size > 0 && cSubnets.some((s) => lbSubnets.has(s))) {
      targets.push(candidate);
    }
  }
  return targets;
}

/**
 * Acha o Network.WAF que deve proteger este Network.LoadBalancer — mesma
 * ideia de resolução em 2 etapas de findLoadBalancerTargets acima, adaptada
 * a um gap documentado no fixture gcp-waf-lb (packages/knowledge/src/corpus/
 * gcp/waf-lb.ts): "AppWaf e AppLB sobem como recursos completamente
 * DESCONECTADOS — a Cloud Armor policy não protege NADA num deploy real",
 * porque NetworkLoadBalancerProps não tem (nem nunca teve) um campo típado
 * pra isso.
 *
 * 1. Wiring EXPLÍCITO: `props.wafAclId` no LB — o MESMO nome de campo usado
 *    (esse sim típado) em NetworkCDNProps.wafAclId e em Function.ApiGateway
 *    (props.wafAclId, ver o synth AWS real em
 *    packages/providers/aws/src/synth/constructs/function.ts). Não existe em
 *    NetworkLoadBalancerProps, mas `construct.props` é sempre
 *    Record<string,unknown> em runtime — uma stack (ou um handler
 *    dinâmico/gerado por IA) pode setá-lo mesmo sem o TS reconhecer o campo.
 *    Aceita o id de um Network.WAF do projeto (resolvido via ctx.registry)
 *    OU um self-link/nome literal de uma security_policy já existente.
 * 2. Fallback por CONVENÇÃO: nenhum LB do projeto referencia um WAF
 *    explicitamente, mas existe exatamente UM Network.WAF no projeto inteiro
 *    (registro cross-stack) — sinal de que foi desenhado para proteger o(s)
 *    LB(s) HTTP(S) do projeto (Cloud Armor via `security_policy` só se
 *    anexa a backend_service de LB application/HTTP(S), nunca a um NLB TCP).
 *    Com 0 ou 2+ WAFs no projeto e nenhum wiring explícito, não hà como
 *    adivinhar qual protege qual — não associa nada e avisa.
 */
function findWafForLoadBalancer(lbId: string, lbProps: Record<string, unknown>, lbType: string, ctx: TFOutput): string | undefined {
  const explicit = lbProps.wafAclId as string | undefined;
  if (explicit) {
    const target = ctx.registry.byId.get(explicit);
    if (target && target.type === 'Network.WAF') {
      return `\${google_compute_security_policy.${toTfId(explicit)}.id}`;
    }
    return explicit; // self-link/nome literal de uma security_policy fora do projeto
  }
  if (lbType !== 'application') return undefined;
  const wafs = Array.from(ctx.registry.byId.values()).filter((c) => c.type === 'Network.WAF');
  if (wafs.length === 1) {
    return `\${google_compute_security_policy.${toTfId(wafs[0].id)}.id}`;
  }
  if (wafs.length > 1) {
    console.warn(`[gcp] Network.LoadBalancer "${lbId}": ${wafs.length} Network.WAF encontrados no projeto e nenhum wiring explícito (props.wafAclId) — nenhum foi anexado ao backend_service (ambíguo, escolha ficaria arbitrária).`);
  }
  return undefined;
}

export function synthNetwork(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Network.VPC': {
      addResource(r, 'google_compute_network', id, {
        name: gcpName(construct.id),
        auto_create_subnetworks: false,
        routing_mode: 'REGIONAL',
      });
      return true;
    }

    case 'Network.Subnet': {
      const vpcId = props.vpcId as string | undefined;
      let networkRef: string;
      if (vpcId && r['google_compute_network'] && r['google_compute_network'][toTfId(vpcId)]) {
        networkRef = `\${google_compute_network.${toTfId(vpcId)}.id}`;
      } else {
        networkRef = vpcId ?? 'default';
      }
      addResource(r, 'google_compute_subnetwork', id, {
        name: gcpName(construct.id),
        network: networkRef,
        ip_cidr_range: props.cidr as string,
        region: '${var.gcp_region}',
        private_ip_google_access: !(props.public as boolean),
      });
      return true;
    }

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];
      const vpcId = props.vpcId as string | undefined;
      let networkRef: string;
      if (vpcId && r['google_compute_network'] && r['google_compute_network'][toTfId(vpcId)]) {
        networkRef = `\${google_compute_network.${toTfId(vpcId)}.id}`;
      } else {
        networkRef = vpcId ?? 'default';
      }

      ingress.forEach((rule, i) => {
        if (rule.cidr === undefined) {
          console.warn(`[gcp] Security group rule sem CIDR; usando 0.0.0.0/0 — defina props.cidr explicitamente (${construct.id} ingress[${i}])`);
        }
        const fwId = `${id}_ingress_${i}`;
        const protocol = (rule.protocol as string) === '-1' ? 'all' : rule.protocol as string;
        const allow: Record<string, unknown> = { protocol };
        if (protocol !== 'all') {
          allow.ports = rule.fromPort === rule.toPort
            ? [`${rule.fromPort}`]
            : [`${rule.fromPort}-${rule.toPort}`];
        }
        addResource(r, 'google_compute_firewall', fwId, {
          name: `${gcpName(construct.id)}-ingress-${i}`,
          network: networkRef,
          direction: 'INGRESS',
          priority: 1000 + i,
          allow: [allow],
          source_ranges: [(rule.cidr as string) ?? '0.0.0.0/0'],
        });
      });

      const egressList = egress.length > 0 ? egress : [
        { protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0' },
      ];
      egressList.forEach((rule, i) => {
        const fwId = `${id}_egress_${i}`;
        const protocol = (rule.protocol as string) === '-1' ? 'all' : rule.protocol as string;
        const allow: Record<string, unknown> = { protocol };
        if (protocol !== 'all' && rule.fromPort !== 0) {
          allow.ports = rule.fromPort === rule.toPort
            ? [`${rule.fromPort}`]
            : [`${rule.fromPort}-${rule.toPort}`];
        }
        addResource(r, 'google_compute_firewall', fwId, {
          name: `${gcpName(construct.id)}-egress-${i}`,
          network: networkRef,
          direction: 'EGRESS',
          priority: 1000 + i,
          allow: [allow],
          destination_ranges: [(rule.cidr as string) ?? '0.0.0.0/0'],
        });
      });
      return true;
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      // Cloud Armor só aceita allow / deny(403|404|502) / rate_based_ban /
      // redirect / throttle — a action agnóstica 'block'/'deny' vira 'deny(403)'
      // (o apply rejeita 'block': "Invalid action: block").
      const wafAction = (a?: string): string => (a === 'allow' ? 'allow' : 'deny(403)');
      const securityRules = rules.map((rule, i) => ({
        priority: (rule.priority as number) ?? (i + 1),
        action: wafAction(rule.action as string),
        match: rule.managedGroup
          ? { expr: [{ expression: 'evaluatePreconfiguredExpr("sqli-stable")' }] }
          : { versioned_expr: 'SRC_IPS_V1', config: [{ src_ip_ranges: (rule.sourceIps as string[]) ?? ['*'] }] },
        description: (rule.description as string) ?? '',
      }));
      addResource(r, 'google_compute_security_policy', id, {
        name: gcpName(construct.id),
        rule: [
          ...securityRules,
          {
            priority: 2147483647,
            action: wafAction(props.defaultAction as string),
            match: { versioned_expr: 'SRC_IPS_V1', config: [{ src_ip_ranges: ['*'] }] },
            description: 'Default rule',
          },
        ],
      });
      return true;
    }

    case 'Network.LoadBalancer': {
      const lbType = (props.type as string) ?? 'application';

      // Backends: só Compute.Container (Cloud Run) — serverless NEG é o único
      // tipo de backend que este synth sabe montar hoje; instance groups
      // (Compute.Instance/AutoScaling) ficam fora de escopo (ver Bug B).
      const lbSubnets = new Set((props.subnetIds as string[]) ?? []);
      const targets = lbType === 'application' ? findLoadBalancerTargets(construct.id, lbSubnets, ctx) : [];
      const backends = targets.map((target) => {
        const targetTfId = toTfId(target.id);
        const negId = `${targetTfId}_neg`;
        // Serverless NEG — a "ponte" entre um backend_service (que só sabe
        // falar com NEGs/instance groups) e um Cloud Run service (que não tem
        // instance group nenhum, é 100% gerenciado).
        addResource(r, 'google_compute_region_network_endpoint_group', negId, {
          name: `${gcpName(target.id)}-neg`,
          region: '${var.gcp_region}',
          network_endpoint_type: 'SERVERLESS',
          cloud_run: [{ service: `\${google_cloud_run_v2_service.${targetTfId}.name}` }],
        });
        return { group: `\${google_compute_region_network_endpoint_group.${negId}.id}` };
      });

      const wafPolicy = findWafForLoadBalancer(construct.id, props, lbType, ctx);
      addResource(r, 'google_compute_backend_service', `${id}_backend`, {
        name: `${gcpName(construct.id)}-backend`,
        protocol: lbType === 'network' ? 'TCP' : 'HTTP',
        load_balancing_scheme: (props.scheme as string) === 'internal' ? 'INTERNAL' : 'EXTERNAL',
        ...(backends.length > 0 ? { backend: backends } : {}),
        ...(wafPolicy ? { security_policy: wafPolicy } : {}),
      });
      if (lbType === 'application') {
        addResource(r, 'google_compute_url_map', `${id}_url_map`, {
          name: `${gcpName(construct.id)}-url-map`,
          default_service: `\${google_compute_backend_service.${id}_backend.id}`,
        });
        addResource(r, 'google_compute_target_http_proxy', `${id}_http_proxy`, {
          name: `${gcpName(construct.id)}-http-proxy`,
          url_map: `\${google_compute_url_map.${id}_url_map.id}`,
        });
        addResource(r, 'google_compute_global_forwarding_rule', `${id}_forwarding_rule`, {
          name: `${gcpName(construct.id)}-forwarding-rule`,
          target: `\${google_compute_target_http_proxy.${id}_http_proxy.id}`,
          port_range: '80',
          load_balancing_scheme: 'EXTERNAL',
        });
      }
      return true;
    }

    case 'Network.CDN': {
      const origins = (props.origins as Array<Record<string, unknown>>) ?? [];
      const firstOrigin = origins[0];
      // Atalho agnóstico origins[].bucketRef (mesmo campo do CDN AWS, ver
      // packages/providers/aws/src/synth/constructs/network.ts) tem prioridade
      // sobre bucketName/domainName literais — resolve o id do construct pro
      // nome real do bucket via o registro cross-stack (mesmo mecanismo do
      // Bug D acima / resolveGcpRef).
      const bucketRefId = typeof firstOrigin?.bucketRef === 'string' ? (firstOrigin.bucketRef as string) : undefined;
      const bucketRefTarget = bucketRefId ? ctx.registry.byId.get(bucketRefId) : undefined;
      const bucketName = bucketRefTarget
        ? (resolveGcpRef(ref(bucketRefId as string, 'Name'), ctx.registry) as string)
        : (bucketRefId as string | undefined) // id não encontrado no registro: trata como nome literal
          ?? (firstOrigin?.bucketName as string) ?? (firstOrigin?.domainName as string) ?? construct.id;
      addResource(r, 'google_compute_backend_bucket', `${id}_backend_bucket`, {
        name: `${gcpName(construct.id)}-backend-bucket`,
        bucket_name: bucketName,
        enable_cdn: true,
      });
      addResource(r, 'google_compute_url_map', `${id}_url_map`, {
        name: `${gcpName(construct.id)}-url-map`,
        default_service: `\${google_compute_backend_bucket.${id}_backend_bucket.id}`,
      });
      return true;
    }

    case 'Network.Dns': {
      const records = (props.records as Array<Record<string, unknown>>) ?? [];
      const zoneName = (props.zoneName as string).replace(/\./g, '-').replace(/-+$/, '');
      const zoneId = toTfId(`${zoneName}_zone`);
      addResource(r, 'google_dns_managed_zone', zoneId, {
        name: gcpName(`${zoneName}-zone`),
        dns_name: `${props.zoneName as string}.`,
        visibility: 'public',
      });
      if (records.length > 0) {
        const recId = toTfId(`${zoneName}_records`);
        addResource(r, 'google_dns_record_set', recId, {
          name: `${(records[0].name as string)}.`,
          managed_zone: `\${google_dns_managed_zone.${zoneId}.name}`,
          type: records[0].type as string,
          ttl: (records[0].ttl as number) ?? 300,
          rrdatas: records[0].values as string[],
        });
      }
      return true;
    }

    default:
      return false;
  }
}
