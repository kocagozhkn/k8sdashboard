package main

import (
	"log"
	"net/http"
	"os"
	"strings"
)

func main() {
	addr := ":8080"
	if v := strings.TrimSpace(os.Getenv("HTTP_ADDR")); v != "" {
		addr = v
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"service":"policy-service","note":"OPA/Gatekeeper violation aggregation to be implemented"}`))
	})
	log.Printf("policy-service %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
