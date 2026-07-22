import { BaseConstruct, isRef } from '@iacmp/core';
import { expr, tag, toSym, crossParamName, outputName, SynthContext } from './shared';

export function synthesizeNetwork(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs, accountTier, cdnBucketRefs } = ctx;
  const props = (construct.props ?? {}) as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Network.VPC': {
      const vpcSubnets = ctx.subnetsByVpc.get(construct.id) ?? [];
      resources.push({
        sym,
        type: 'Microsoft.Network/virtualNetworks',
        apiVersion: '2023-04-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        properties: {
          addressSpace: { addressPrefixes: [(props.cidr as string) ?? '10.0.0.0/16'] },
          dhcpOptions: { dnsServers: [] },
          ...(vpcSubnets.length > 0 ? {
            subnets: vpcSubnets.map(s => ({
              name: s.id,
              properties: {
                addressPrefix: s.cidr,
                privateEndpointNetworkPolicies: s.public ? 'Disabled' : 'Enabled',
                ...(s.delegationService ? {
                  delegations: [{
                    name: 'delegation',
                    properties: { serviceName: s.delegationService },
                  }],
                } : {}),
              },
            })),
          } : {}),
        },
      });

      // Outputs cross-stack do resourceId da VNet e de cada subnet — só quando
      // ALGUM Database.SQL/Compute.Container com subnetIds em OUTRA stack
      // efetivamente consome (ver crossStackSubnetIds/crossStackVpcIds em
      // bicep.ts). Same-stack usa referência simbólica direta, sem output
      // (ver resolveSubnetForVnetIntegration em shared.ts).
      if (ctx.crossStackVpcIds.has(construct.id)) {
        outputs.push({ name: crossParamName(construct.id, 'VpcId'), type: 'string', value: `${sym}.id` });
      }
      for (const s of vpcSubnets) {
        if (!ctx.crossStackSubnetIds.has(s.id)) continue;
        outputs.push({
          name: crossParamName(s.id, 'SubnetId'),
          type: 'string',
          value: `resourceId('Microsoft.Network/virtualNetworks/subnets', ${sym}.name, '${s.id}')`,
        });
      }
      break;
    }

    case 'Network.Subnet': {
      // Subnets são declaradas inline na propriedade subnets[] do virtualNetworks
      // (via Network.VPC case + subnetsByVpc). Recursos separados causam
      // AnotherOperationInProgress — o ARM tenta criar subnets em paralelo no mesmo VNet.
      break;
    }

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];

      const protocolMap: Record<string, string> = { tcp: 'Tcp', udp: 'Udp', icmp: 'Icmp', '-1': '*' };
      const mapProtocol = (raw: unknown): string => {
        if (raw === undefined || raw === null) return '*';
        return protocolMap[String(raw).toLowerCase()] ?? '*';
      };

      const secRules = [
        ...ingress.map((r, i) => {
          if (r.cidr === undefined) {
            console.warn(`[azure] Security group rule sem CIDR; usando * — defina props.cidr explicitamente (${construct.id} ingress[${i}])`);
          }
          return {
            name: `ingress-rule-${i}`,
            properties: {
              priority: 100 + i,
              direction: 'Inbound',
              access: 'Allow',
              protocol: mapProtocol(r.protocol),
              sourcePortRange: '*',
              destinationPortRange: r.fromPort === r.toPort ? String(r.fromPort) : `${r.fromPort}-${r.toPort}`,
              sourceAddressPrefix: (r.cidr as string) ?? '*',
              destinationAddressPrefix: '*',
              description: (r.description as string) ?? '',
            },
          };
        }),
        ...egress.map((r, i) => ({
          name: `egress-rule-${i}`,
          properties: {
            priority: 200 + i,
            direction: 'Outbound',
            access: 'Allow',
            protocol: mapProtocol(r.protocol),
            sourcePortRange: '*',
            destinationPortRange: r.fromPort === r.toPort ? String(r.fromPort) : `${r.fromPort}-${r.toPort}`,
            sourceAddressPrefix: '*',
            destinationAddressPrefix: (r.cidr as string) ?? '*',
            description: (r.description as string) ?? '',
          },
        })),
      ];

      resources.push({
        sym,
        type: 'Microsoft.Network/networkSecurityGroups',
        apiVersion: '2023-04-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        properties: { securityRules: secRules },
      });
      break;
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const AWS_RULE_MAP: Record<string, { ruleSetType: string; ruleSetVersion: string }> = {
        AWSManagedRulesCommonRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesKnownBadInputsRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesAmazonIpReputationList: { ruleSetType: 'Microsoft_BotManagerRuleSet', ruleSetVersion: '1.0' },
        AWSManagedRulesBotControlRuleSet: { ruleSetType: 'Microsoft_BotManagerRuleSet', ruleSetVersion: '1.0' },
        AWSManagedRulesAdminProtectionRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesSQLiRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesLinuxRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesWindowsRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesPHPRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesWordPressRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
      };
      const customRules = rules.filter(r => {
        if (r.managedGroup) return false;
        if (r.rateLimit) return false;
        const ruleType = (r.type as string ?? '').toLowerCase();
        if (ruleType.includes('rate')) return false;
        return true;
      }).map((r, i) => ({
        name: (r.name as string) ?? `custom-rule-${i}`,
        priority: (r.priority as number) ?? (i + 1),
        ruleType: 'MatchRule',
        action: ({ allow: 'Allow', block: 'Block', log: 'Log' }[(r.action as string)?.toLowerCase() ?? 'block']) ?? 'Block',
        matchConditions: [{ matchVariables: [{ variableName: 'RemoteAddr' }], operator: 'IPMatch', matchValues: (r.matchValues as string[]) ?? ['192.0.2.0/24'], negationConditon: false }],
      }));
      const seenRuleSets = new Set<string>();
      const managedRules = rules.filter(r => r.managedGroup).reduce<Array<{ ruleSetType: string; ruleSetVersion: string }>>((acc, r) => {
        const group = r.managedGroup as string;
        const mapped = AWS_RULE_MAP[group] ?? { ruleSetType: 'OWASP', ruleSetVersion: '3.2' };
        const key = `${mapped.ruleSetType}@${mapped.ruleSetVersion}`;
        if (!seenRuleSets.has(key)) { seenRuleSets.add(key); acc.push(mapped); }
        return acc;
      }, []);
      resources.push({
        sym,
        type: 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies',
        apiVersion: '2023-04-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        properties: {
          policySettings: { requestBodyCheck: true, maxRequestBodySizeInKb: 128, fileUploadLimitInMb: 100, state: 'Enabled', mode: (props.mode as string) ?? 'Prevention' },
          customRules,
          managedRules: { managedRuleSets: managedRules.length > 0 ? managedRules : [{ ruleSetType: 'OWASP', ruleSetVersion: '3.2' }] },
        },
      });
      break;
    }

    case 'Network.LoadBalancer': {
      const allConstructs = ctx.globalIdx ? Array.from(ctx.globalIdx.values()) : Array.from(ctx.idx.values());
      const hasContainerAnywhere = allConstructs.some(c => c.type === 'Compute.Container');
      if (hasContainerAnywhere) {
        console.warn(
          `[azure] Network.LoadBalancer "${construct.id}": no-op — projeto contém Compute.Container ` +
          `cujo ingress externo (Container Apps) já provê load balancing HTTP público. ` +
          `Referencie o endpoint via output <ContainerId>Fqdn.`,
        );
        break;
      }
      const lbType = (props.type as string) ?? 'application';
      const listeners = (props.listeners as Array<Record<string, unknown>>) ?? [];
      const targetGroups = (props.targetGroups as Array<Record<string, unknown>>) ?? [];
      if (lbType === 'application') {
        resources.push({
          sym,
          type: 'Microsoft.Network/applicationGateways',
          apiVersion: '2023-04-01',
          name: construct.id,
          location: 'location',
          tags: tag(construct.id),
          properties: {
            sku: { name: 'Standard_v2', tier: 'Standard_v2', capacity: 2 },
            frontendIPConfigurations: [{ name: 'appGatewayFrontendIP', properties: { publicIPAddress: null } }],
            frontendPorts: listeners.map((l, i) => ({ name: `port${i}`, properties: { port: l.port } })),
            backendAddressPools: targetGroups.map(tg => ({ name: tg.name as string, properties: {} })),
            httpListeners: listeners.map((l, i) => ({ name: `listener${i}`, properties: { frontendPort: { id: `port${i}` }, protocol: (l.protocol as string).toLowerCase() === 'https' ? 'Https' : 'Http' } })),
            requestRoutingRules: [{ name: 'rule1', properties: { ruleType: 'Basic', priority: 100 } }],
          },
        });
      } else {
        resources.push({
          sym,
          type: 'Microsoft.Network/loadBalancers',
          apiVersion: '2023-04-01',
          name: construct.id,
          location: 'location',
          tags: tag(construct.id),
          sku: { name: 'Standard' },
          properties: {
            frontendIPConfigurations: [{ name: 'loadBalancerFrontEnd', properties: {} }],
            backendAddressPools: targetGroups.map(tg => ({ name: tg.name as string })),
            loadBalancingRules: listeners.map((l, i) => ({ name: `rule${i}`, properties: { frontendPort: l.port, backendPort: l.port, protocol: (l.protocol as string).toLowerCase() === 'tcp' ? 'Tcp' : 'Udp', enableFloatingIP: false } })),
          },
        });
      }
      break;
    }

    case 'Network.CDN': {
      const profileSym = `${sym}Profile`;
      const endpointSym = `${sym}Ep`;
      const ogSym = `${sym}Og`;
      const originSym = `${sym}Origin`;
      const routeSym = `${sym}Route`;

      const originsEarly = (props.origins as Array<Record<string, unknown>>) ?? [];
      const bucketRefRawEarly = originsEarly[0]?.bucketRef;
      const bucketRefEarly = isRef(bucketRefRawEarly) ? bucketRefRawEarly.constructId : bucketRefRawEarly as string | undefined;
      if (accountTier === 'free') {
        console.warn(`[azure] Network.CDN "${construct.id}": accountTier=free — Front Door indisponível em Free Trial; servindo direto do Storage público (sem CDN).`);
        if (bucketRefEarly) {
          const bSym = toSym(bucketRefEarly);
          const bucketConstructEarly = ctx.globalIdx.get(bucketRefEarly);
          const hasWebsiteHostingEarly = !!(bucketConstructEarly?.props as Record<string, unknown> | undefined)?.websiteHosting;
          cdnBucketRefs.add(bucketRefEarly);
          // Com websiteHosting: endpoint real do static website ($web, ativado no
          // deploy) — o único modo que resolve index/error document no root.
          // Sem websiteHosting: expõe o endpoint blob "cru" — um container Blob
          // comum não resolve documento default no root (GET / sempre 404), então
          // não fingimos que existe uma url de "site" funcional aqui (ver post-
          // processing de cdnBucketRefs em bicep.ts — não criamos mais o container
          // decorativo 'web' que nada nunca populava).
          const urlValue = hasWebsiteHostingEarly
            ? `${bSym}.properties.primaryEndpoints.web`
            : `${bSym}.properties.primaryEndpoints.blob`;
          outputs.push({ name: outputName(construct.id, 'Url'), type: 'string', value: urlValue });
        }
        break;
      }

      resources.push({
        sym: profileSym,
        type: 'Microsoft.Cdn/profiles',
        apiVersion: '2023-05-01',
        name: `${construct.id}-profile`,
        location: "'global'",
        sku: { name: 'Standard_AzureFrontDoor' },
        tags: tag(construct.id),
        properties: {},
      });

      resources.push({
        sym: endpointSym,
        type: 'Microsoft.Cdn/profiles/afdEndpoints',
        apiVersion: '2023-05-01',
        parent: profileSym,
        name: construct.id,
        location: "'global'",
        tags: tag(construct.id),
        properties: { enabledState: 'Enabled' },
      });

      resources.push({
        sym: ogSym,
        type: 'Microsoft.Cdn/profiles/originGroups',
        apiVersion: '2023-05-01',
        parent: profileSym,
        name: `${construct.id}-og`,
        properties: {
          loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3, additionalLatencyInMilliseconds: 50 },
          healthProbeSettings: { probePath: '/', probeRequestType: 'HEAD', probeProtocol: 'Https', probeIntervalInSeconds: 100 },
        },
      });

      const origins = (props.origins as Array<Record<string, unknown>>) ?? [];
      const bucketRefRaw = origins[0]?.bucketRef;
      const bucketRefId = isRef(bucketRefRaw) ? bucketRefRaw.constructId : bucketRefRaw as string | undefined;
      let hostNameExpr: unknown;

      if (bucketRefId) {
        const bucketSym = toSym(bucketRefId);
        const bucketConstruct = ctx.globalIdx.get(bucketRefId);
        const hasWebsiteHosting = !!(bucketConstruct?.props as Record<string, unknown> | undefined)?.websiteHosting;
        // Com websiteHosting: origem = endpoint de static website ($web) — o único
        // modo que resolve index/error document no root. Sem websiteHosting: aponta
        // pro endpoint blob cru, sem originPath — não existe mais o container
        // decorativo 'web' (nada nunca fazia upload nele; um container Blob comum
        // também não resolve documento default no root, então fingir uma origem
        // '/web' não tornava isso funcional). Ver post-processing de cdnBucketRefs
        // em bicep.ts.
        hostNameExpr = expr(`replace(replace(${bucketSym}.properties.primaryEndpoints.${hasWebsiteHosting ? 'web' : 'blob'},'https://',''),'/','')`);
        cdnBucketRefs.add(bucketRefId);
      } else {
        hostNameExpr = origins[0]?.domainName ?? '';
      }

      resources.push({
        sym: originSym,
        type: 'Microsoft.Cdn/profiles/originGroups/origins',
        apiVersion: '2023-05-01',
        parent: ogSym,
        name: `${construct.id}-origin`,
        properties: {
          hostName: hostNameExpr,
          originHostHeader: hostNameExpr,
          httpPort: 80,
          httpsPort: 443,
          priority: 1,
          weight: 1000,
          enabledState: 'Enabled',
        },
      });

      const routeProps: Record<string, unknown> = {
        originGroup: { id: expr(`${ogSym}.id`) },
        supportedProtocols: ['Http', 'Https'],
        patternsToMatch: ['/*'],
        forwardingProtocol: 'HttpsOnly',
        linkToDefaultDomain: 'Enabled',
        httpsRedirect: 'Enabled',
        enabledState: 'Enabled',
      };

      resources.push({
        sym: routeSym,
        type: 'Microsoft.Cdn/profiles/afdEndpoints/routes',
        apiVersion: '2023-05-01',
        parent: endpointSym,
        name: `${construct.id}-route`,
        properties: routeProps,
      });

      outputs.push({ name: outputName(construct.id, 'Url'), type: 'string', value: `${endpointSym}.properties.hostName` });
      break;
    }

    case 'Network.Dns': {
      const records = (props.records as Array<Record<string, unknown>>) ?? [];
      const zoneName = props.zoneName as string;
      resources.push({ sym, type: 'Microsoft.Network/dnsZones', apiVersion: '2018-05-01', name: zoneName, location: 'global', tags: tag(construct.id), properties: {} });
      for (let ri = 0; ri < records.length; ri++) {
        const r = records[ri];
        const recordType = (r.type as string).toLowerCase();
        resources.push({
          sym: `${sym}Record${ri}`, type: `Microsoft.Network/dnsZones/${recordType}`, apiVersion: '2018-05-01', parent: sym, name: r.name as string, location: 'global',
          properties: { TTL: (r.ttl as number) ?? 300, [`${recordType.toUpperCase()}Records`]: (r.values as string[]).map(v => ({ value: v })) },
        });
      }
      break;
    }
  }
}
