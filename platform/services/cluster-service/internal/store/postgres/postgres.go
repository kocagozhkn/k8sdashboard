package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/domain"
	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/store"
)

// Store implements store.ClusterStore using PostgreSQL.
type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

func (s *Store) Create(ctx context.Context, c *domain.Cluster) error {
	if c.Labels == nil {
		c.Labels = map[string]string{}
	}
	labels, err := json.Marshal(c.Labels)
	if err != nil {
		return fmt.Errorf("labels: %w", err)
	}
	tid, err := uuid.Parse(c.TenantID)
	if err != nil {
		return fmt.Errorf("tenant_id: %w", err)
	}
	if c.Status == "" {
		c.Status = domain.StatusRegistered
	}
	if !c.Status.Valid() {
		return fmt.Errorf("invalid status %q", c.Status)
	}
	row := s.pool.QueryRow(ctx, `
INSERT INTO clusters (
  tenant_id, name, display_name, api_server_url, region, provider, k8s_version, labels, status
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
RETURNING id, created_at, updated_at`,
		tid, c.Name, c.DisplayName, c.APIServerURL, c.Region, c.Provider, c.K8sVersion, labels, string(c.Status),
	)
	var id uuid.UUID
	if err := row.Scan(&id, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return fmt.Errorf("insert cluster: %w", err)
	}
	c.ID = id.String()
	return nil
}

func (s *Store) Get(ctx context.Context, tenantID, id string) (*domain.Cluster, error) {
	tid, err := uuid.Parse(tenantID)
	if err != nil {
		return nil, fmt.Errorf("tenant_id: %w", err)
	}
	cid, err := uuid.Parse(id)
	if err != nil {
		return nil, fmt.Errorf("id: %w", err)
	}
	row := s.pool.QueryRow(ctx, `
SELECT id, tenant_id, name, display_name, api_server_url, region, provider, k8s_version, labels, status,
       last_heartbeat, created_at, updated_at
FROM clusters WHERE tenant_id = $1 AND id = $2`, tid, cid)
	return scanCluster(row)
}

func (s *Store) List(ctx context.Context, tenantID string, limit, offset int) ([]domain.Cluster, int, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	tid, err := uuid.Parse(tenantID)
	if err != nil {
		return nil, 0, fmt.Errorf("tenant_id: %w", err)
	}
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM clusters WHERE tenant_id = $1`, tid).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.pool.Query(ctx, `
SELECT id, tenant_id, name, display_name, api_server_url, region, provider, k8s_version, labels, status,
       last_heartbeat, created_at, updated_at
FROM clusters WHERE tenant_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3`, tid, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []domain.Cluster
	for rows.Next() {
		c, err := scanCluster(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *c)
	}
	return out, total, rows.Err()
}

func (s *Store) Update(ctx context.Context, c *domain.Cluster) error {
	if c.Labels == nil {
		c.Labels = map[string]string{}
	}
	labels, err := json.Marshal(c.Labels)
	if err != nil {
		return fmt.Errorf("labels: %w", err)
	}
	tid, err := uuid.Parse(c.TenantID)
	if err != nil {
		return fmt.Errorf("tenant_id: %w", err)
	}
	cid, err := uuid.Parse(c.ID)
	if err != nil {
		return fmt.Errorf("id: %w", err)
	}
	if !c.Status.Valid() {
		return fmt.Errorf("invalid status %q", c.Status)
	}
	cmd, err := s.pool.Exec(ctx, `
UPDATE clusters SET
  display_name = $3,
  api_server_url = $4,
  region = $5,
  provider = $6,
  k8s_version = $7,
  labels = $8,
  status = $9,
  updated_at = now()
WHERE tenant_id = $1 AND id = $2`,
		tid, cid,
		c.DisplayName, c.APIServerURL, c.Region, c.Provider, c.K8sVersion,
		labels, string(c.Status),
	)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) Delete(ctx context.Context, tenantID, id string) error {
	tid, err := uuid.Parse(tenantID)
	if err != nil {
		return fmt.Errorf("tenant_id: %w", err)
	}
	cid, err := uuid.Parse(id)
	if err != nil {
		return fmt.Errorf("id: %w", err)
	}
	cmd, err := s.pool.Exec(ctx, `DELETE FROM clusters WHERE tenant_id = $1 AND id = $2`, tid, cid)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) Heartbeat(ctx context.Context, tenantID, id string, status domain.ClusterStatus, at time.Time) error {
	if !status.Valid() {
		return fmt.Errorf("invalid status %q", status)
	}
	tid, err := uuid.Parse(tenantID)
	if err != nil {
		return fmt.Errorf("tenant_id: %w", err)
	}
	cid, err := uuid.Parse(id)
	if err != nil {
		return fmt.Errorf("id: %w", err)
	}
	cmd, err := s.pool.Exec(ctx, `
UPDATE clusters SET status = $3, last_heartbeat = $4, updated_at = now()
WHERE tenant_id = $1 AND id = $2`, tid, cid, string(status), at)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanCluster(row rowScanner) (*domain.Cluster, error) {
	var (
		c                                           domain.Cluster
		tid, cid                                    uuid.UUID
		labels                                      []byte
		status                                      string
		last                                        *time.Time
	)
	err := row.Scan(
		&cid, &tid, &c.Name, &c.DisplayName, &c.APIServerURL, &c.Region, &c.Provider, &c.K8sVersion,
		&labels, &status, &last, &c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, store.ErrNotFound
		}
		return nil, err
	}
	c.ID = cid.String()
	c.TenantID = tid.String()
	c.Status = domain.ClusterStatus(status)
	c.LastHeartbeat = last
	if len(labels) > 0 {
		if err := json.Unmarshal(labels, &c.Labels); err != nil {
			return nil, fmt.Errorf("labels json: %w", err)
		}
	} else {
		c.Labels = map[string]string{}
	}
	return &c, nil
}
