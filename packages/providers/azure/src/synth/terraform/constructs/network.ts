import { BaseConstruct, isRef } from '@iacmp/core';
import type { Ref } from '@iacmp/core';
import { AzureTFCtx, addRes, toTFId, RG_NAME, RG_LOCATION } from '../common';

/** Network.VPC/Subnet/SecurityGroup/WAF → VNet, Subnet, NSG e WAF policy. */
export function synthNetwork(c: BaseConstruct, ctx: AzureTFCtx): boolean {
  const p = (c.props ?? {}) as Record<string, unknown>;
  const id = toTFId(c.id);
  const rg = RG_NAME;
  const loc = RG_LOCATION;

  switch (c.type) {
    case 'Network.VPC': {
      const cidr = (p.cidr as string) ?? '10.0.0.0/16';
      addRes(ctx, 'azurerm_virtual_network', id, {
        name: `${id.replace(/_/g, '-')}-vnet`,
        resource_group_name: rg,
        location: loc,
        address_space: [cidr],
      });
      return true;
    }

    case 'Network.Subnet': {
      const vpcIdProp = p.vpcId;
      let vnetName: string;
      if (isRef(vpcIdProp)) {
        const r = vpcIdProp as Ref;
        const vnetId = toTFId(r.constructId);
        vnetName = `\${azurerm_virtual_network.${vnetId}.name}`;
      } else {
        vnetName = `\${azurerm_virtual_network.${toTFId(vpcIdProp as string)}.name}`;
      }
      const cidr = (p.cidr as string) ?? '10.0.1.0/24';
      addRes(ctx, 'azurerm_subnet', id, {
        name: `${id.replace(/_/g, '-')}-subnet`,
        resource_group_name: rg,
        virtual_network_name: vnetName,
        address_prefixes: [cidr],
      });
      return true;
    }

    case 'Network.SecurityGroup': {
      addRes(ctx, 'azurerm_network_security_group', id, {
        name: `${id.replace(/_/g, '-')}-nsg`,
        resource_group_name: rg,
        location: loc,
      });
      return true;
    }

    case 'Network.WAF': {
      addRes(ctx, 'azurerm_web_application_firewall_policy', id, {
        name: `${id.replace(/_/g, '-')}-waf`,
        resource_group_name: rg,
        location: loc,
        policy_settings: { enabled: true, mode: 'Prevention' },
        managed_rules: { managed_rule_set: [{ type: 'OWASP', version: '3.2' }] },
      });
      return true;
    }

    default:
      return false;
  }
}
