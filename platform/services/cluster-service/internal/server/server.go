package server

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/handler"
)

// NewRouter wires HTTP routes for cluster-service.
func NewRouter(h *handler.ClusterHTTP) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
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
