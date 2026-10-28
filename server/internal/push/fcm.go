package push

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const fcmScope = "https://www.googleapis.com/auth/firebase.messaging"

// FCM envia pelo Firebase Cloud Messaging (API HTTP v1), autenticando com a
// conta de serviço do projeto (o JSON baixado do console do Firebase).
type FCM struct {
	projectID   string
	clientEmail string
	tokenURI    string
	key         *rsa.PrivateKey
	// BaseURL troca o endereço da API (testes).
	BaseURL string
	Client  *http.Client

	mu          sync.Mutex
	accessToken string
	expiresAt   time.Time
}

// NewFCMFromFile lê o JSON da conta de serviço.
func NewFCMFromFile(path string) (*FCM, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("lendo credenciais do FCM: %w", err)
	}
	return NewFCM(b)
}

func NewFCM(credentialsJSON []byte) (*FCM, error) {
	var c struct {
		ProjectID   string `json:"project_id"`
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
		TokenURI    string `json:"token_uri"`
	}
	if err := json.Unmarshal(credentialsJSON, &c); err != nil {
		return nil, fmt.Errorf("credenciais do FCM inválidas: %w", err)
	}
	if c.ProjectID == "" || c.ClientEmail == "" || c.PrivateKey == "" {
		return nil, errors.New("credenciais do FCM incompletas (project_id, client_email, private_key)")
	}
	block, _ := pem.Decode([]byte(c.PrivateKey))
	if block == nil {
		return nil, errors.New("chave privada do FCM inválida")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("chave privada do FCM inválida: %w", err)
	}
	rsaKey, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("a chave privada do FCM deve ser RSA")
	}
	if c.TokenURI == "" {
		c.TokenURI = "https://oauth2.googleapis.com/token"
	}
	return &FCM{
		projectID:   c.ProjectID,
		clientEmail: c.ClientEmail,
		tokenURI:    c.TokenURI,
		key:         rsaKey,
		BaseURL:     "https://fcm.googleapis.com",
	}, nil
}

func (f *FCM) client() *http.Client {
	if f.Client != nil {
		return f.Client
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (f *FCM) Validate(token string) error {
	if token == "" || len(token) > 4096 || strings.ContainsAny(token, " \t\r\n") {
		return errors.New("token FCM inválido")
	}
	return nil
}

func (f *FCM) Send(ctx context.Context, token string, ev Event) error {
	access, err := f.oauthToken(ctx)
	if err != nil {
		return err
	}
	msg := map[string]any{
		"message": map[string]any{
			"token":        token,
			"notification": map[string]string{"title": title, "body": body(ev)},
			"android": map[string]any{
				"priority": "high",
				// Notificações iguais se substituem em vez de acumular.
				"collapse_key": string(ev),
				// Canal criado pelo app ("Mensagens"), com prioridade alta.
				"notification": map[string]string{"tag": string(ev), "channel_id": AndroidChannel},
			},
		},
	}
	b, _ := json.Marshal(msg)
	u := fmt.Sprintf("%s/v1/projects/%s/messages:send", f.BaseURL, url.PathEscape(f.projectID))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+access)
	resp, err := f.client().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode == http.StatusUnauthorized {
		f.mu.Lock()
		f.accessToken = "" // força renovar na próxima
		f.mu.Unlock()
	}
	if resp.StatusCode == http.StatusNotFound || bytes.Contains(detail, []byte("UNREGISTERED")) {
		return ErrInvalidToken
	}
	return fmt.Errorf("FCM respondeu %s", resp.Status)
}

// oauthToken troca um JWT assinado com a chave da conta de serviço por um
// token de acesso (válido por uma hora), reaproveitado até perto de vencer.
func (f *FCM) oauthToken(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.accessToken != "" && time.Until(f.expiresAt) > time.Minute {
		return f.accessToken, nil
	}
	now := time.Now()
	assertion, err := signRS256(f.key, map[string]any{
		"iss":   f.clientEmail,
		"scope": fcmScope,
		"aud":   f.tokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	})
	if err != nil {
		return "", err
	}
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assertion},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.tokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := f.client().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("autenticação do FCM respondeu %s", resp.Status)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&out); err != nil || out.AccessToken == "" {
		return "", errors.New("resposta de autenticação do FCM inválida")
	}
	f.accessToken = out.AccessToken
	f.expiresAt = now.Add(time.Duration(out.ExpiresIn) * time.Second)
	return f.accessToken, nil
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func jwtSigningInput(header, claims map[string]any) string {
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	return b64url(h) + "." + b64url(c)
}

func signRS256(key *rsa.PrivateKey, claims map[string]any) (string, error) {
	input := jwtSigningInput(map[string]any{"alg": "RS256", "typ": "JWT"}, claims)
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return input + "." + b64url(sig), nil
}
