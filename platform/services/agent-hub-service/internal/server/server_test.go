package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kocagozhkn/k8sdashboard/platform/services/agent-hub-service/internal/handler"
)

func TestHealthz(t *testing.T) {
	h := handler.NewHub()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	NewRouter(h).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
}
