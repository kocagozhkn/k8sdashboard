package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/domain"
	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/store"
)

const testTenant = "11111111-1111-1111-1111-111111111111"

type memStore struct {
	mu   sync.Mutex
	data map[string]*domain.Cluster
	ping error
}

func newMem() *memStore {
	return &memStore{data: make(map[string]*domain.Cluster)}
}

func key(tenant, id string) string { return tenant + "/" + id }

func (m *memStore) Ping(ctx context.Context) error {
	if m.ping != nil {
		return m.ping
	}
	return nil
}

func (m *memStore) Create(ctx context.Context, c *domain.Cluster) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.Status == "" {
		c.Status = domain.StatusRegistered
	}
	c.ID = "22222222-2222-2222-2222-222222222222"
	now := time.Now().UTC()
	c.CreatedAt, c.UpdatedAt = now, now
	m.data[key(c.TenantID, c.ID)] = c
	return nil
}

func (m *memStore) Get(ctx context.Context, tenantID, id string) (*domain.Cluster, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.data[key(tenantID, id)]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *c
	return &cp, nil
}

func (m *memStore) List(ctx context.Context, tenantID string, limit, offset int) ([]domain.Cluster, int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var all []domain.Cluster
	for _, c := range m.data {
		if c.TenantID == tenantID {
			all = append(all, *c)
		}
	}
	total := len(all)
	if offset > len(all) {
		return []domain.Cluster{}, total, nil
	}
	end := offset + limit
	if end > len(all) {
		end = len(all)
	}
	return all[offset:end], total, nil
}

func (m *memStore) Update(ctx context.Context, c *domain.Cluster) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := key(c.TenantID, c.ID)
	if _, ok := m.data[k]; !ok {
		return store.ErrNotFound
	}
	c.UpdatedAt = time.Now().UTC()
	cp := *c
	m.data[k] = &cp
	return nil
}

func (m *memStore) Delete(ctx context.Context, tenantID, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := key(tenantID, id)
	if _, ok := m.data[k]; !ok {
		return store.ErrNotFound
	}
	delete(m.data, k)
	return nil
}

func (m *memStore) Heartbeat(ctx context.Context, tenantID, id string, status domain.ClusterStatus, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := key(tenantID, id)
	c, ok := m.data[k]
	if !ok {
		return store.ErrNotFound
	}
	c.Status = status
	t := at
	c.LastHeartbeat = &t
	c.UpdatedAt = at
	return nil
}

func testRouter(h *ClusterHTTP) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Get("/healthz", h.Healthz)
	r.Get("/readyz", h.Readyz)
	r.Route("/api/v1", func(r chi.Router) {
		r.Route("/clusters", func(r chi.Router) {
			r.Get("/", h.ListClusters)
			r.Post("/", h.CreateCluster)
			r.Route("/{id}", func(r chi.Router) {
				r.Get("/", h.GetCluster)
				r.Patch("/", h.PatchCluster)
				r.Delete("/", h.DeleteCluster)
				r.Post("/heartbeat", h.Heartbeat)
			})
		})
	})
	return r
}

func TestCreateAndList(t *testing.T) {
	ms := newMem()
	h := &ClusterHTTP{Store: ms}
	r := testRouter(h)

	body := `{"name":"c1","display_name":"C1","api_server_url":"https://k8s","region":"eu","provider":"aws","k8s_version":"1.29","labels":{"a":"b"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/clusters", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerTenantID, testTenant)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create status %d %s", w.Code, w.Body.String())
	}

	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/clusters", nil)
	req2.Header.Set(headerTenantID, testTenant)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("list status %d", w2.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w2.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	items, _ := resp["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items len %d", len(items))
	}
}

func TestMissingTenant(t *testing.T) {
	h := &ClusterHTTP{Store: newMem()}
	r := testRouter(h)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/clusters", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 got %d", w.Code)
	}
}

func TestHeartbeatRoute(t *testing.T) {
	ms := newMem()
	_ = ms.Create(context.Background(), &domain.Cluster{
		TenantID: testTenant, Name: "x", Status: domain.StatusRegistered,
	})
	h := &ClusterHTTP{Store: ms}
	r := testRouter(h)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/clusters/22222222-2222-2222-2222-222222222222/heartbeat",
		bytes.NewReader([]byte(`{"status":"healthy"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerTenantID, testTenant)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat %d %s", w.Code, w.Body.String())
	}
}
