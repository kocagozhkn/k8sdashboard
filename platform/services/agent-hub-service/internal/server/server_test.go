package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kocagozhkn/k8sdashboard/platform/services/agent-hub-service/internal/handler"
)

func TestHealthz(t *testing.T) {
	h := handler.NewHub()
	srv := httptest.NewServer(NewRouter(h))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}
