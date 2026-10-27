// Package config carrega a configuração do servidor a partir de variáveis de ambiente.
package config

import (
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Env         string // "development" ou "production"
	ListenAddr  string
	DatabaseURL string

	// PhonePepper é o segredo usado para calcular HMAC dos telefones.
	// O servidor nunca armazena o número em texto claro.
	PhonePepper []byte

	SMSProvider   string // "console" ou "webhook"
	SMSWebhookURL string
	SMSWebhookKey string
	// DevExposeOTP devolve o código OTP na resposta HTTP. Apenas para
	// desenvolvimento e testes automatizados; proibido em produção.
	DevExposeOTP bool

	// TrustProxyHeaders usa X-Forwarded-For para identificar o IP do
	// cliente. Ative apenas atrás de um proxy reverso confiável.
	TrustProxyHeaders bool

	BlobDir            string
	MaxAttachmentBytes int64
	RetentionPeriod    time.Duration

	// SessionIdle: sessões sem uso por esse tempo expiram.
	SessionIdle time.Duration
	// LockInactivity: o bloqueio por PIN deixa de valer se a conta ficar
	// inativa por esse tempo (permite recuperar a conta sem o PIN).
	LockInactivity time.Duration

	// Chave secreta do PIN (fora do banco). PinKeyProvider: "local" (chave
	// em PinPepper) ou "openbao" (HMAC calculado no OpenBao/Vault Transit).
	PinKeyProvider string
	PinPepper      []byte
	OpenBao        OpenBaoConfig
}

type OpenBaoConfig struct {
	Addr      string
	Token     string
	TokenFile string
	Mount     string
	Key       string
}

func Load() (*Config, error) {
	c := &Config{
		Env:                env("BATEPAPO_ENV", "development"),
		ListenAddr:         env("BATEPAPO_LISTEN_ADDR", ":8080"),
		DatabaseURL:        env("BATEPAPO_DATABASE_URL", "postgres://batepapo:batepapo@localhost:5432/batepapo?sslmode=disable"),
		SMSProvider:        env("BATEPAPO_SMS_PROVIDER", "console"),
		SMSWebhookURL:      os.Getenv("BATEPAPO_SMS_WEBHOOK_URL"),
		SMSWebhookKey:      os.Getenv("BATEPAPO_SMS_WEBHOOK_KEY"),
		DevExposeOTP:       os.Getenv("BATEPAPO_DEV_EXPOSE_OTP") == "true",
		TrustProxyHeaders:  os.Getenv("BATEPAPO_TRUST_PROXY_HEADERS") == "true",
		BlobDir:            env("BATEPAPO_BLOB_DIR", "./data/blobs"),
		MaxAttachmentBytes: 64 << 20, // vídeos curtos do celular cabem
		RetentionPeriod:    30 * 24 * time.Hour,
		SessionIdle:        90 * 24 * time.Hour,
		LockInactivity:     7 * 24 * time.Hour,
	}

	if v := os.Getenv("BATEPAPO_MAX_ATTACHMENT_BYTES"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("BATEPAPO_MAX_ATTACHMENT_BYTES inválido: %q", v)
		}
		c.MaxAttachmentBytes = n
	}
	for _, d := range []struct {
		env string
		dst *time.Duration
	}{
		{"BATEPAPO_RETENTION_DAYS", &c.RetentionPeriod},
		{"BATEPAPO_SESSION_IDLE_DAYS", &c.SessionIdle},
		{"BATEPAPO_LOCK_INACTIVITY_DAYS", &c.LockInactivity},
	} {
		if v := os.Getenv(d.env); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n <= 0 {
				return nil, fmt.Errorf("%s inválido: %q", d.env, v)
			}
			*d.dst = time.Duration(n) * 24 * time.Hour
		}
	}

	pepper := os.Getenv("BATEPAPO_PHONE_PEPPER")
	switch {
	case pepper != "":
		b, err := hex.DecodeString(pepper)
		if err != nil || len(b) < 32 {
			return nil, errors.New("BATEPAPO_PHONE_PEPPER deve ter ao menos 32 bytes em hexadecimal (64 caracteres)")
		}
		c.PhonePepper = b
	case c.Env == "development":
		c.PhonePepper = []byte("batepapo-dev-pepper-NAO-USE-EM-PRODUCAO")
	default:
		return nil, errors.New("BATEPAPO_PHONE_PEPPER é obrigatório fora do ambiente de desenvolvimento")
	}

	if err := c.loadPinKey(); err != nil {
		return nil, err
	}

	if c.Env != "development" {
		if c.DevExposeOTP {
			return nil, errors.New("BATEPAPO_DEV_EXPOSE_OTP não pode ser usado fora do ambiente de desenvolvimento")
		}
		if c.SMSProvider == "console" {
			return nil, errors.New("BATEPAPO_SMS_PROVIDER=console não pode ser usado fora do ambiente de desenvolvimento")
		}
	}
	if c.SMSProvider == "webhook" && c.SMSWebhookURL == "" {
		return nil, errors.New("BATEPAPO_SMS_WEBHOOK_URL é obrigatório com BATEPAPO_SMS_PROVIDER=webhook")
	}
	return c, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// loadPinKey lê a configuração da chave secreta do PIN.
