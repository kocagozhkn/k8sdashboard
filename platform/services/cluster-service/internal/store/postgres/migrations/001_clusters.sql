CREATE TABLE IF NOT EXISTS clusters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    api_server_url TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    k8s_version TEXT NOT NULL DEFAULT '',
    labels JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'registered',
    last_heartbeat TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT clusters_tenant_name_unique UNIQUE (tenant_id, name),
    CONSTRAINT clusters_status_check CHECK (status IN (
        'registered', 'healthy', 'degraded', 'unknown', 'disconnected'
    ))
);

CREATE INDEX IF NOT EXISTS idx_clusters_tenant_id ON clusters (tenant_id);
CREATE INDEX IF NOT EXISTS idx_clusters_tenant_status ON clusters (tenant_id, status);
