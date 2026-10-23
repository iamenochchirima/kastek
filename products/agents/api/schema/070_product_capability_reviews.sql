-- Review identity belongs to its destination product; the shared worker stores opaque references only.
ALTER TABLE agents_platform.product_review_projections ADD COLUMN product text NOT NULL DEFAULT 'growth';
ALTER TABLE agents_platform.product_review_projections ALTER COLUMN review_id TYPE text USING review_id::text;
ALTER TABLE agents_platform.product_review_projections DROP CONSTRAINT product_review_projections_pkey;
ALTER TABLE agents_platform.product_review_projections ADD PRIMARY KEY(product,review_id);
