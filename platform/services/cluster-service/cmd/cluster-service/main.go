package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/config"
	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/handler"
	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/server"
	"github.com/kocagozhkn/k8sdashboard/platform/services/cluster-service/internal/store/postgres"
)

func main() {
	cfg := config.Load()
	if cfg.DatabaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("pgx pool: %v", err)
	}
	defer pool.Close()
	if err := postgres.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	h := &handler.ClusterHTTP{Store: postgres.NewStore(pool)}
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.NewRouter(h),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("cluster-service listening on %s", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
	log.Println("cluster-service stopped")
}
