CREATE TABLE agents_platform.mcp_source_reviews (
 id uuid PRIMARY KEY, request_id uuid NOT NULL, organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 account_id uuid NOT NULL REFERENCES agents_platform.accounts(id), connection_id uuid NOT NULL REFERENCES agents_platform.mcp_oauth_connections(id),
 source_id uuid NOT NULL REFERENCES agents_platform.sources(id), revision_id uuid REFERENCES agents_platform.source_revisions(id),
 expected_generation integer NOT NULL, action text NOT NULL CHECK(action IN ('approve','visibility')),
 visibility text CHECK(visibility IN ('private','public')), state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 UNIQUE(organization_id,account_id,request_id)
);
