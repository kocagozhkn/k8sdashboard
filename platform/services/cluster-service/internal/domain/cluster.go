package domain

import "time"

// ClusterStatus is persisted as lowercase string (DB check constraint).
type ClusterStatus string

const (
	StatusRegistered   ClusterStatus = "registered"
	StatusHealthy      ClusterStatus = "healthy"
	StatusDegraded     ClusterStatus = "degraded"
	StatusUnknown      ClusterStatus = "unknown"
	StatusDisconnected ClusterStatus = "disconnected"
)

func (s ClusterStatus) Valid() bool {
	switch s {
	case StatusRegistered, StatusHealthy, StatusDegraded, StatusUnknown, StatusDisconnected:
		return true
	default:
		return false
	}
}

// Cluster is hub-side metadata for a spoke cluster (no kubeconfig in domain model).
type Cluster struct {
	ID            string
	TenantID      string
	Name          string
	DisplayName   string
	APIServerURL  string
	Region        string
	Provider      string
	K8sVersion    string
	Labels        map[string]string
	Status        ClusterStatus
	LastHeartbeat *time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
}
