import { CloudDomains } from '../types';
import { STORAGE_AWS } from './storage';
import { COMPUTE_AWS } from './compute';
import { DATABASE_AWS } from './database';
import { CACHE_AWS } from './cache';
import { NETWORK_AWS } from './network';
import { SECURITY_AWS } from './security';
import { MESSAGING_AWS } from './messaging';
import { WORKFLOW_AWS } from './workflow';
import { MONITORING_AWS } from './monitoring';
import { ML_AWS } from './ml';

export const AWS: CloudDomains = {
  storage: STORAGE_AWS,
  compute: COMPUTE_AWS,
  database: DATABASE_AWS,
  cache: CACHE_AWS,
  network: NETWORK_AWS,
  security: SECURITY_AWS,
  messaging: MESSAGING_AWS,
  workflow: WORKFLOW_AWS,
  monitoring: MONITORING_AWS,
  ml: ML_AWS,
};
