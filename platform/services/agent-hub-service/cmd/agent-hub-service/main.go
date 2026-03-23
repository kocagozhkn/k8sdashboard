package main

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/kocagozhkn/k8sdashboard/platform/services/agent-hub-service/internal/handler"
	"github.com/kocagozhkn/k8sdashboard/platform/services/agent-hub-service/internal/server"
)

func main() {
	addr := ":8086"
	if v := strings.TrimSpace(os.Getenv("HTTP_ADDR")); v != "" {
		addr = v
	}
	hub := handler.NewHub()
	srv := &http.Server{
		Addr:              addr,
		Handler:           server.NewRouter(hub),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("agent-hub-service listening on %s", addr)
	log.Fatal(srv.ListenAndServe())
}
