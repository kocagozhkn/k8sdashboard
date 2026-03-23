package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

func main() {
	listen := getenv("LISTEN_ADDR", ":8080")
	upstream := getenv("CLUSTER_SERVICE_URL", "http://cluster-service:8081")
	u, err := url.Parse(upstream)
	if err != nil {
		log.Fatalf("CLUSTER_SERVICE_URL: %v", err)
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.FlushInterval = 100 * time.Millisecond
	orig := proxy.Director
	proxy.Director = func(req *http.Request) {
		orig(req)
		req.Host = u.Host
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			proxy.ServeHTTP(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("use /api/v1/* (proxied to cluster-service)"))
	})

	srv := &http.Server{
		Addr:              listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("api-gateway on %s → %s", listen, upstream)
	log.Fatal(srv.ListenAndServe())
}

func getenv(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}
