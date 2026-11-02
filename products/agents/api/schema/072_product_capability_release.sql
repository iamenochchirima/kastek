-- New admissions use the product-neutral loop. Existing task journals retain their release.
ALTER TABLE agents_platform.tasks ALTER COLUMN harness_release SET DEFAULT 'product-capabilities-v11';
