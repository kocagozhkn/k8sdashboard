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
	clusterURL := mustParseURL(getenv("CLUSTER_SERVICE_URL", "http://cluster-service:8081"))
	hubURL := mustParseURL(getenv("AGENT_HUB_SERVICE_URL", "http://agent-hub-service:8086"))

	clusterProxy := newReverseProxy(clusterURL)
	hubProxy := newReverseProxy(hubURL)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/agents") || strings.HasPrefix(p, "/models") || strings.HasPrefix(p, "/guardrails") {
			hubProxy.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(p, "/api/") {
			clusterProxy.ServeHTTP(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("use /api/v1/* (cluster), /agents, /models, or /guardrails (agent-hub)"))
	})

	srv := &http.Server{
		Addr:              listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("api-gateway on %s → cluster %s, agent-hub %s", listen, clusterURL.Redacted(), hubURL.Redacted())
	log.Fatal(srv.ListenAndServe())
}

func newReverseProxy(u *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.FlushInterval = 100 * time.Millisecond
	orig := proxy.Director
	proxy.Director = func(req *http.Request) {
		orig(req)
		req.Host = u.Host
	}
	return proxy
}

func mustParseURL(raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil {
		log.Fatalf("invalid URL %q: %v", raw, err)
	}
	return u
}

func getenv(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}
