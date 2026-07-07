import { BaseConstruct, isRef } from '@iacmp/core';
import { expr, tag, toSym, crossParamName, SynthContext } from './shared';

export function synthesizePolicy(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs, crossParams } = ctx;
  const props = (construct.props ?? {}) as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const rawAttachTo = props.attachTo;
      const attachTo = isRef(rawAttachTo) ? rawAttachTo.constructId : (rawAttachTo as string);
      const attachSym = toSym(attachTo);
      const actions: string[] = [];
      const notActions: string[] = [];
      const dataActions: string[] = [];
      const notDataActions: string[] = [];
      for (const s of statements) {
        const rawActions = (s.actions as string[]) ?? [];
        const isAllow = s.effect === 'Allow';
        for (const a of rawActions) {
          if (a.startsWith('secretsmanager:') || a.startsWith('keyvault:')) {
            const da = 'Microsoft.KeyVault/vaults/secrets/getSecret/action';
            if (isAllow) dataActions.push(da); else notDataActions.push(da);
          } else if (a.startsWith('dynamodb:') || a.startsWith('DocumentDB:')) {
            const mgmt = 'Microsoft.DocumentDB/databaseAccounts/*/read';
            if (isAllow) actions.push(mgmt); else notActions.push(mgmt);
          } else if (a.startsWith('s3:') || a.startsWith('storage:')) {
            const mgmt = 'Microsoft.Storage/storageAccounts/blobServices/containers/*';
            if (isAllow) actions.push(mgmt); else notActions.push(mgmt);
          } else if (a.startsWith('sqs:') || a.startsWith('servicebus:')) {
            const mgmt = 'Microsoft.ServiceBus/namespaces/queues/*';
            if (isAllow) actions.push(mgmt); else notActions.push(mgmt);
          } else if (a === '*') {
            if (isAllow) actions.push('*'); else notActions.push('*');
          } else {
            const fallback = 'Microsoft.Resources/subscriptions/resourceGroups/read';
            if (isAllow) actions.push(fallback); else notActions.push(fallback);
          }
        }
      }
      const roleDefSym = `${sym}RoleDef`;
      const roleAssignSym = `${sym}RoleAssign`;
      resources.push({
        sym: roleDefSym,
        type: 'Microsoft.Authorization/roleDefinitions',
        apiVersion: '2022-04-01',
        name: expr(`guid(resourceGroup().id, '${construct.id}')`),
        properties: {
          roleName: `${construct.id}-role`,
          description: (props.description as string) ?? `Custom role for ${attachTo}`,
          type: 'CustomRole',
          permissions: [{
            actions: actions.length > 0 ? [...new Set(actions)] : (dataActions.length === 0 ? ['Microsoft.Resources/subscriptions/resourceGroups/read'] : []),
            notActions: [...new Set(notActions)],
            dataActions: [...new Set(dataActions)],
            notDataActions: [...new Set(notDataActions)],
          }],
          assignableScopes: [expr('resourceGroup().id')],
        },
      });
      let principalIdExpr: string;
      if (ctx.idx.get(attachTo)) {
        principalIdExpr = `${attachSym}.identity.principalId`;
      } else {
        const principalIdParam = crossParamName(attachTo, 'PrincipalId');
        crossParams.set(principalIdParam, 'string');
        principalIdExpr = principalIdParam;
      }
      resources.push({
        sym: roleAssignSym,
        type: 'Microsoft.Authorization/roleAssignments',
        apiVersion: '2022-04-01',
        name: expr(`guid(resourceGroup().id, '${attachTo}', '${construct.id}')`),
        properties: {
          roleDefinitionId: expr(`${roleDefSym}.id`),
          principalId: expr(principalIdExpr),
          principalType: 'ServicePrincipal',
          description: `Role assignment for ${attachTo}`,
        },
      });
      break;
    }

    case 'Secret.Vault': {
      const kvName = expr(`'kv-${construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 7)}-\${uniqueString(resourceGroup().id, '${construct.id}')}'`);
      resources.push({ sym, type: 'Microsoft.KeyVault/vaults', apiVersion: '2023-02-01', name: kvName, location: 'location', tags: tag(construct.id), properties: { sku: { family: 'A', name: 'standard' }, tenantId: expr('subscription().tenantId'), enableSoftDelete: false, enableRbacAuthorization: true, enabledForDeployment: false, accessPolicies: [] } });
      const kvSecretSym = `${sym}SecretValue`;
      resources.push({ sym: kvSecretSym, type: 'Microsoft.KeyVault/vaults/secrets', apiVersion: '2023-02-01', parent: sym, name: 'secret-value', properties: { value: expr(`base64(concat(uniqueString(resourceGroup().id, '${construct.id}', 'a'), uniqueString(resourceGroup().id, '${construct.id}', 'b'), uniqueString(resourceGroup().id, '${construct.id}', 'c')))`) } });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      outputs.push({ name: `${construct.id}VaultUri`, type: 'string', value: `${sym}.properties.vaultUri` });
      outputs.push({ name: `${construct.id}Name`, type: 'string', value: `${sym}.name` });
      break;
    }

    case 'Certificate.TLS': {
      const kvName = `${construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 21)}-kv`;
      const kvSym = `${sym}Kv`;
      const certSym = `${sym}Cert`;
      resources.push({ sym: kvSym, type: 'Microsoft.KeyVault/vaults', apiVersion: '2023-02-01', name: kvName, location: 'location', properties: { sku: { family: 'A', name: 'standard' }, tenantId: expr('subscription().tenantId'), enableSoftDelete: true, accessPolicies: [] } });
      resources.push({ sym: certSym, type: 'Microsoft.KeyVault/vaults/certificates', apiVersion: '2023-02-01', parent: kvSym, name: construct.id.replace(/[^a-zA-Z0-9-]/g, '-'), properties: { properties: { x509CertificateProperties: { subject: `CN=${props.domainName as string}`, subjectAlternativeNames: { dnsNames: [(props.domainName as string), ...((props.subjectAlternativeNames as string[]) ?? [])] }, validityInMonths: 12 }, issuerParameters: { name: 'Self', issuerName: 'Self' }, keyProperties: { keyType: 'RSA', keySize: 2048, exportable: true } } } });
      break;
    }
  }
}
