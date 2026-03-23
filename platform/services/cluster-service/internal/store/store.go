package store

import (
	"context"
	"errors"
	"time"

	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/domain"
)

var ErrNotFound = errors.New("cluster not found")

// ClusterStore is the persistence contract (Postgres implementation in store/postgres).
type ClusterStore interface {
	Ping(ctx context.Context) error
	Create(ctx context.Context, c *domain.Cluster) error
	Get(ctx context.Context, tenantID, id string) (*domain.Cluster, error)
	List(ctx context.Context, tenantID string, limit, offset int) ([]domain.Cluster, int, error)
	Update(ctx context.Context, c *domain.Cluster) error
	Delete(ctx context.Context, tenantID, id string) error
	Heartbeat(ctx context.Context, tenantID, id string, status domain.ClusterStatus, at time.Time) error
}
