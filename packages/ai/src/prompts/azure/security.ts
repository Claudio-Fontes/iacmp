export const SECURITY_AZURE = `
## Regras Azure — Secret.Vault (Key Vault)

**REGRA ABSOLUTA:** \`Secret.Vault\` → Azure Key Vault → handler usa \`@azure/keyvault-secrets\` + \`SecretClient\` + \`DefaultAzureCredential\`.

**NUNCA use \`@azure/data-tables\`, \`@aws-sdk/*\`, ou \`TableClient\` para ler segredos de Key Vault.**

### Atributos válidos de \`ref()\` para \`Secret.Vault\`:
- \`ref('MinhaVault', 'VaultUri')\` → URI da vault (ex: \`https://kv-minha-xxx.vault.azure.net/\`) — use como env var para o handler
- \`ref('MinhaVault', 'Name')\` → nome do recurso Key Vault no Azure
- \`ref('MinhaVault', 'Arn')\` ou \`ref('MinhaVault', 'SecretArn')\` → resource ID ARM

### Padrão OBRIGATÓRIO para handler que lê Key Vault:

**Stack:**
\`\`\`typescript
new Fn.Lambda(stack, 'GetConfigFn', {
  runtime: 'nodejs20',
  handler: 'dist/getConfig.handler',
  code: '.',
  environment: {
    DEV_VAULT_URI:     ref('AppConfigDev',     'VaultUri'),
    STAGING_VAULT_URI: ref('AppConfigStaging', 'VaultUri'),
    PROD_VAULT_URI:    ref('AppConfigProd',    'VaultUri'),
  }
});
\`\`\`

**Handler (src/getConfig.ts):**
\`\`\`typescript
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

export async function handler(event: any) {
  const env = event.queryStringParameters?.env;
  if (!['dev', 'staging', 'prod'].includes(env)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid environment' }) };
  }

  const vaultUri = process.env[\`\${env.toUpperCase()}_VAULT_URI\`];
  if (!vaultUri) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Vault URI not configured' }) };
  }

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(vaultUri, credential);

  try {
    const secret = await client.getSecret('secret-value');
    let configs: Record<string, unknown> = {};
    try {
      configs = JSON.parse(secret.value || '{}');
    } catch {
      configs = { value: secret.value };
    }

    // Remove campos sensíveis
    delete configs.password;
    delete configs.token;
    delete configs.key;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env, configs }),
    };
  } catch (error: any) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
}
\`\`\`

**npm install obrigatório:** \`@azure/keyvault-secrets @azure/identity\`

### Permissões (Policy.IAM)

O Container App precisa de role assignment para acessar o Key Vault (RBAC mode):
\`\`\`typescript
new Policy.IAM(stack, 'ConfigLambdaIAM', {
  attachTo: 'GetConfigFn',
  attachType: 'lambda',
  statements: [{
    effect: 'Allow',
    actions: ['keyvault:GetSecretValue'],
    resources: [
      ref('AppConfigDev', 'Arn'),
      ref('AppConfigStaging', 'Arn'),
      ref('AppConfigProd', 'Arn'),
    ]
  }]
});
\`\`\`

### Soft-delete e nomes

Key Vault tem soft-delete. Nunca use nomes fixos (ex: 'minha-kv') — o iacmp gera nomes únicos automaticamente via uniqueString(). Após destroy, use \`az keyvault list-deleted\` para verificar e \`az keyvault purge -n <nome>\` se necessário.
`;
