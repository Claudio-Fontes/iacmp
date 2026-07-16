export const NETWORK_AWS = `
## Regras AWS — Network (VPC, ALB, CloudFront, WAF, VpcEndpoint)

**REGRA ABSOLUTA — maxAzs vs Network.Subnet:** são mutuamente exclusivos.
- Se declarar \`Network.Subnet\` explícitos → use \`maxAzs: 0\` (ou omita maxAzs)
- Se usar \`maxAzs > 0\` → NÃO declare \`Network.Subnet\` na mesma stack

**availabilityZone e porta do SG são DERIVADOS — não escreva:** o synth atribui automaticamente AZs distintas às \`Network.Subnet\` (a partir da região do projeto) e abre a porta do engine no \`Network.SecurityGroup\` que protege o banco. NÃO defina \`availabilityZone\` nas subnets nem \`ingressRules\` de porta de banco no SG — deixe o synth derivar. Só defina manualmente se o usuário pedir um valor específico.

**REGRA — Lambda em VPC que acessa DynamoDB ou S3:** uma Lambda em subnet privada NÃO alcança serviços da AWS fora da VPC (DynamoDB, S3) sem NAT. Como o iacmp não gera NAT, SEMPRE que uma \`Fn.Lambda\` estiver numa VPC (\`vpcId\` + \`subnetIds\`) e o handler acessar DynamoDB (\`@aws-sdk/lib-dynamodb\`) ou S3 (\`@aws-sdk/client-s3\`), adicione um \`Network.VpcEndpoint\` (Gateway, grátis) com o(s) \`services\` correspondente(s) e os mesmos \`subnetIds\` privados — na mesma stack da VPC/subnets. Sem isso a Lambda dá timeout. (Redis/RDS ficam DENTRO da VPC, então não precisam de endpoint.)

**REGRA — "acesso só do SG X":** quando o pedido é "libere a porta N apenas do SG da Lambda/app" (ex: Redis 6379, RDS 5432 só do SG da Lambda), use \`sourceSecurityGroupId: 'LambdaSG'\` no \`ingressRules\` — NUNCA \`cidr\` nem campos inexistentes como \`securityGroupIds\`. É o padrão de segurança correto e o único que o synth entende para fonte-SG.

**REGRA — "egress liberado/aberto":** quando o SG deve ter saída livre (ex: "Security Group para Lambda com egress liberado"), NÃO declare \`egressRules\` — o synth já gera egress allow-all (\`-1\` para 0.0.0.0/0, todos os protocolos). NUNCA restrinja o egress a \`protocol: 'tcp'\` faixa 0-65535: isso bloqueia DNS (UDP 53) e a Lambda não resolve o hostname do Redis/serviço, dando timeout. Só declare \`egressRules\` quando o usuário pedir uma saída ESPECÍFICA e restrita.

**REGRA — rate limiting no WAF:** para "máximo N requisições por IP", use \`rateLimit: N\` no rule (o synth gera um \`RateBasedStatement\` e bloqueia por padrão) — NUNCA \`matchValues\`/\`sourceIps\` (isso é match de string/IP, não rate limit).

**REGRA — associar WAF ao API Gateway:** para "API protegida pelo WAF", ponha \`wafAclId: '<idDoNetwork.WAF>'\` no \`Fn.ApiGateway\` (REST) — o synth cria a \`WebACLAssociation\` ligando o WAF ao stage. O WAF precisa ser \`scope: 'REGIONAL'\`. Só declarar o \`Network.WAF\` NÃO protege nada sem essa associação.

**REGRA — ALB para Compute.Container:** declare \`targetGroups\` (o synth faz o listener HTTP dar \`forward\` pro 1º) e ligue o container com \`targetGroupArn: '<LoadBalancerId>.TargetGroupArn'\` (ver Compute.Container). O synth exporta \`<LoadBalancerId>.TargetGroupArn\` para uso cross-stack.

**REGRA — HTTPS exige certificado:** um listener \`protocol: 'HTTPS'\` SÓ sobe com \`certificateArn\` (um certificado ACM). Sem domínio/certificado real (ex: teste, free tier), declare APENAS o listener HTTP:80 — o synth ignora um HTTPS sem \`certificateArn\` (a porta 443 simplesmente não existiria). Não gere listener 443 quando não houver certificado.

**REGRA ABSOLUTA — certificateArn no CDN:** NUNCA gere \`certificateArn\` com placeholder. Omita o campo completamente — sem \`certificateArn\`, o synth usa o certificado padrão do CloudFront (\`*.cloudfront.net\`), que funciona imediatamente sem configuração extra. Só inclua \`certificateArn\` se o usuário fornecer um ARN real (ex: \`arn:aws:acm:us-east-1:123456789012:certificate/abc123\`).

**REGRA CRÍTICA — Hosting de app React/SPA na AWS:**
Use SEMPRE o padrão com bucketRef — ele cria OAC + BucketPolicy automaticamente (bucket privado, acesso só via CloudFront).
**OBRIGATÓRIO**: bucket e CDN devem estar na MESMA stack TypeScript. bucketRef é uma referência local (Fn::GetAtt) e não funciona entre stacks separadas.
**NUNCA combine \`websiteHosting: true\` com \`bucketRef\`** — são mutuamente exclusivos (OAC exige bucket PRIVADO; o synth rejeita a combinação). Com CDN, o bucket fica SEM websiteHosting.
**\`Storage.CDN\` NÃO EXISTE** — CDN é \`Network.CDN\`, sempre.
\`\`\`typescript
// stacks/network/static-site-stack.ts  ← bucket E cdn no mesmo arquivo/stack
import { Stack, Storage, Network } from '@iacmp/core';
const stack = new Stack('meu-app-static-site');
new Storage.Bucket(stack, 'AppBucket', {});  // privado, SEM websiteHosting — o OAC do CDN dá o acesso
new Network.CDN(stack, 'AppCDN', {
  defaultRootObject: 'index.html',
  origins: [
    {
      id: 'app-bucket',
      domainName: '',
      bucketRef: 'AppBucket',
    }
  ],
});
export default stack;
\`\`\`
NUNCA separe Storage.Bucket e Network.CDN em arquivos/stacks diferentes quando usar bucketRef — o synth vai falhar com "Ref/Fn::GetAtt para recurso inexistente".

**REGRA — DR (disaster recovery) com CloudFront Origin Group:** quando o usuário pedir failover para uma região de DR:
1. O iacmp.json PRECISA ter \`"drRegion"\` (ex: "us-west-2"). O bucket de DR vive numa stack SEPARADA marcada com \`new Stack('nome-dr', { region: 'dr' })\` — o deploy manda essa stack para a drRegion automaticamente.
2. O bucket de DR precisa de \`bucketName\` explícito e determinístico (S3 é global — use sufixo \\\${AWS::AccountId}) e \`publicAccess: true\` (a origem cross-região não usa OAC).
3. No Network.CDN, a origem de DR usa \`bucketName\` + \`region: 'dr'\` (NÃO bucketRef — não existe referência cross-região), e \`failover\` liga as duas origens:
\`\`\`typescript
// stacks/storage/site-dr-stack.ts — stack de DR (deployada na drRegion)
const drStack = new Stack('site-dr', { region: 'dr' });
new Storage.Bucket(drStack, 'SiteBucketDr', { bucketName: 'meuapp-site-dr-\${AWS::AccountId}', publicAccess: true });

// stacks/network/site-stack.ts — bucket primário + CDN com failover
new Storage.Bucket(stack, 'SiteBucket', {});
new Network.CDN(stack, 'SiteCDN', {
  origins: [
    { id: 'primary', domainName: '', bucketRef: 'SiteBucket' },
    { id: 'dr', domainName: '', bucketName: 'meuapp-site-dr-\${AWS::AccountId}', region: 'dr' },
  ],
  failover: { primary: 'primary', secondary: 'dr' },  // 403/404/5xx/timeout → DR na mesma request
});
\`\`\`
Adicione em nextSteps que o conteúdo precisa ser publicado NOS DOIS buckets (aws s3 sync para cada um, com --region na cópia de DR).

**REGRA — Database.SQL defaults:** NÃO escreva \`backupRetentionDays\` nem \`storageEncrypted\` — o synth DERIVA esses valores do Account Tier do projeto automaticamente (free → 0/false, standard → 7/true). Só inclua essas props se o usuário pedir um valor específico que sobrescreva o default. Para RDS use \`engine: 'postgres'\` e \`instanceType: 'db.t3.micro'\`; NÃO use \`instances\` (é exclusivo de clusters Aurora).
`;
