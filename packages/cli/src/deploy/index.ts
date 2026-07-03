import { awsExecutor } from './aws';
import { azureExecutor } from './azure';
import { gcpExecutor } from './gcp';
import { terraformExecutor } from './terraform';
import { DeployExecutor } from './types';

const EXECUTORS: Record<string, DeployExecutor> = {
  aws: awsExecutor,
  azure: azureExecutor,
  gcp: gcpExecutor,
  terraform: terraformExecutor,
};

export function getExecutor(provider: string): DeployExecutor {
  const executor = EXECUTORS[provider];
  if (!executor) {
    throw new Error(`Provider desconhecido: ${provider}. Use: ${Object.keys(EXECUTORS).join(', ')}`);
  }
  return executor;
}

export * from './types';
export * from './exec';
export { resourceGroupExists, getAzureStackOutputs } from './azure';
export { resolveProjectId } from './gcp';
export { findExistingRetainedResources, deleteResourceAndWait } from './aws';
