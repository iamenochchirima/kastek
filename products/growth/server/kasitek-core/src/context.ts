import type { Pool } from 'pg';
import type { CoreConfig } from './config.js';

export interface CoreContext {
  pool: Pool;
  config: CoreConfig;
}
