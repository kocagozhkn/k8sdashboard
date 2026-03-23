package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Hub is an in-memory stub store (replace with Postgres later).
type Hub struct {
	mu            sync.RWMutex
	agents        map[string]*agentRec
	versions      map[string][]agentVer // agentID -> versions oldest-first
	deployments   map[string]*deployedModel
	catalog       []catalogModel
	guardrails    map[string]*guardrailRec
	ready         bool
	catalogSeeded bool
}

type agentRec struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Config      map[string]any `json:"config,omitempty"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
}

type agentVer struct {
	Version   string         `json:"version"`
	AgentID   string         `json:"agent_id"`
	CreatedAt time.Time      `json:"created_at"`
	Snapshot  map[string]any `json:"snapshot,omitempty"`
}

type deployedModel struct {
	DeploymentName string    `json:"deployment_name"`
	ModelName      string    `json:"model_name"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"created_at"`
}

type catalogModel struct {
	Name          string `json:"name"`
	Provider      string `json:"provider"`
	ContextWindow int    `json:"context_window,omitempty"`
}

type guardrailRec struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Rules     []string  `json:"rules,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

func NewHub() *Hub {
	return &Hub{
		agents:      make(map[string]*agentRec),
		versions:    make(map[string][]agentVer),
		deployments: make(map[string]*deployedModel),
		guardrails:  make(map[string]*guardrailRec),
		ready:       true,
	}
}

func (h *Hub) seedCatalog() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.catalogSeeded {
		return
	}
	h.catalog = []catalogModel{
		{Name: "gpt-4.1-mini", Provider: "openai", ContextWindow: 128000},
		{Name: "claude-3-5-sonnet", Provider: "anthropic", ContextWindow: 200000},
	}
	h.catalogSeeded = true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// Healthz liveness.
func (h *Hub) Healthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// Readyz readiness.
func (h *Hub) Readyz(w http.ResponseWriter, _ *http.Request) {
	h.mu.RLock()
	ok := h.ready
	h.mu.RUnlock()
	if !ok {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("not ready"))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

type createAgentBody struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Config      map[string]any `json:"config"`
}

func (h *Hub) CreateAgent(w http.ResponseWriter, r *http.Request) {
	var body createAgentBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		writeErr(w, http.StatusBadRequest, "name required")
		return
	}
	now := time.Now().UTC()
	id := uuid.NewString()
	rec := &agentRec{
		ID: id, Name: body.Name, Description: body.Description,
		Config: body.Config, CreatedAt: now, UpdatedAt: now,
	}
	h.mu.Lock()
	h.agents[id] = rec
	h.snapshotVersionLocked(id, "1", rec)
	h.mu.Unlock()
	w.Header().Set("Location", "/agents/"+id)
	writeJSON(w, http.StatusCreated, rec)
}

func (h *Hub) snapshotVersionLocked(agentID, ver string, rec *agentRec) {
	snap := map[string]any{
		"name": rec.Name, "description": rec.Description, "config": rec.Config,
	}
	h.versions[agentID] = append(h.versions[agentID], agentVer{
		Version: ver, AgentID: agentID, CreatedAt: time.Now().UTC(), Snapshot: snap,
	})
}

func (h *Hub) ListAgents(w http.ResponseWriter, _ *http.Request) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*agentRec, 0, len(h.agents))
	for _, a := range h.agents {
		out = append(out, a)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "total": len(out)})
}

func (h *Hub) GetAgent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.mu.RLock()
	a, ok := h.agents[id]
	h.mu.RUnlock()
	if !ok {
		writeErr(w, http.StatusNotFound, "agent not found")
		return
	}
	writeJSON(w, http.StatusOK, a)
}

type updateAgentBody struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Config      map[string]any `json:"config"`
}

func (h *Hub) UpdateAgent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body updateAgentBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	a, ok := h.agents[id]
	if !ok {
		writeErr(w, http.StatusNotFound, "agent not found")
		return
	}
	if body.Name != "" {
		a.Name = body.Name
	}
	if body.Description != "" {
		a.Description = body.Description
	}
	if body.Config != nil {
		a.Config = body.Config
	}
	a.UpdatedAt = time.Now().UTC()
	nextVer := len(h.versions[id]) + 1
	h.snapshotVersionLocked(id, strconv.Itoa(nextVer), a)
	writeJSON(w, http.StatusOK, a)
}

func (h *Hub) DeleteAgent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.agents[id]; !ok {
		writeErr(w, http.StatusNotFound, "agent not found")
		return
	}
	delete(h.agents, id)
	delete(h.versions, id)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Hub) ListVersions(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.mu.RLock()
	defer h.mu.RUnlock()
	if _, ok := h.agents[id]; !ok {
		writeErr(w, http.StatusNotFound, "agent not found")
		return
	}
	items := append([]agentVer(nil), h.versions[id]...)
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Hub) GetVersion(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ver := chi.URLParam(r, "version")
	h.mu.RLock()
	defer h.mu.RUnlock()
	if _, ok := h.agents[id]; !ok {
		writeErr(w, http.StatusNotFound, "agent not found")
		return
	}
	for _, v := range h.versions[id] {
		if v.Version == ver {
			writeJSON(w, http.StatusOK, v)
			return
		}
	}
	writeErr(w, http.StatusNotFound, "version not found")
}

