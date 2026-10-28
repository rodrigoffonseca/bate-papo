package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rodrigoffonseca/bate-papo/server/internal/config"
)

// Teste fechado: sem provedor de SMS, só números de teste (com código fixo)
// conseguem se cadastrar.
func TestClosedSignupWithTestPhones(t *testing.T) {
	const testPhone, code = "+5511988880001", "482915"
	ts, _ := newTestEnvWith(t, randomLocalKeyer(t),
		func(s *Server) { s.sms = nil },
		func(c *config.Config) {
			c.DevExposeOTP = false
			c.TestPhones = map[string]string{testPhone: code}
		})
	anon := &client{t: t, base: ts.URL}

	out := anon.must(403, "POST", "/v1/auth/request-code", map[string]string{"phone": "+5511988880002"})
	if out["code"] != "signup_closed" {
		t.Fatalf("número comum: %v", out)
	}
	out = anon.must(202, "POST", "/v1/auth/request-code", map[string]string{"phone": "(11) 98888-0001"})
	if _, exposed := out["dev_code"]; exposed {
		t.Fatal("código não deveria vir na resposta")
	}
	anon.must(401, "POST", "/v1/auth/verify", map[string]string{"phone": testPhone, "code": "111111"})
	anon.must(200, "POST", "/v1/auth/verify", map[string]string{"phone": testPhone, "code": code})
}

func TestClientIPBehindProxy(t *testing.T) {
	s := &Server{cfg: &config.Config{TrustProxyHeaders: true}}
	req := func(xff ...string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = "10.0.0.9:5555"
		for _, v := range xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		return r
	}
	// O cliente inventa "1.1.1.1"; o proxy acrescenta o IP real no fim.
	if ip := s.clientIP(req("1.1.1.1, 203.0.113.7")); ip != "203.0.113.7" {
		t.Fatalf("IP com cabeçalho forjado: %s", ip)
	}
	if ip := s.clientIP(req("1.1.1.1", "203.0.113.8")); ip != "203.0.113.8" {
		t.Fatalf("cabeçalhos repetidos: %s", ip)
	}
	if ip := s.clientIP(req()); ip != "10.0.0.9" {
		t.Fatalf("sem cabeçalho: %s", ip)
	}
	s.cfg.TrustProxyHeaders = false
	if ip := s.clientIP(req("203.0.113.7")); ip != "10.0.0.9" {
		t.Fatalf("sem confiar no proxy: %s", ip)
	}
}
