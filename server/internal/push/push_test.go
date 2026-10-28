package push

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func decodeJWT(t *testing.T, jwt string) (header, claims map[string]any, input string, sig []byte) {
	t.Helper()
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT malformado: %q", jwt)
	}
	for i, dst := range []*map[string]any{&header, &claims} {
		b, err := base64.RawURLEncoding.DecodeString(parts[i])
		if err != nil || json.Unmarshal(b, dst) != nil {
			t.Fatalf("parte %d do JWT inválida", i)
		}
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	return header, claims, parts[0] + "." + parts[1], sig
}

func TestFCM(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	var tokenRequests, sends int
	var lastBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			tokenRequests++
			_ = r.ParseForm()
			_, claims, input, sig := decodeJWT(t, r.Form.Get("assertion"))
			digest := sha256.Sum256([]byte(input))
			if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], sig); err != nil {
				t.Errorf("assinatura do JWT inválida: %v", err)
			}
			if claims["iss"] != "push@proj.iam.gserviceaccount.com" || claims["scope"] != fcmScope {
				t.Errorf("claims inesperadas: %v", claims)
			}
			_, _ = io.WriteString(w, `{"access_token":"acesso-1","expires_in":3600}`)
		case "/v1/projects/proj/messages:send":
			sends++
			if r.Header.Get("Authorization") != "Bearer acesso-1" {
				t.Errorf("autorização: %q", r.Header.Get("Authorization"))
			}
			lastBody = map[string]any{}
			_ = json.NewDecoder(r.Body).Decode(&lastBody)
			token := lastBody["message"].(map[string]any)["token"]
			if token == "desinstalado" {
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`)
				return
			}
			_, _ = io.WriteString(w, `{"name":"x"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	creds, _ := json.Marshal(map[string]string{
		"project_id":   "proj",
		"client_email": "push@proj.iam.gserviceaccount.com",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"token_uri":    srv.URL + "/token",
	})
	f, err := NewFCM(creds)
	if err != nil {
		t.Fatal(err)
	}
	f.BaseURL = srv.URL
	ctx := context.Background()
	if err := f.Send(ctx, "tok-a", Message); err != nil {
		t.Fatal(err)
	}
	if err := f.Send(ctx, "tok-b", Alert); err != nil {
		t.Fatal(err)
	}
	if tokenRequests != 1 || sends != 2 {
		t.Fatalf("token pedido %d vezes, %d envios", tokenRequests, sends)
	}
	// Só texto fixo, nada da mensagem.
	n := lastBody["message"].(map[string]any)["notification"].(map[string]any)
	if n["title"] != "Bate-Papo" || !strings.Contains(n["body"].(string), "segurança") {
		t.Fatalf("notificação inesperada: %v", n)
	}
	if err := f.Send(ctx, "desinstalado", Message); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("token desinstalado: %v", err)
	}
	if _, err := NewFCM([]byte(`{"project_id":"x"}`)); err == nil {
		t.Fatal("credenciais incompletas aceitas")
	}
}

func TestAPNs(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	const device = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header, claims, input, sig := decodeJWT(t, strings.TrimPrefix(r.Header.Get("Authorization"), "bearer "))
		digest := sha256.Sum256([]byte(input))
		if len(sig) != 64 || !ecdsa.Verify(&key.PublicKey, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
			t.Error("assinatura ES256 inválida")
		}
		if header["kid"] != "KEY123" || claims["iss"] != "TEAM456" {
			t.Errorf("JWT inesperado: %v %v", header, claims)
		}
		if r.Header.Get("apns-topic") != "br.org.batepapo" || r.Header.Get("apns-push-type") != "alert" ||
			r.Header.Get("apns-collapse-id") != "message" {
			t.Errorf("cabeçalhos: %v", r.Header)
		}
		if r.URL.Path != "/3/device/"+device {
			w.WriteHeader(http.StatusGone)
			_, _ = io.WriteString(w, `{"reason":"Unregistered"}`)
			return
		}
		var p map[string]any
		_ = json.NewDecoder(r.Body).Decode(&p)
		alert := p["aps"].(map[string]any)["alert"].(map[string]any)
		if alert["body"] != "Você tem novas mensagens" {
			t.Errorf("alerta: %v", alert)
		}
	}))
	defer srv.Close()

	a, err := newAPNs(APNsConfig{KeyID: "KEY123", TeamID: "TEAM456", Topic: "br.org.batepapo"},
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	if err != nil {
		t.Fatal(err)
	}
	a.BaseURL = srv.URL
	if err := a.Send(context.Background(), device, Message); err != nil {
		t.Fatal(err)
	}
	if err := a.Send(context.Background(), strings.Repeat("ff", 32), Message); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("token removido: %v", err)
	}
	if a.Validate("não-hex") == nil {
		t.Fatal("token inválido aceito")
	}
}

func TestUnifiedPush(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sumiu" {
			w.WriteHeader(http.StatusGone)
			return
		}
		b, _ := io.ReadAll(r.Body)
		got = string(b) + " " + r.Header.Get("Topic")
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	// Em produção, endereços internos e http são recusados (SSRF).
	strict := NewUnifiedPush(false)
	for _, bad := range []string{
		srv.URL + "/up", "https://127.0.0.1/up", "https://localhost/up", "https://10.0.0.5/up",
		"https://169.254.169.254/latest", "https://[::1]/up", "ftp://exemplo.com.br/x", "https://user:pw@exemplo.com.br/up",
	} {
		if strict.Validate(bad) == nil {
			t.Errorf("endereço aceito: %s", bad)
		}
	}
	if err := strict.Validate("https://ntfy.exemplo.com.br/upAbc123?up=1"); err != nil {
		t.Fatal(err)
	}

	dev := NewUnifiedPush(true)
	if err := dev.Send(context.Background(), srv.URL+"/up", Alert); err != nil {
		t.Fatal(err)
	}
	if got != `{"t":"alert"} alert` {
		t.Fatalf("corpo: %q", got)
	}
	if err := dev.Send(context.Background(), srv.URL+"/sumiu", Message); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("endereço removido: %v", err)
	}
}

func TestPublicIPDial(t *testing.T) {
	u := NewUnifiedPush(false)
	// Conexão direta a um IP interno é recusada pelo próprio discador, mesmo
	// que a validação fosse contornada.
	req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:9/x", nil)
	if _, err := u.client.Do(req); err == nil || !strings.Contains(err.Error(), "não permitido") {
		t.Fatalf("discagem interna: %v", err)
	}
}
