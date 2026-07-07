export const NETWORK_AZURE = `
## Regras Azure — Network

**REGRA ABSOLUTA — Fn.Lambda e Compute.Container NÃO usam VPC no Azure.**

No Azure, \`Fn.Lambda\` (Azure Functions) e \`Compute.Container\` (Container Apps) rodam em infraestrutura gerenciada pela plataforma — não há VPC a configurar. NUNCA gere \`vpcId\`, \`subnetIds\` nem \`securityGroupIds\` nesses constructs ao sintetizar para Azure. Esses campos são específicos da AWS.

**REGRA — Comunicação entre recursos no Azure:** use \`environment\` com \`ref()\` — isso é suficiente para que a Lambda ou o Container alcance bancos, caches e filas. NUNCA crie stacks de network (Network.VPC, Network.Subnet, Network.SecurityGroup) só para conectar Lambdas a outros recursos.

**REGRA — NUNCA invente constructs de network.** Só gere \`Network.VPC\`, \`Network.Subnet\` ou \`Network.SecurityGroup\` se o usuário pedir explicitamente uma rede privada isolada. Sem esse pedido explícito, omita completamente qualquer construct de Network — o synth Azure não os utiliza para Lambdas ou Container Apps.

**REGRA — NUNCA use ref() para campos de network.** \`vpcId\`, \`subnetIds\` e \`securityGroupIds\` esperam string literal (ID lógico do construct), NÃO \`ref()\`. E no Azure esses campos devem ser omitidos inteiramente para Fn.Lambda e Compute.Container.
`;

