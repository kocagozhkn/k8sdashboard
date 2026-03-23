package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/domain"
	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/store"
)

const headerTenantID = "X-Tenant-ID"

// ClusterHTTP serves REST handlers for cluster registry.
type ClusterHTTP struct {
	Store store.ClusterStore
}

type clusterDTO struct {
	ID             string            `json:"id"`
	TenantID       string            `json:"tenant_id"`
	Name           string            `json:"name"`
	DisplayName    string            `json:"display_name"`
	APIServerURL   string            `json:"api_server_url"`
	Region         string            `json:"region"`
	Provider       string            `json:"provider"`
	K8sVersion     string            `json:"k8s_version"`
	Labels         map[string]string `json:"labels"`
	Status         string            `json:"status"`
	LastHeartbeat  *string           `json:"last_heartbeat,omitempty"`
	CreatedAt      string            `json:"created_at"`
	UpdatedAt      string            `json:"updated_at"`
}

func toDTO(c *domain.Cluster) clusterDTO {
	d := clusterDTO{
		ID: c.ID, TenantID: c.TenantID, Name: c.Name, DisplayName: c.DisplayName,
		APIServerURL: c.APIServerURL, Region: c.Region, Provider: c.Provider,
		K8sVersion: c.K8sVersion, Labels: c.Labels, Status: string(c.Status),
		CreatedAt: c.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
		UpdatedAt: c.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z"),
	}
	if c.LastHeartbeat != nil {
		s := c.LastHeartbeat.UTC().Format("2006-01-02T15:04:05Z")
		d.LastHeartbeat = &s
	}
	return d
}

type createClusterRequest struct {
	Name         string            `json:"name"`
	DisplayName  string            `json:"display_name"`
	APIServerURL string            `json:"api_server_url"`
	Region       string            `json:"region"`
	Provider     string            `json:"provider"`
	K8sVersion   string            `json:"k8s_version"`
	Labels       map[string]string `json:"labels"`
}

type patchClusterRequest struct {
	DisplayName   *string            `json:"display_name"`
	APIServerURL  *string            `json:"api_server_url"`
	Region        *string            `json:"region"`
	Provider      *string            `json:"provider"`
	K8sVersion    *string            `json:"k8s_version"`
	Labels        *map[string]string `json:"labels"`
	Status        *string            `json:"status"`
}

type heartbeatRequest struct {
	Status string `json:"status"`
}

type errorBody struct {
	Error string `json:"error"`
}

func tenantFrom(r *http.Request) (string, error) {
	raw := r.Header.Get(headerTenantID)
	if raw == "" {
		return "", errors.New("missing X-Tenant-ID")
	}
	if _, err := uuid.Parse(raw); err != nil {
		return "", errors.New("invalid X-Tenant-ID")
	}
	return raw, nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// Healthz implements Kubernetes-style liveness probe.
func (h *ClusterHTTP) Healthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// Readyz implements readiness (DB reachable).
func (h *ClusterHTTP) Readyz(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := h.Store.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: "not ready"})
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// ListClusters GET /api/v1/clusters
func (h *ClusterHTTP) ListClusters(w http.ResponseWriter, r *http.Request) {
	tenant, err := tenantFrom(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	effLimit := limit
	if effLimit <= 0 || effLimit > 500 {
		effLimit = 50
	}
	if offset < 0 {
		offset = 0
	}
	list, total, err := h.Store.List(r.Context(), tenant, effLimit, offset)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: err.Error()})
		return
	}
	out := make([]clusterDTO, 0, len(list))
	for i := range list {
		out = append(out, toDTO(&list[i]))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": out, "total": total, "limit": effLimit, "offset": offset,
	})
}

// CreateCluster POST /api/v1/clusters
func (h *ClusterHTTP) CreateCluster(w http.ResponseWriter, r *http.Request) {
	tenant, err := tenantFrom(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	var req createClusterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid json"})
		return
	}
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "name required"})
		return
	}
	c := &domain.Cluster{
		TenantID: tenant, Name: req.Name, DisplayName: req.DisplayName,
		APIServerURL: req.APIServerURL, Region: req.Region, Provider: req.Provider,
		K8sVersion: req.K8sVersion, Labels: req.Labels, Status: domain.StatusRegistered,
	}
	if err := h.Store.Create(r.Context(), c); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	created, _ := h.Store.Get(r.Context(), tenant, c.ID)
	writeJSON(w, http.StatusCreated, toDTO(created))
}

// GetCluster GET /api/v1/clusters/{id}
func (h *ClusterHTTP) GetCluster(w http.ResponseWriter, r *http.Request) {
	tenant, err := tenantFrom(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	id := chi.URLParam(r, "id")
	c, err := h.Store.Get(r.Context(), tenant, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errorBody{Error: "not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, toDTO(c))
}

// PatchCluster PATCH /api/v1/clusters/{id}
func (h *ClusterHTTP) PatchCluster(w http.ResponseWriter, r *http.Request) {
	tenant, err := tenantFrom(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	id := chi.URLParam(r, "id")
	existing, err := h.Store.Get(r.Context(), tenant, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errorBody{Error: "not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: err.Error()})
		return
	}
	var req patchClusterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid json"})
		return
	}
	if req.DisplayName != nil {
		existing.DisplayName = *req.DisplayName
	}
	if req.APIServerURL != nil {
		existing.APIServerURL = *req.APIServerURL
	}
	if req.Region != nil {
		existing.Region = *req.Region
	}
	if req.Provider != nil {
		existing.Provider = *req.Provider
	}
	if req.K8sVersion != nil {
		existing.K8sVersion = *req.K8sVersion
	}
	if req.Labels != nil {
		existing.Labels = *req.Labels
	}
	if req.Status != nil {
		st := domain.ClusterStatus(*req.Status)
		if !st.Valid() {
			writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid status"})
			return
		}
		existing.Status = st
	}
	if err := h.Store.Update(r.Context(), existing); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errorBody{Error: "not found"})
			return
		}
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	updated, _ := h.Store.Get(r.Context(), tenant, id)
	writeJSON(w, http.StatusOK, toDTO(updated))
}

// DeleteCluster DELETE /api/v1/clusters/{id}
func (h *ClusterHTTP) DeleteCluster(w http.ResponseWriter, r *http.Request) {
	tenant, err := tenantFrom(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.Store.Delete(r.Context(), tenant, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errorBody{Error: "not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Heartbeat POST /api/v1/clusters/{id}/heartbeat
func (h *ClusterHTTP) Heartbeat(w http.ResponseWriter, r *http.Request) {
	tenant, err := tenantFrom(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	id := chi.URLParam(r, "id")
	var req heartbeatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid json"})
		return
	}
	st := domain.ClusterStatus(req.Status)
	if !st.Valid() {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid status"})
		return
	}
	if err := h.Store.Heartbeat(r.Context(), tenant, id, st, time.Now().UTC()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errorBody{Error: "not found"})
			return
		}
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
		return
	}
	updated, _ := h.Store.Get(r.Context(), tenant, id)
	writeJSON(w, http.StatusOK, toDTO(updated))
}
