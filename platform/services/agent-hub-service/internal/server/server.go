package server

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/kocagozhkn/k8sdashboard/platform/services/agent-hub-service/internal/handler"
)

// NewRouter wires HTTP routes for agent-hub-service (OpenAPI agent-hub-service.yaml).
func NewRouter(h *handler.Hub) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", h.Healthz)
	r.Get("/readyz", h.Readyz)

	r.Route("/agents", func(r chi.Router) {
		r.Post("/", h.CreateAgent)
		r.Get("/", h.ListAgents)
		r.Route("/{id}", func(r chi.Router) {
			r.Get("/", h.GetAgent)
			r.Put("/", h.UpdateAgent)
			r.Delete("/", h.DeleteAgent)
			r.Get("/versions", h.ListVersions)
			r.Route("/versions/{version}", func(r chi.Router) {
				r.Get("/", h.GetVersion)
				r.Post("/restore", h.RestoreVersion)
			})
		})
	})

	r.Route("/models", func(r chi.Router) {
		r.Get("/", h.ListDeployed)
		r.Get("/catalog", h.ListCatalog)
		r.Post("/deployments", h.DeployModel)
		r.Get("/{model_name}/capabilities", h.ModelCapabilities)
		r.Delete("/{deployment_name}", h.DeleteDeployment)
	})

	r.Route("/guardrails", func(r chi.Router) {
		r.Get("/", h.ListGuardrails)
		r.Post("/", h.CreateGuardrail)
		r.Route("/{id}", func(r chi.Router) {
			r.Get("/", h.GetGuardrail)
			r.Delete("/", h.DeleteGuardrail)
		})
	})

	return r
}
