import { Language, DEFAULT_LANGUAGE } from '../i18n/languages';

import { CATALOG } from './catalog';
import { COMMON } from './common';
import { AWS } from './aws';
import { AZURE } from './azure';

const RESPONSE_LANGUAGE_INSTRUCTION: Record<Language, string> = {
  pt: 'Escreva sempre em português (pt-BR) os campos "explanation", "warnings", "nextSteps" e qualquer resposta conversacional, independente do idioma da pergunta do usuário.',
  en: 'Always write the "explanation", "warnings", "nextSteps" fields and any conversational response in English, regardless of the language of the user\'s question.',
  es: 'Escribe siempre en español los campos "explanation", "warnings", "nextSteps" y cualquier respuesta conversacional, sin importar el idioma de la pregunta del usuario.',
};

function cloudRules(provider?: string): string {
  const domains = provider === 'azure' ? AZURE : AWS;
  return Object.values(domains).filter(Boolean).join('\n\n');
}

export function buildSystemPrompt(projectContext: string, lang: Language = DEFAULT_LANGUAGE, provider?: string): string {
  const parts = [
    'Você é um especialista em infraestrutura como código (IaC) integrado ao iacmp CLI.',
    'Seu papel é gerar stacks de infraestrutura em TypeScript usando os constructs do @iacmp/core. Prefira sempre os constructs tipados quando existirem. Quando o serviço pedido pelo usuário NÃO tiver construct tipado no catálogo abaixo, NÃO diga apenas "não existe construct para isso" — use o `Custom.Resource` (ver seção dedicada mais abaixo) para gerar o recurso nativo real do provider (CloudFormation/ARM/Deployment Manager/Terraform) com sua própria sintaxe, formatado nesse construct de escape hatch. Você conhece a sintaxe nativa de cada formato; use esse conhecimento em vez de bloquear o pedido do usuário.',
    // As regras específicas do provider (AWS ou Azure) vêm de cloudRules(provider);
    // o COMMON é provider-NEUTRO. Antes o COMMON trazia exemplos @aws-sdk/DynamoDB
    // e um "override" pedia ao modelo para ignorá-los no Azure — contexto confuso.
    // Agora o bloco DynamoDB SDK vive só em aws/database.ts (injetado só p/ AWS).
    CATALOG,
    cloudRules(provider),
    COMMON,
    `## Idioma da resposta\n${RESPONSE_LANGUAGE_INSTRUCTION[lang]}`,
    `## Contexto do projeto atual\n${projectContext}`,
  ];
  return parts.filter(Boolean).join('\n\n');
}

export const SYSTEM_PROMPT = buildSystemPrompt(
  'Nenhum projeto carregado — modo standalone.',
  DEFAULT_LANGUAGE,
  undefined,
);

export const SYSTEM_PROMPT_TEMPLATE = SYSTEM_PROMPT;
