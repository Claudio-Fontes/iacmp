import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BaseConstruct } from '@iacmp/core';
import { type CloudFormationResource, type SynthContext } from './types';
import { isSamestackS3BucketRef } from './resolvers';

export const CFN_PSEUDO_PARAMETERS = new Set([
  'AWS::Region', 'AWS::AccountId', 'AWS::StackName', 'AWS::StackId',
  'AWS::Partition', 'AWS::URLSuffix', 'AWS::NoValue', 'AWS::NotificationARNs',
]);

export function collectReferencedLogicalIds(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectReferencedLogicalIds(item, found);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.Ref === 'string' && !CFN_PSEUDO_PARAMETERS.has(obj.Ref)) {
      found.add(obj.Ref);
    }
    const getAtt = obj['Fn::GetAtt'];
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') {
      found.add(getAtt[0]);
    } else if (typeof getAtt === 'string') {
      found.add(getAtt.split('.')[0]);
    }
    for (const value of Object.values(obj)) {
      collectReferencedLogicalIds(value, found);
    }
  }
}

/**
 * Detecta Ref/Fn::GetAtt pra um logical id que não existe na própria stack —
 * ex: um Custom.Resource (escape hatch de texto livre, sem checagem do
 * compilador) referenciando uma Lambda que nunca foi criada. Sem isso, o
 * erro só aparece no `aws cloudformation deploy`, depois do template já ter
 * sido empacotado/enviado.
 */
export function validateResourceReferences(resources: Record<string, CloudFormationResource>): void {
  const referenced = new Set<string>();
  for (const resource of Object.values(resources)) {
    collectReferencedLogicalIds(resource.Properties, referenced);
    if (resource.DependsOn) for (const dep of resource.DependsOn) referenced.add(dep);
  }
  const missing = [...referenced].filter(id => !resources[id]);
  if (missing.length > 0) {
    throw new Error(
      `Ref/Fn::GetAtt para recurso inexistente: ${missing.map(id => `"${id}"`).join(', ')}. ` +
      `Verifique se o recurso foi de fato criado na stack — ex: um Custom.Resource cujo ServiceToken aponta para uma Lambda precisa que essa Lambda exista (como Fn.Lambda ou outro Custom.Resource).`
    );
  }
}

/**
 * Detecta null/undefined em qualquer propriedade dos resources ANTES do deploy.
 * Causa típica: a IA referencia uma propriedade que não existe no construct
 * (ex: `secretArn` em Secret.Vault), que em TS é `undefined` e vira `null` no
 * template — o CloudFormation rejeita com "'null' values are not allowed".
 * Pega na origem, com o caminho exato.
 */
export function validateNoNullValues(resources: Record<string, CloudFormationResource>): void {
  const bad: string[] = [];
  const stringified: string[] = [];
  const placeholderArns: string[] = [];
  const walk = (node: unknown, pathStr: string): void => {
    if (node === null || node === undefined) {
      bad.push(pathStr);
      return;
    }
    if (typeof node === 'string' && node.includes('[object Object]')) {
      // Sinal de um Ref tipado concatenado com string no código da stack
      // (ex: ref('B','Arn') + '/*' → "[object Object]/*"). O deploy falharia
      // com 400 — barrar aqui dá erro que o loop de geração conserta.
      stringified.push(pathStr);
      return;
    }
    if (typeof node === 'string' && node.includes('123456789012')) {
      // Account id placeholder da doc AWS — a IA hardcodou um ARN literal em vez
      // de ref('Recurso','Arn'). O deploy sobe mas a policy aponta pra conta
      // errada (AccessDenied em runtime). Barrar no synth p/ o loop consertar.
      placeholderArns.push(pathStr);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${pathStr}[${i}]`));
    } else if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, `${pathStr}.${k}`);
    }
  };
  for (const [id, resource] of Object.entries(resources)) {
    walk(resource.Properties, id);
  }
  if (stringified.length > 0) {
    throw new Error(
      `"[object Object]" no template em ${stringified.map(p => `"${p}"`).join(', ')}. ` +
      `Causa: um ref(...) tipado foi concatenado com string no código da stack ` +
      `(ex: ref('MeuBucket','Arn') + '/*'). NÃO concatene refs — para "objetos dentro do bucket" ` +
      `num resource de Policy.IAM use a STRING 'MeuBucket/*' (o synth resolve para '<arn>/*').`
    );
  }
  if (placeholderArns.length > 0) {
    throw new Error(
      `Account id placeholder "123456789012" no template em ${placeholderArns.map(p => `"${p}"`).join(', ')}. ` +
      `A IA hardcodou um ARN literal. Use ref('Recurso','Arn') (o synth gera o ARN com a conta real) ` +
      `ou, para um ARN construído à mão, '\${AWS::AccountId}' num Fn::Sub — NUNCA um account id fixo.`
    );
  }
  if (bad.length > 0) {
    throw new Error(
      `Valor null/undefined no template (CloudFormation rejeita): ${bad.map(p => `"${p}"`).join(', ')}. ` +
      `Causa comum: referência a uma propriedade que não existe no construct ` +
      `(ex: Secret.Vault não tem .secretArn; use a env var resolvida pelo synth ou o id do recurso).`
    );
  }
}

/**
 * Detecta handlers TypeScript que usam process.env.<VAR> onde <VAR> foi omitida
 * pelo synth porque referenciava um bucket-trigger (evitar ciclo CFN). O modelo
 * de IA frequentemente gera `const bucket = process.env.RAW_BUCKET_NAME!` no
 * handler, mas essa env var não existe em runtime — a Lambda falha com undefined.
 *
 * Varre src/*.ts no diretório do projeto (process.cwd() = cwd do synth = projectDir)
 * e lança erro claro com instrução de fix antes do deploy.
 */
export function validateHandlerEnvVarAccess(constructs: BaseConstruct[], ctx: SynthContext, projectDir: string = process.cwd()): void {
  const errors: string[] = [];

  for (const construct of constructs) {
    if (construct.type !== 'Function.Lambda') continue;

    const triggerBuckets = ctx.s3TriggerBucketsForLambda.get(construct.id);
    if (!triggerBuckets || triggerBuckets.size === 0) continue;

    const environment = (construct.props as Record<string, unknown>).environment as Record<string, unknown> | undefined;
    if (!environment) continue;

    // Replica a lógica de omissão de synthFunction: env vars que referenciam um
    // trigger bucket da mesma stack são omitidas do template CFN.
    const omittedVars: string[] = [];
    for (const [k, v] of Object.entries(environment)) {
      const bucketId = isSamestackS3BucketRef(v, ctx);
      if (bucketId && triggerBuckets.has(bucketId)) {
        omittedVars.push(k);
      }
    }

    if (omittedVars.length === 0) continue;

    // Verifica src/*.ts do projeto (cwd = projectDir quando synth roda).
    const srcDir = path.join(projectDir, 'src');
    if (!fs.existsSync(srcDir)) continue;

    let tsFiles: string[];
    try {
      tsFiles = fs.readdirSync(srcDir)
        .filter(f => f.endsWith('.ts'))
        .map(f => path.join(srcDir, f));
    } catch {
      continue;
    }

    for (const file of tsFiles) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      for (const varName of omittedVars) {
        if (content.includes(`process.env.${varName}`)) {
          const rel = path.relative(projectDir, file);
          errors.push(
            `Erro: Handler ${rel} usa process.env.${varName} mas essa env var é omitida pelo synth ` +
            `(referencia o bucket-trigger, criaria ciclo CFN).\n` +
            `Fix: use record.s3.bucket.name do evento S3 em vez de process.env.${varName}.`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}
