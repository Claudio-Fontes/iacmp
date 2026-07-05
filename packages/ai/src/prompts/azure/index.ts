import { CloudDomains } from '../types';
import { STORAGE_AZURE } from './storage';
import { COMPUTE_AZURE } from './compute';
import { DATABASE_AZURE } from './database';
import { CACHE_AZURE } from './cache';
import { NETWORK_AZURE } from './network';
import { SECURITY_AZURE } from './security';
import { MESSAGING_AZURE } from './messaging';
import { WORKFLOW_AZURE } from './workflow';
import { MONITORING_AZURE } from './monitoring';
import { ML_AZURE } from './ml';

export const AZURE: CloudDomains = {
  storage: STORAGE_AZURE,
  compute: COMPUTE_AZURE,
  database: DATABASE_AZURE,
  cache: CACHE_AZURE,
  network: NETWORK_AZURE,
  security: SECURITY_AZURE,
  messaging: MESSAGING_AZURE,
  workflow: WORKFLOW_AZURE,
  monitoring: MONITORING_AZURE,
  ml: ML_AZURE,
};
