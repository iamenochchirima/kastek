import type { Pool } from 'pg';
import type { TenantConfig } from './config.js';
export interface TenantContext { pool: Pool; config: TenantConfig; }