func (h *Hub) RestoreVersion(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ver := chi.URLParam(r, "version")
	h.mu.Lock()
	defer h.mu.Unlock()
	a, ok := h.agents[id]
	if !ok {
		writeErr(w, http.StatusNotFound, "agent not found")
		return
	}
	var found *agentVer
	for i := range h.versions[id] {
		if h.versions[id][i].Version == ver {
			found = &h.versions[id][i]
			break
		}
	}
	if found == nil {
		writeErr(w, http.StatusNotFound, "version not found")
		return
	}
	if name, ok := found.Snapshot["name"].(string); ok {
		a.Name = name
	}
	if desc, ok := found.Snapshot["description"].(string); ok {
		a.Description = desc
	}
	if cfg, ok := found.Snapshot["config"].(map[string]any); ok {
		a.Config = cfg
	}
	a.UpdatedAt = time.Now().UTC()
	nextVer := len(h.versions[id]) + 1
	h.snapshotVersionLocked(id, strconv.Itoa(nextVer), a)
	writeJSON(w, http.StatusOK, a)
}

func (h *Hub) ListDeployed(w http.ResponseWriter, _ *http.Request) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*deployedModel, 0, len(h.deployments))
	for _, d := range h.deployments {
		out = append(out, d)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (h *Hub) ListCatalog(w http.ResponseWriter, _ *http.Request) {
	h.seedCatalog()
	h.mu.RLock()
	defer h.mu.RUnlock()
	items := append([]catalogModel(nil), h.catalog...)
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

type deployBody struct {
	DeploymentName string `json:"deployment_name"`
	ModelName      string `json:"model_name"`
}

func (h *Hub) DeployModel(w http.ResponseWriter, r *http.Request) {
	var body deployBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil ||
		strings.TrimSpace(body.DeploymentName) == "" || strings.TrimSpace(body.ModelName) == "" {
		writeErr(w, http.StatusBadRequest, "deployment_name and model_name required")
		return
	}
	if reservedModelPath(body.DeploymentName) {
		writeErr(w, http.StatusBadRequest, "invalid deployment_name")
		return
	}
	now := time.Now().UTC()
	d := &deployedModel{
		DeploymentName: body.DeploymentName,
		ModelName:      body.ModelName,
		Status:         "running",
		CreatedAt:      now,
	}
	h.mu.Lock()
	h.deployments[body.DeploymentName] = d
	h.mu.Unlock()
	writeJSON(w, http.StatusCreated, d)
}

func reservedModelPath(name string) bool {
	switch strings.ToLower(name) {
	case "catalog", "deployments":
		return true
	default:
		return false
	}
}

func (h *Hub) ModelCapabilities(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "model_name")
	h.seedCatalog()
	h.mu.RLock()
	found := false
	for _, c := range h.catalog {
		if c.Name == name {
			found = true
			break
		}
	}
	h.mu.RUnlock()
	if !found {
		writeErr(w, http.StatusNotFound, "model not in catalog")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"model_name":   name,
		"modalities":   []string{"text"},
		"max_tokens":   8192,
		"context_window": 128000,
	})
}

func (h *Hub) DeleteDeployment(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "deployment_name")
	if reservedModelPath(name) {
		writeErr(w, http.StatusNotFound, "deployment not found")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.deployments[name]; !ok {
		writeErr(w, http.StatusNotFound, "deployment not found")
		return
	}
	delete(h.deployments, name)
	w.WriteHeader(http.StatusNoContent)
}

type createGuardBody struct {
	Name  string   `json:"name"`
	Rules []string `json:"rules"`
}

func (h *Hub) ListGuardrails(w http.ResponseWriter, _ *http.Request) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*guardrailRec, 0, len(h.guardrails))
	for _, g := range h.guardrails {
		out = append(out, g)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (h *Hub) CreateGuardrail(w http.ResponseWriter, r *http.Request) {
	var body createGuardBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		writeErr(w, http.StatusBadRequest, "name required")
		return
	}
	id := uuid.NewString()
	now := time.Now().UTC()
	g := &guardrailRec{ID: id, Name: body.Name, Rules: body.Rules, CreatedAt: now}
	h.mu.Lock()
	h.guardrails[id] = g
	h.mu.Unlock()
	writeJSON(w, http.StatusCreated, g)
}

func (h *Hub) GetGuardrail(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.mu.RLock()
	g, ok := h.guardrails[id]
	h.mu.RUnlock()
	if !ok {
		writeErr(w, http.StatusNotFound, "guardrail not found")
		return
	}
	writeJSON(w, http.StatusOK, g)
}

func (h *Hub) DeleteGuardrail(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.guardrails[id]; !ok {
		writeErr(w, http.StatusNotFound, "guardrail not found")
		return
	}
	delete(h.guardrails, id)
	w.WriteHeader(http.StatusNoContent)
}
