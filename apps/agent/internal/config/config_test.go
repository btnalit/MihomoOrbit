package config

import (
	"testing"
	"time"
)

func TestParseMihomoConfigFlags(t *testing.T) {
	cfg, err := Parse([]string{
		"-server-url", "http://c:3001",
		"-backend-id", "1",
		"-backend-token", "t",
		"-gateway-url", "http://g:9090",
		"-mihomo-config", "/etc/mihomo/config.yaml",
		"-config-check-interval", "5s",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MihomoConfigPath != "/etc/mihomo/config.yaml" {
		t.Fatalf("path not parsed")
	}
	if cfg.ConfigCheckInterval != 10*time.Second {
		t.Fatalf("interval must clamp to 10s floor, got %v", cfg.ConfigCheckInterval)
	}
}

func TestParseDefaultsToDisabled(t *testing.T) {
	cfg, err := Parse([]string{
		"-server-url", "http://c:3001",
		"-backend-id", "1",
		"-backend-token", "t",
		"-gateway-url", "http://g:9090",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MihomoConfigPath != "" {
		t.Fatal("must default to disabled")
	}
	if cfg.ConfigCheckInterval != 60*time.Second {
		t.Fatalf("default 60s, got %v", cfg.ConfigCheckInterval)
	}
}
