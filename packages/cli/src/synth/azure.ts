import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { AzureProvider, extractAzureFunctionMeta, extractAzureContainerBuilds } from '@iacmp/provider-azure';
import { Stack } from '@iacmp/core';
import { IacmpConfig } from '../utils';
import { LoadedStack } from '../validators';
import { providerOutDir, listTemplates, orderByDependency, generateAzureMainBicep, AZURE_MAIN_FILE, TemplateRef } from '../synth-out';
import { SynthUI } from './types';

export function synthAzure(o: {
  cwd: string;
  targetStacks: LoadedStack[];
  allStacks: Stack[];
  config: IacmpConfig;
  stackFlag?: string;
  ui: SynthUI;
}): void {
  const provOutDir = providerOutDir(o.cwd, 'azure');
  fs.mkdirSync(provOutDir, { recursive: true });
  const projectResourceGroup = o.config.resourceGroup ?? (o.config.name ? `${o.config.name}-rg` : undefined);

  for (const { stackName, stack } of o.targetStacks) {
    try {
      const p = new AzureProvider();
      const moduleFilesOut: Array<{ filename: string; content: string }> = [];
      const bicep = p.synthesize(stack, o.allStacks, {
        accountTier: (o.config.accountTier === 'standard' ? 'standard' : 'free'),
        sharedApim: o.config.azure?.sharedApim
          ? { ...o.config.azure.sharedApim, projectResourceGroup }
          : undefined,
        projectName: o.config.name || undefined,
        moduleFilesOut,
      });
      const outPath = path.join(provOutDir, `${stackName}.bicep`);
      fs.writeFileSync(outPath, bicep);
      // Módulos-irmãos (ex: filhos do APIM compartilhado cross-RG — ver
      // bicep.ts) vivem no MESMO diretório do .bicep principal, que os
      // referencia por nome de arquivo relativo.
      for (const mf of moduleFilesOut) {
        fs.writeFileSync(path.join(provOutDir, mf.filename), mf.content);
      }
      const fnMeta = extractAzureFunctionMeta(stack, o.allStacks);
      const containerBuilds = extractAzureContainerBuilds(stack, o.config.name || undefined);
      if (fnMeta.length > 0 || containerBuilds.length > 0) {
        fs.writeFileSync(
          path.join(provOutDir, `${stackName}.iacmp-meta.json`),
          JSON.stringify({ functions: fnMeta, containerBuilds }, null, 2),
        );
      }
      o.ui.log(`Sintetizado: ${outPath}`);
    } catch (err) {
      o.ui.error(`Falha ao sintetizar '${stackName}': ${(err as Error).message}`);
    }
  }

  // ── Detecção de dependência circular cross-stack + _main.bicep ──────────
  // O _main.bicep é o deployment único — stacks viram módulos, amarrados por
  // referência simbólica; o ARM resolve a ordem sozinho.
  try {
    const ordered = orderByDependency(listTemplates(o.cwd, 'azure'));
    if (ordered.length > 0) {
      writeAzureMain(o.cwd, ordered, o.ui);
    }
  } catch (err) {
    o.ui.error((err as Error).message);
  }

  validateAzureTemplates(o.cwd, o.ui, projectResourceGroup, o.stackFlag);
}

/**
 * Escreve o _main.bicep (deployment único) e a meta agregada das Function Apps
 * (o zip deploy lê `<template>.iacmp-meta.json` do template que foi deployado).
 */
