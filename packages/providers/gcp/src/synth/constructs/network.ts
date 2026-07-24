import { BaseConstruct } from '@iacmp/core';
import { TFOutput, toTfId, addResource } from './common.js';

export function synthNetwork(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Network.VPC': {
      addResource(r, 'google_compute_network', id, {
        name: construct.id,
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
        name: construct.id,
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
          name: `${construct.id}-ingress-${i}`,
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
          name: `${construct.id}-egress-${i}`,
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
      const securityRules = rules.map((rule, i) => ({
        priority: (rule.priority as number) ?? (i + 1),
        action: (rule.action as string) ?? 'allow',
        match: rule.managedGroup
          ? { expr: [{ expression: 'evaluatePreconfiguredExpr("sqli-stable")' }] }
          : { versioned_expr: 'SRC_IPS_V1', config: [{ src_ip_ranges: (rule.sourceIps as string[]) ?? ['*'] }] },
        description: (rule.description as string) ?? '',
      }));
      addResource(r, 'google_compute_security_policy', id, {
        name: construct.id,
        rule: [
          ...securityRules,
          {
            priority: 2147483647,
            action: (props.defaultAction as string) ?? 'allow',
            match: { versioned_expr: 'SRC_IPS_V1', config: [{ src_ip_ranges: ['*'] }] },
            description: 'Default rule',
          },
        ],
      });
      return true;
    }

    case 'Network.LoadBalancer': {
      const lbType = (props.type as string) ?? 'application';
      addResource(r, 'google_compute_backend_service', `${id}_backend`, {
        name: `${construct.id}-backend`,
        protocol: lbType === 'network' ? 'TCP' : 'HTTP',
        load_balancing_scheme: (props.scheme as string) === 'internal' ? 'INTERNAL' : 'EXTERNAL',
      });
      if (lbType === 'application') {
        addResource(r, 'google_compute_url_map', `${id}_url_map`, {
          name: `${construct.id}-url-map`,
          default_service: `\${google_compute_backend_service.${id}_backend.id}`,
        });
        addResource(r, 'google_compute_target_http_proxy', `${id}_http_proxy`, {
          name: `${construct.id}-http-proxy`,
          url_map: `\${google_compute_url_map.${id}_url_map.id}`,
        });
        addResource(r, 'google_compute_global_forwarding_rule', `${id}_forwarding_rule`, {
          name: `${construct.id}-forwarding-rule`,
          target: `\${google_compute_target_http_proxy.${id}_http_proxy.id}`,
          port_range: '80',
          load_balancing_scheme: 'EXTERNAL',
        });
      }
      return true;
    }

    case 'Network.CDN': {
      const origins = (props.origins as Array<Record<string, unknown>>) ?? [];
      const bucketName = (origins[0]?.bucketName as string) ?? (origins[0]?.domainName as string) ?? construct.id;
      addResource(r, 'google_compute_backend_bucket', `${id}_backend_bucket`, {
        name: `${construct.id}-backend-bucket`,
        bucket_name: bucketName,
        enable_cdn: true,
      });
      addResource(r, 'google_compute_url_map', `${id}_url_map`, {
        name: `${construct.id}-url-map`,
        default_service: `\${google_compute_backend_bucket.${id}_backend_bucket.id}`,
      });
      return true;
    }

    case 'Network.Dns': {
      const records = (props.records as Array<Record<string, unknown>>) ?? [];
      const zoneName = (props.zoneName as string).replace(/\./g, '-').replace(/-+$/, '');
      const zoneId = toTfId(`${zoneName}_zone`);
      addResource(r, 'google_dns_managed_zone', zoneId, {
        name: `${zoneName}-zone`,
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
