package pepper

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Transit usa o motor "transit" do OpenBao (ou HashiCorp Vault): o HMAC é
// calculado dentro do serviço e a chave nunca sai de lá. O serviço registra
// cada uso, permite limitar a taxa de chamadas, rotacionar a chave (versões)
// e, conforme a instalação, guardar a chave em HSM.
type Transit struct {
	addr      string // ex.: https://bao.exemplo.br:8200
	mount     string // ex.: transit
	key       string // ex.: batepapo-pin
	token     string
	tokenFile string
	client    *http.Client
}

type TransitConfig struct {
	Addr      string
	Mount     string
	Key       string
	Token     string
	TokenFile string // relido a cada chamada: permite renovação por um agente
	Client    *http.Client
}

func NewTransit(c TransitConfig) (*Transit, error) {
	if c.Addr == "" || c.Key == "" {
		return nil, errors.New("endereço e nome da chave do OpenBao são obrigatórios")
	}
	if c.Token == "" && c.TokenFile == "" {
		return nil, errors.New("informe o token do OpenBao (ou o arquivo do token)")
	}
	if c.Mount == "" {
		c.Mount = "transit"
	}
	if c.Client == nil {
		c.Client = &http.Client{Timeout: 5 * time.Second}
	}
	return &Transit{
		addr: strings.TrimRight(c.Addr, "/"), mount: c.Mount, key: c.Key,
		token: c.Token, tokenFile: c.TokenFile, client: c.Client,
	}, nil
}

func (t *Transit) ID() string { return "transit:" + t.mount + "/" + t.key }

func (t *Transit) currentToken() (string, error) {
	if t.tokenFile == "" {
		return t.token, nil
	}
	b, err := os.ReadFile(t.tokenFile)
	if err != nil {
		return "", fmt.Errorf("%w: lendo o token: %v", ErrUnavailable, err)
	}
	return strings.TrimSpace(string(b)), nil
}

func (t *Transit) call(ctx context.Context, op string, body map[string]any, out any) error {
	token, err := t.currentToken()
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(body)
	u := fmt.Sprintf("%s/v1/%s/%s/%s/sha2-256", t.addr, url.PathEscape(t.mount), op, url.PathEscape(t.key))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Vault-Token", token)
	resp, err := t.client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		// Não repassa o corpo: pode conter detalhes da instalação.
		return fmt.Errorf("%w: OpenBao respondeu %s em %s", ErrUnavailable, resp.Status, op)
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return fmt.Errorf("%w: resposta inválida do OpenBao", ErrUnavailable)
	}
	return json.Unmarshal(env.Data, out)
}

// MAC devolve o HMAC no formato do OpenBao ("vault:vN:..."), que inclui a
// versão da chave usada.
func (t *Transit) MAC(ctx context.Context, data []byte) ([]byte, error) {
	var out struct {
		HMAC string `json:"hmac"`
	}
	err := t.call(ctx, "hmac", map[string]any{"input": base64.StdEncoding.EncodeToString(data)}, &out)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(out.HMAC, "vault:v") {
		return nil, fmt.Errorf("%w: HMAC em formato inesperado", ErrUnavailable)
	}
	return []byte(out.HMAC), nil
}

// Verify confere no próprio OpenBao, que sabe lidar com versões antigas da
// chave após uma rotação.
func (t *Transit) Verify(ctx context.Context, data, mac []byte) (bool, error) {
	var out struct {
		Valid bool `json:"valid"`
	}
	err := t.call(ctx, "verify", map[string]any{
		"input": base64.StdEncoding.EncodeToString(data),
		"hmac":  string(mac),
	}, &out)
	return out.Valid, err
}