function writeAzureMain(cwd: string, ordered: TemplateRef[], ui: SynthUI): void {
  const dir = providerOutDir(cwd, 'azure');
  const mainPath = path.join(dir, AZURE_MAIN_FILE);

  const metas = ordered.map(t => {
    const metaPath = t.filePath.replace(/\.bicep$/, '.iacmp-meta.json');
    if (!fs.existsSync(metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { functions?: unknown[]; containerBuilds?: Array<{ imageParamName?: string }> };
    } catch {
      return null;
    }
  });
  const functions = metas.flatMap(m => m?.functions ?? []);
  const containerBuilds = metas.flatMap(m => m?.containerBuilds ?? []);
  // Params do pipeline de build (acrServer/acrUser/acrPassword/<id>Image) só existem
  // no top-level do _main.bicep quando o projeto TEM containerBuilds — sem isso, o
  // ARM rejeita `--parameters acrServer=...` como "unrecognized template parameter"
  // (o deploy só injeta esses --parameters quando containerBuilds.length > 0).
  const imageParamNames = [...new Set(containerBuilds.map(b => b.imageParamName).filter((n): n is string => !!n))];
  fs.writeFileSync(mainPath, generateAzureMainBicep(ordered, imageParamNames));

  const mainMetaPath = mainPath.replace(/\.bicep$/, '.iacmp-meta.json');
  if (functions.length > 0 || containerBuilds.length > 0) {
    fs.writeFileSync(mainMetaPath, JSON.stringify({ functions, containerBuilds }, null, 2));
  } else if (fs.existsSync(mainMetaPath)) {
    fs.rmSync(mainMetaPath);
  }
  ui.log(`Sintetizado: ${mainPath} (deployment único — módulos com referência simbólica)`);
}

/**
 * Valida templates Bicep gerados em dois estágios:
 *   1. `az bicep build --stdout` — sintaxe/compilação (sem resource group)
 *   2. `az deployment group validate` — validação via API Azure (requer RG ativo)
 * Skipa graciosamente se az CLI não estiver disponível.
 */
function validateAzureTemplates(cwd: string, ui: SynthUI, resourceGroup?: string, stack?: string): void {
  const azCheck = spawnSync('az', ['--version'], { encoding: 'utf-8' });
  if (azCheck.error) {
    ui.log('  az CLI não encontrado — validação Azure skipped.');
    return;
  }

  const dir = providerOutDir(cwd, 'azure');
  if (!fs.existsSync(dir)) return;

  // Deployment único: valida só o _main.bicep — `az bicep build` compila os
  // módulos recursivamente (cobre a sintaxe de TODAS as stacks numa chamada)
  // e o validate remoto passa de N chamadas (~4-5s cada) para UMA.
  const hasMain = fs.existsSync(path.join(dir, AZURE_MAIN_FILE));
  const files = hasMain
    ? [AZURE_MAIN_FILE]
    : fs.readdirSync(dir).filter(
        f => f.endsWith('.bicep') && !f.startsWith('_') && (!stack || f === `${stack}.bicep`),
      );
  if (files.length === 0) return;

  // Estágio 1: compilação Bicep (detecta erros de sintaxe sem precisar de RG)
  let hasError = false;
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stackName = file.replace('.bicep', '');
    const result = spawnSync('az', ['bicep', 'build', '--file', filePath, '--stdout'], { encoding: 'utf-8' });
    if (result.status !== 0) {
      ui.warn(`az bicep build falhou para '${stackName}':\n${result.stderr || result.stdout}`);
      hasError = true;
    } else {
      ui.log(`  Bicep build OK: ${stackName}`);
    }
  }
  if (hasError) {
    ui.error('Erro de sintaxe Bicep. Corrija antes de fazer deploy.');
  }

  // Estágio 2: validação via API Azure (requer resource group configurado e existente)
  if (!resourceGroup) {
    ui.log('  az deployment validate: resourceGroup não configurado no iacmp.json — skipped.');
    return;
  }
  const rgCheck = spawnSync(
    'az',
    ['group', 'show', '--name', resourceGroup, '--query', 'name', '-o', 'tsv'],
    { encoding: 'utf-8' },
  );
  if (rgCheck.status !== 0) {
    return;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stackName = file.replace('.bicep', '');
    const params = detectBicepRequiredParams(filePath);
    const paramArgs = Object.entries(params).flatMap(([k, v]) => ['--parameters', `${k}=${v}`]);
    const result = spawnSync(
      'az',
      [
        'deployment', 'group', 'validate',
        '--resource-group', resourceGroup,
        '--template-file', filePath,
        '--mode', 'Incremental',
        ...paramArgs,
      ],
      { encoding: 'utf-8' },
    );
    if (result.status !== 0) {
      const output = result.stderr || result.stdout || '';
      // MaxNumberOfRegionalEnvironmentsInSubExceeded: o sharedCaeId param resolve
      // em deploy-time — não é um erro real de template, apenas uma limitação de
      // quota que o deploy orquestra via outputs acumulados entre stacks.
      if (output.includes('MaxNumberOfRegionalEnvironmentsInSubExceeded')) {
        ui.log(`  az deployment validate: ${stackName} — CAE quota (sharedCaeId resolve em deploy)`);
      } else if (output.includes('Alerts are currently not supported at') && output.includes('microsoft.app/containerapps')) {
        // Metric alerts para Container Apps só aceitam escopo de recurso individual.
        // O bicep.ts gera param alarmScopeId (default '') com condition — o alarm
        // só é criado quando o deploy injeta o resource ID real do Container App.
        ui.log(`  az deployment validate: ${stackName} — Container Apps alert scope resolve em deploy (param alarmScopeId)`);
      } else {
        ui.warn(`az deployment group validate falhou para '${stackName}':\n${output}`);
        hasError = true;
      }
    } else {
      ui.log(`  az deployment validate OK: ${stackName}`);
    }
  }

  if (hasError) {
    ui.error('Validação Azure encontrou erros. Corrija antes de fazer deploy.');
  }
}

/**
 * Detecta params Bicep sem valor default (obrigatórios) e retorna um mapa
 * `nome → valor dummy` tipado, para passar ao `az deployment group validate`
 * sem travar por "missing required parameter".
 */
function detectBicepRequiredParams(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const params: Record<string, string> = {};
  for (const line of content.split('\n')) {
    // Param obrigatório: `param <nome> <tipo>` sem `= <default>` ao final
    const m = line.match(/^param\s+(\w+)\s+(\w+)\s*$/);
    if (!m) continue;
    const [, name, type] = m;
    switch (type) {
      case 'int':  params[name] = '0'; break;
      case 'bool': params[name] = 'false'; break;
      default:     params[name] = 'dummy'; break;
    }
  }
  return params;
}