func (c *Config) loadPinKey() error {
	c.PinKeyProvider = env("BATEPAPO_PIN_KEY_PROVIDER", "local")
	switch c.PinKeyProvider {
	case "local":
		v := os.Getenv("BATEPAPO_PIN_PEPPER")
		switch {
		case v != "":
			b, err := hex.DecodeString(v)
			if err != nil || len(b) < 32 {
				return errors.New("BATEPAPO_PIN_PEPPER deve ter ao menos 32 bytes em hexadecimal (64 caracteres)")
			}
			if string(b) == string(c.PhonePepper) {
				return errors.New("BATEPAPO_PIN_PEPPER deve ser diferente de BATEPAPO_PHONE_PEPPER")
			}
			c.PinPepper = b
		case c.Env == "development":
			c.PinPepper = []byte("batepapo-dev-pin-pepper-NAO-USE-EM-PRODUCAO")
		default:
			return errors.New("BATEPAPO_PIN_PEPPER é obrigatório fora do ambiente de desenvolvimento (ou use BATEPAPO_PIN_KEY_PROVIDER=openbao)")
		}
	case "openbao":
		c.OpenBao = OpenBaoConfig{
			Addr:      os.Getenv("BATEPAPO_OPENBAO_ADDR"),
			Token:     os.Getenv("BATEPAPO_OPENBAO_TOKEN"),
			TokenFile: os.Getenv("BATEPAPO_OPENBAO_TOKEN_FILE"),
			Mount:     env("BATEPAPO_OPENBAO_MOUNT", "transit"),
			Key:       env("BATEPAPO_OPENBAO_KEY", "batepapo-pin"),
		}
		if c.OpenBao.Addr == "" || (c.OpenBao.Token == "" && c.OpenBao.TokenFile == "") {
			return errors.New("com BATEPAPO_PIN_KEY_PROVIDER=openbao, defina BATEPAPO_OPENBAO_ADDR e BATEPAPO_OPENBAO_TOKEN (ou _TOKEN_FILE)")
		}
		u, err := url.Parse(c.OpenBao.Addr)
		if err != nil || u.Host == "" {
			return fmt.Errorf("BATEPAPO_OPENBAO_ADDR inválido: %q", c.OpenBao.Addr)
		}
		if c.Env != "development" && u.Scheme != "https" && !isLoopback(u.Hostname()) {
			return errors.New("BATEPAPO_OPENBAO_ADDR precisa usar https fora do ambiente de desenvolvimento")
		}
	default:
		return fmt.Errorf("BATEPAPO_PIN_KEY_PROVIDER desconhecido: %q (use local ou openbao)", c.PinKeyProvider)
	}
	return nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
