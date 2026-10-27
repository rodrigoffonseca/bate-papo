package pepper_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rodrigoffonseca/bate-papo/server/internal/pepper"
	"github.com/rodrigoffonseca/bate-papo/server/internal/pepper/transittest"
)

var ctx = context.Background()

func TestLocal(t *testing.T) {
	if _, err := pepper.NewLocal([]byte("curta")); err == nil {
		t.Fatal("chave curta deveria ser recusada")
	}
	a, _ := pepper.NewLocal([]byte(strings.Repeat("a", 32)))
	a2, _ := pepper.NewLocal([]byte(strings.Repeat("a", 32)))
	b, _ := pepper.NewLocal([]byte(strings.Repeat("b", 32)))
	if a.ID() != a2.ID() || a.ID() == b.ID() || !strings.HasPrefix(a.ID(), "local:") {
		t.Fatalf("IDs inesperados: %s %s %s", a.ID(), a2.ID(), b.ID())
	}
	if strings.Contains(a.ID(), "aaaa") {
		t.Fatal("o ID não pode revelar a chave")
	}
	m, _ := a.MAC(ctx, []byte("pin derivado"))
	if ok, _ := a.Verify(ctx, []byte("pin derivado"), m); !ok {
		t.Fatal("deveria conferir")
	}
	if ok, _ := b.Verify(ctx, []byte("pin derivado"), m); ok {
		t.Fatal("outra chave não pode conferir")
	}
}

func newTransit(t *testing.T, s *transittest.Server, token, tokenFile string) *pepper.Transit {
	t.Helper()
	tr, err := pepper.NewTransit(pepper.TransitConfig{Addr: s.URL, Key: "batepapo-pin", Token: token, TokenFile: tokenFile})
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func TestTransitWithRotation(t *testing.T) {
	s := transittest.New("token-certo")
	defer s.Close()
	tr := newTransit(t, s, "token-certo", "")
	if tr.ID() != "transit:transit/batepapo-pin" {
		t.Fatalf("ID = %s", tr.ID())
	}

	old, err := tr.MAC(ctx, []byte("pin derivado"))
	if err != nil || !strings.HasPrefix(string(old), "vault:v1:") {
		t.Fatalf("MAC = %q, %v", old, err)
	}
	if ok, err := tr.Verify(ctx, []byte("pin derivado"), old); !ok || err != nil {
		t.Fatalf("Verify = %v, %v", ok, err)
	}
	if ok, _ := tr.Verify(ctx, []byte("outro"), old); ok {
		t.Fatal("entrada diferente não pode conferir")
	}

	// Rotação: novos hashes usam v2 e os antigos continuam valendo.
	s.Rotate()
	cur, _ := tr.MAC(ctx, []byte("pin derivado"))
	if !strings.HasPrefix(string(cur), "vault:v2:") {
		t.Fatalf("depois da rotação, MAC = %q", cur)
	}
	if ok, _ := tr.Verify(ctx, []byte("pin derivado"), old); !ok {
		t.Fatal("hash da versão anterior deveria continuar valendo")
	}
}

func TestTransitFailsClosed(t *testing.T) {
	s := transittest.New("token-certo")
	defer s.Close()

	_, err := newTransit(t, s, "token-errado", "").MAC(ctx, []byte("x"))
	if !errors.Is(err, pepper.ErrUnavailable) {
		t.Fatalf("token errado: %v", err)
	}
	tr := newTransit(t, s, "token-certo", "")
	s.SetDown(true)
	if _, err := tr.Verify(ctx, []byte("x"), []byte("vault:v1:abc")); !errors.Is(err, pepper.ErrUnavailable) {
		t.Fatalf("serviço fora do ar: %v", err)
	}
	s.SetDown(false)
	s.Close()
	if _, err := tr.MAC(ctx, []byte("x")); !errors.Is(err, pepper.ErrUnavailable) {
		t.Fatalf("serviço inacessível: %v", err)
	}
}

func TestTransitTokenFileIsReread(t *testing.T) {
	s := transittest.New("token-novo")
	defer s.Close()
	f := filepath.Join(t.TempDir(), "token")
	_ = os.WriteFile(f, []byte("token-velho\n"), 0o600)
	tr := newTransit(t, s, "", f)
	if _, err := tr.MAC(ctx, []byte("x")); !errors.Is(err, pepper.ErrUnavailable) {
		t.Fatal("token velho deveria falhar")
	}
	// Um agente renovou o token no arquivo: vale sem reiniciar o servidor.
	_ = os.WriteFile(f, []byte("token-novo\n"), 0o600)
	if _, err := tr.MAC(ctx, []byte("x")); err != nil {
		t.Fatalf("token renovado: %v", err)
	}
}
