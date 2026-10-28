package push

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

// APNsConfig: chave de autenticação (.p8) criada no portal de desenvolvedor
// da Apple.
type APNsConfig struct {
	KeyFile string
	KeyID   string
	TeamID  string
	// Topic é o bundle id do app (ex.: br.org.batepapo).
	Topic string
	// Sandbox usa o ambiente de desenvolvimento da Apple.
	Sandbox bool
}

// APNs envia pelo Apple Push Notification service, com autenticação por
// token (JWT ES256).
type APNs struct {
	cfg APNsConfig
	key *ecdsa.PrivateKey
	// BaseURL troca o endereço da API (testes).
	BaseURL string
	Client  *http.Client

	mu        sync.Mutex
	jwt       string
	jwtIssued time.Time
}

func NewAPNs(cfg APNsConfig) (*APNs, error) {
	if cfg.KeyID == "" || cfg.TeamID == "" || cfg.Topic == "" {
		return nil, errors.New("APNs precisa de key id, team id e topic (bundle id)")
	}
	pemBytes, err := os.ReadFile(cfg.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("lendo a chave do APNs: %w", err)
	}
	return newAPNs(cfg, pemBytes)
}

func newAPNs(cfg APNsConfig, pemBytes []byte) (*APNs, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("chave do APNs inválida")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("chave do APNs inválida: %w", err)
	}
	ec, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("a chave do APNs deve ser ECDSA (P-256)")
	}
	base := "https://api.push.apple.com"
	if cfg.Sandbox {
		base = "https://api.sandbox.push.apple.com"
	}
	return &APNs{cfg: cfg, key: ec, BaseURL: base}, nil
}

func (a *APNs) Validate(token string) error {
	// Tokens da Apple são hexadecimais (hoje 32 bytes; o tamanho pode crescer).
	if b, err := hex.DecodeString(token); err != nil || len(b) < 16 || len(b) > 256 {
		return errors.New("token APNs inválido")
	}
	return nil
}

func (a *APNs) Send(ctx context.Context, token string, ev Event) error {
	if err := a.Validate(token); err != nil {
		return ErrInvalidToken
	}
	auth, err := a.token()
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{
		"aps": map[string]any{
			"alert": map[string]string{"title": title, "body": body(ev)},
			"sound": "default",
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.BaseURL+"/3/device/"+token, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "bearer "+auth)
	req.Header.Set("apns-topic", a.cfg.Topic)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")
	// Notificações iguais se substituem em vez de acumular.
	req.Header.Set("apns-collapse-id", string(ev))
	client := a.Client
	if client == nil {
		// net/http usa HTTP/2 automaticamente com TLS, como a Apple exige.
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	var reason struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&reason)
	if resp.StatusCode == http.StatusGone || reason.Reason == "BadDeviceToken" || reason.Reason == "Unregistered" {
		return ErrInvalidToken
	}
	return fmt.Errorf("APNs respondeu %s (%s)", resp.Status, reason.Reason)
}

// token devolve o JWT de autenticação, renovado a cada 50 minutos (a Apple
// recusa tokens com mais de uma hora e também renovações frequentes demais).
func (a *APNs) token() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.jwt != "" && time.Since(a.jwtIssued) < 50*time.Minute {
		return a.jwt, nil
	}
	now := time.Now()
	input := jwtSigningInput(
		map[string]any{"alg": "ES256", "kid": a.cfg.KeyID},
		map[string]any{"iss": a.cfg.TeamID, "iat": now.Unix()},
	)
	digest := sha256.Sum256([]byte(input))
	r, s, err := ecdsa.Sign(rand.Reader, a.key, digest[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	a.jwt = input + "." + b64url(sig)
	a.jwtIssued = now
	return a.jwt, nil
}
