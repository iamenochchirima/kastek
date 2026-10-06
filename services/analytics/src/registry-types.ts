export interface MetricDefinition {
 key: string;
 version: number;
 domain: string;
 owner: string;
 lifecycle: string;
 description: string;
 value_type: string;
 unit: string;
 precision: number | null;
 sources: (string)[];
 formula: string;
 eligible_population: string;
 exclusions: (string)[];
 numerator: string | null;
 denominator: string | null;
 time_semantics: string;
 default_aggregation: string;
 temporal_aggregation: string;
 comparison: string;
 deduplication: string;
 descendant_aggregation: string;
 supported_intervals: (string)[];
 scope_kinds: (string)[];
 dimensions: (string)[];
 permissions: (string)[];
 privacy_class: string;
 exactness: string;
 freshness: FreshnessDefinition;
 coverage: CoverageDefinition;
 availability: string;
 effective_from: string;
 applicability: string | null;
 replacement: string | null;
 dependencies: (string)[];
}
export interface FreshnessDefinition {
 max_age_seconds: number | bigint;
 late_data_window_seconds: number | bigint;
}
export interface CoverageDefinition {
 mode: string;
 required_sources: (string)[];
}
export interface DimensionDefinition {
 key: string;
 value_type: string;
 source: string;
 compatible_metrics: (string)[];
 filterable: boolean;
 groupable: boolean;
 cardinality: string;
 privacy_class: string;
 stable_key: boolean;
 permissions: (string)[];
}
export interface MetricSetDefinition {
 key: string;
 version: number;
 owner: string;
 lifecycle: string;
 description: string;
 metrics: (string)[];
 default_interval: string;
 scope_kinds: (string)[];
 permissions: (string)[];
}
export interface ContractSummary {
 identity: string;
 owner: string;
 category: string;
 privacy_class: string;
 schema_sha256: string;
}
export interface RegistrySnapshot {
 contract_registry_version: string;
 metrics_registry_version: string;
 contracts: (ContractSummary)[];
 metrics: (MetricDefinition)[];
 dimensions: (DimensionDefinition)[];
 metric_sets: (MetricSetDefinition)[];
 sha256: string;
}
