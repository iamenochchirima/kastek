import type pg from 'pg';
import type {AnalyticsConfig} from './config.js';
import type {RegistrySnapshot} from './registry-types.js';
import type {ProcessMetrics} from './metrics.js';
export interface AnalyticsContext {pool:pg.Pool;reportingPool?:pg.Pool;config:AnalyticsConfig;registry:RegistrySnapshot;metrics:ProcessMetrics;}
