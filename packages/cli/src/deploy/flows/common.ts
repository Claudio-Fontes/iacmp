import * as readline from 'readline';
import { IacmpConfig } from '../../utils';
import { DeployContext, DeployExecutor, DestroyContext } from '../types';
import { TemplateRef } from '../../synth-out';

/**
 * Interface mínima de saída que os fluxos de deploy recebem do comando oclif.
 * Mantém os fluxos desacoplados do Command e preserva a semântica de `error`
 * (lança, nunca retorna).
 */
export interface DeployUI {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): never;
}

/** Contexto comum que o comando monta uma vez e todos os fluxos consomem. */
export interface DeployFlowOptions {
  cwd: string;
  config: IacmpConfig;
  provider: string;
  region: string;
  dryRun: boolean;
  yes: boolean;
  stackFlag?: string;
  executor: DeployExecutor;
  /** Templates já filtrados por --stack, em ordem de dependência. */
  templates: TemplateRef[];
  /** Todos os templates do provider (sem filtro --stack). */
  allTemplates: TemplateRef[];
  baseCtx: Omit<DeployContext, 'stackName' | 'templatePath'>;
  physicalStackName(logicalName: string): string;
  ui: DeployUI;
}

/** Contexto comum dos fluxos de destroy (espelha DeployFlowOptions). */
export interface DestroyFlowOptions {
  cwd: string;
  config: IacmpConfig;
  provider: string;
  region: string;
  dryRun: boolean;
  force: boolean;
  stackFlag?: string;
  executor: DeployExecutor;
  /** Templates em ordem REVERSA de dependência (quem importa cai antes de quem exporta). */
  templates: TemplateRef[];
  baseCtx: Omit<DestroyContext, 'stackName'>;
  physicalStackName(logicalName: string): string;
  ui: DeployUI;
}

export function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${message} (y/N): `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
