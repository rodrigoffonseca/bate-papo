// Package transittest imita o motor Transit do OpenBao/Vault (HMAC e
// verificação, com versões de chave) para testes, seguindo a API documentada:
// POST /v1/<mount>/hmac/<key>/sha2-256 e /v1/<mount>/verify/<key>/sha2-256.
package transittest

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
)

type Server struct {
	*httptest.Server
	Token string

	mu       sync.Mutex
	versions [][]byte // versions[i] é a chave da versão i+1
	calls    int
	down     bool
}

// New sobe o servidor com uma chave "batepapo-pin" no mount "transit".
func New(token string) *Server {
	s := &Server{Token: token}
	s.Rotate()
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	return s
}

// Rotate cria uma nova versão da chave (as antigas continuam verificando).
func (s *Server) Rotate() {
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	s.mu.Lock()
	s.versions = append(s.versions, k)
	s.mu.Unlock()
}

// SetDown simula o serviço fora do ar (responde 503).
func (s *Server) SetDown(down bool) {
	s.mu.Lock()
	s.down = down
	s.mu.Unlock()
}

func (s *Server) Calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func mac(key, input []byte) string {
	m := hmac.New(sha256.New, key)
	m.Write(input)
	return base64.StdEncoding.EncodeToString(m.Sum(nil))
}

func fail(w http.ResponseWriter, status int, msg string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"errors": []string{msg}})
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.down {
		fail(w, http.StatusServiceUnavailable, "Vault is sealed")
		return
	}
	if r.Header.Get("X-Vault-Token") != s.Token {
		fail(w, http.StatusForbidden, "permission denied")
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/"), "/")
	if r.Method != http.MethodPost || len(parts) != 4 || parts[0] != "transit" || parts[2] != "batepapo-pin" || parts[3] != "sha2-256" {
		fail(w, http.StatusNotFound, "no handler for route")
		return
	}
	var req struct {
		Input string `json:"input"`
		HMAC  string `json:"hmac"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "invalid request")
		return
	}
	input, err := base64.StdEncoding.DecodeString(req.Input)
	if err != nil {
		fail(w, http.StatusBadRequest, "unable to decode input as base64")
		return
	}
	switch parts[1] {
	case "hmac":
		v := len(s.versions)
		out := fmt.Sprintf("vault:v%d:%s", v, mac(s.versions[v-1], input))
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"hmac": out}})
	case "verify":
		f := strings.SplitN(req.HMAC, ":", 3)
		if len(f) != 3 || f[0] != "vault" || !strings.HasPrefix(f[1], "v") {
			fail(w, http.StatusBadRequest, "invalid hmac format")
			return
		}
		v, err := strconv.Atoi(f[1][1:])
		if err != nil || v < 1 || v > len(s.versions) {
			fail(w, http.StatusBadRequest, "invalid key version")
			return
		}
		valid := hmac.Equal([]byte(f[2]), []byte(mac(s.versions[v-1], input)))
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"valid": valid}})
	default:
		fail(w, http.StatusNotFound, "no handler for route")
	}
}
