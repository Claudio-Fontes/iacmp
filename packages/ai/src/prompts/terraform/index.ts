import { CloudDomains } from '../types';
import { STORAGE_TERRAFORM } from './storage';
import { COMPUTE_TERRAFORM } from './compute';
import { DATABASE_TERRAFORM } from './database';
import { CACHE_TERRAFORM } from './cache';
import { NETWORK_TERRAFORM } from './network';
import { SECURITY_TERRAFORM } from './security';
import { MESSAGING_TERRAFORM } from './messaging';
import { WORKFLOW_TERRAFORM } from './workflow';
import { MONITORING_TERRAFORM } from './monitoring';
import { ML_TERRAFORM } from './ml';

export const TERRAFORM: CloudDomains = {
  storage: STORAGE_TERRAFORM,
  compute: COMPUTE_TERRAFORM,
  database: DATABASE_TERRAFORM,
  cache: CACHE_TERRAFORM,
  network: NETWORK_TERRAFORM,
  security: SECURITY_TERRAFORM,
  messaging: MESSAGING_TERRAFORM,
  workflow: WORKFLOW_TERRAFORM,
  monitoring: MONITORING_TERRAFORM,
  ml: ML_TERRAFORM,
};
