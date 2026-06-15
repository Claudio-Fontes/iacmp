// Decide quais corpora buscar com base na query do usuário.
// Fase 1 usa classificação por palavras-chave — sem chamada ao modelo.

export interface RoutingDecision {
  useProjectStacks: boolean;    // corpus 1
  useIacmpDocs: boolean;        // corpus 2
  usePlatformKnowledge: boolean; // corpus 3
}

// Termos que sinalizam que a query é sobre o projeto atual do usuário
const PROJECT_SIGNALS = [
  'minha stack', 'meu projeto', 'minha lambda', 'meu bucket', 'meu banco',
  'minha vpc', 'meu cluster', 'minha fila', 'meu tópico',
  'stack existente', 'arquivo existente', 'já tenho', 'já criei',
  'stacks/', 'corrigir', 'atualizar', 'modificar', 'remover', 'deletar',
  'adicionar à', 'adicionar na', 'alterar', 'mudar',
];

// Termos que sinalizam que a query é sobre a API dos constructs iacmp
const DOCS_SIGNALS = [
  'construct', 'props', 'propriedades', 'parâmetros', 'api',
  'como usar', 'como criar', 'como configurar', 'como adicionar',
  'sintaxe', 'exemplo', 'quais campos', 'quais opções',
  'compute.', 'storage.', 'network.', 'database.', 'fn.', 'cache.',
  'messaging.', 'events.', 'workflow.', 'policy.', 'secret.',
  'certificate.', 'monitoring.', 'logging.',
  'stack.', '@iacmp/core',
];

// Termos que sinalizam que a query é sobre conhecimento de plataforma
const KNOWLEDGE_SIGNALS = [
  'limite', 'limites', 'máximo', 'mínimo', 'quanto custa', 'preço', 'custo',
  'aws', 'azure', 'gcp', 'google cloud', 'amazon', 'microsoft',
  'lambda', 'ec2', 'rds', 'dynamodb', 's3', 'sqs', 'sns', 'cloudwatch',
  'ecs', 'eks', 'fargate', 'aurora', 'elasticache',
  'well-architected', 'boas práticas', 'arquitetura', 'padrão',
  'segurança', 'criptografia', 'iam', 'rbac', 'permissão',
  'multi-az', 'alta disponibilidade', 'failover', 'disaster recovery',
  'monitoramento', 'observabilidade', 'métricas', 'logs', 'traces',
  'serverless', 'containers', 'kubernetes', 'microservices',
  'vpc', 'subnet', 'cidr', 'nat gateway', 'private endpoint',
  'timeout', 'concorrência', 'throughput', 'iops', 'latência',
  'backup', 'replicação', 'consistência',
];

function containsSignal(query: string, signals: string[]): boolean {
  const lower = query.toLowerCase();
  return signals.some(s => lower.includes(s));
}

export function routeQuery(query: string): RoutingDecision {
  const lower = query.toLowerCase();

  // Detecta se é uma pergunta de geração/criação genérica (usa todos os corpora)
  const isGeneration = /^(crie?|gere?|adicione?|cria|gera|adiciona|faça|faz|implemente?|implementa)\b/i.test(lower);

  const useProjectStacks = isGeneration || containsSignal(query, PROJECT_SIGNALS);
  const useIacmpDocs = isGeneration || containsSignal(query, DOCS_SIGNALS);
  const usePlatformKnowledge = containsSignal(query, KNOWLEDGE_SIGNALS);

  // Se nenhum sinal foi encontrado, busca em tudo (fallback conservador)
  if (!useProjectStacks && !useIacmpDocs && !usePlatformKnowledge) {
    return { useProjectStacks: true, useIacmpDocs: true, usePlatformKnowledge: true };
  }

  return { useProjectStacks, useIacmpDocs, usePlatformKnowledge };
}
