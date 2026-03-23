package config

import (
	"os"
	"strings"
)

// Config holds process configuration from environment variables.
type Config struct {
	HTTPAddr    string
	DatabaseURL string
}

func Load() Config {
	return Config{
		HTTPAddr:    getEnv("HTTP_ADDR", ":8081"),
		DatabaseURL: strings.TrimSpace(os.Getenv("DATABASE_URL")),
	}
}

func getEnv(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}
