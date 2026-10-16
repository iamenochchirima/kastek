-- A-02 creates the dedicated namespace only. Customer-facing registries,
-- scope tables, facts, quarantine, and projections belong to later packages.
CREATE SCHEMA IF NOT EXISTS analytics;

COMMENT ON SCHEMA analytics IS
    'KasiTek customer analytics storage; product tables are added by later versioned migrations';
