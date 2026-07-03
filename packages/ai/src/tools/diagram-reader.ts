import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { extractResponse, AIGeneratedResponse } from '../parser/code-extractor';
import { SYSTEM_PROMPT } from '../prompts/system-prompt';

const MEDIA_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
};

function buildDiagramPrompt(accountTier = 'free'): string {
  const tierNote = accountTier === 'free'
    ? '- Conta free tier: sem criptografia (storageEncrypted: false), sem backup (backupRetentionDays: 0), db.t3.micro para RDS'
    : '- Conta standard: pode usar criptografia, backup e instâncias maiores conforme necessário';

  return `Analise este diagrama de arquitetura de infraestrutura em nuvem e gere os arquivos TypeScript do iacmp que representam exatamente a arquitetura visualizada.

Regras gerais:
- Preserve os nomes/IDs dos componentes como estão no diagrama (ex: "AppDB" → id "AppDB")
- Mapeie cada componente para o construct iacmp equivalente (Lambda→Fn.Lambda, S3→Storage.Bucket, etc.)
- Use ref() para referencias entre stacks (ex: ref('AppDB','Endpoint'))
- Separe em stacks por camada: network/, database/, compute/, storage/, etc.
- Respeite relações visíveis: VPCs, subnets, security groups, conexões entre serviços
- Gere também os handlers Node.js/TypeScript para Lambdas quando o diagrama indicar lógica real
${tierNote}

Regras de validação semântica OBRIGATÓRIAS (o synth rejeita se violadas):
- SUBNETS para RDS/Database.SQL: sempre declare ≥2 Network.Subnet com availabilityZone DIFERENTES
  (ex: 'us-east-1a' e 'us-east-1b'). Nunca coloque 2 subnets na mesma AZ.
- CLOUDFRONT + S3: se Network.CDN usar bucketRef apontando para um Storage.Bucket,
  esse bucket deve ter websiteHosting: false (ou omitir websiteHosting).
  websiteHosting: true é mutuamente exclusivo com bucketRef/OAC — nunca use os dois juntos.
- LAMBDA em VPC: se Fn.Lambda tiver vpcRef, as subnets da VPC devem ter ≥2 AZs para o RDS funcionar.
- SECURITY GROUPS: declare Network.SecurityGroup explícito para cada camada (lambda-sg, rds-sg).
- RDS sem publicAccess: banco de dados sempre com publiclyAccessible: false (subnet privada).
- API Gateway authType: use 'NONE' a não ser que o diagrama mostre autenticação explícita.

Regras de segurança SEMPRE obrigatórias mesmo que NÃO apareçam visualmente no diagrama:
- POLICY IAM: toda Fn.Lambda que acessa qualquer serviço AWS (RDS via secret, S3, DynamoDB, SQS,
  SNS, Secrets Manager) DEVE ter um Policy.IAM correspondente com attachTo e as actions mínimas.
  Gere uma Policy.IAM por Lambda (ou uma compartilhada se todas tiverem o mesmo escopo).
  Sem Policy.IAM a Lambda recebe AccessDenied em runtime — não é opcional.
- SECRET VAULT: se houver Database.SQL (RDS), SEMPRE gere um Secret.Vault para a senha do banco.
  A senha do RDS nunca deve ser hardcoded — use Secret.Vault e ref() na propriedade password do DB.
- MANAGED POLICIES Lambda básicas: toda Fn.Lambda precisa de pelo menos
  'AWSLambdaBasicExecutionRole'. Se estiver em VPC, adicionar 'AWSLambdaVPCAccessExecutionRole'.
  Declare via managedPolicies: [...] no Policy.IAM.
- Estas regras aplicam independente do provider (AWS, Azure, GCP) — adapte para RBAC/IAM Binding.

Retorne APENAS o JSON abaixo (sem markdown, sem texto fora do JSON):
{
  "explanation": "o que foi identificado no diagrama",
  "files": [
    { "path": "stacks/network/vpc-stack.ts", "content": "..." }
  ],
  "nextSteps": ["npm install", "iacmp synth", "iacmp deploy"],
  "warnings": []
}`;
}

export interface DiagramKeys {
  anthropic?: string;
  openai?: string;
}

/**
 * Lê um arquivo de imagem de diagrama de arquitetura e envia para a IA
 * com visão para gerar os arquivos de stack iacmp correspondentes.
 *
 * Usa o Anthropic SDK se anthropicKey for fornecida; caso contrário cai para
 * OpenAI (gpt-4o, que suporta visão). Nunca usa AIProvider — visão exige
 * content:array com bloco image, interface incompatível com AIProvider.
 */
export async function analyzeDiagramImage(
  imagePath: string,
  keys: DiagramKeys | string,
  model?: string,
  options?: { accountTier?: string },
): Promise<AIGeneratedResponse> {
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = MEDIA_TYPES[ext] ?? 'image/png';

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Arquivo de diagrama não encontrado: ${imagePath}`);
  }

  const imageData = fs.readFileSync(imagePath).toString('base64');

  // Compatibilidade com chamadas legadas (string como segundo argumento)
  const anthropicKey = typeof keys === 'string' ? keys : keys.anthropic;
  const openaiKey = typeof keys === 'string' ? undefined : keys.openai;

  const prompt = buildDiagramPrompt(options?.accountTier);

  if (anthropicKey) {
    return analyzeWithAnthropic(imageData, mediaType, anthropicKey, model ?? 'claude-sonnet-4-6', prompt);
  }

  if (openaiKey) {
    return analyzeWithOpenAI(imageData, mediaType, openaiKey, prompt);
  }

  throw new Error('Nenhuma API key configurada. Configure ANTHROPIC_API_KEY ou OPENAI_API_KEY no .env do projeto.');
}

async function analyzeWithAnthropic(
  imageData: string,
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
  apiKey: string,
  model: string,
  prompt: string,
): Promise<AIGeneratedResponse> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageData },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const block = response.content[0];
  const text = block.type === 'text' ? block.text : '';
  return extractResponse(text);
}

async function analyzeWithOpenAI(
  imageData: string,
  mediaType: string,
  apiKey: string,
  prompt: string,
): Promise<AIGeneratedResponse> {
  const client = new OpenAI({ apiKey });

  const dataUrl = `data:${mediaType};base64,${imageData}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 8192,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const text = response.choices[0]?.message?.content ?? '';

  // GPT-4o recusa imagens com logos de provedores cloud (AWS, Azure, GCP) por política de conteúdo.
  // Detecta a recusa e lança erro com instrução clara em vez de mensagem genérica de parse.
  const refusalPhrases = ["i'm sorry", "i cannot", "i can't", "unable to assist", "can't assist", "cannot assist"];
  if (refusalPhrases.some(p => text.toLowerCase().startsWith(p))) {
    throw new Error(
      'O GPT-4o recusou processar esta imagem (política de conteúdo — comum em diagramas com logos de cloud).\n' +
      'Solução: configure ANTHROPIC_API_KEY no .env — o Claude não tem essa restrição.\n' +
      'Alternativa: use `iacmp ai "descreva a arquitetura"` e descreva manualmente.',
    );
  }

  return extractResponse(text);
}
