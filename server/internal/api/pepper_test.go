package api

import (
	"context"
	"crypto/rand"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/rodrigoffonseca/bate-papo/server/internal/config"
	"github.com/rodrigoffonseca/bate-papo/server/internal/pepper"
	"github.com/rodrigoffonseca/bate-papo/server/internal/pepper/transittest"
	"github.com/rodrigoffonseca/bate-papo/server/internal/store"
)

func lockOf(t *testing.T, st *store.Store, id string) *store.RegistrationLock {
	t.Helper()
	l, err := st.GetRegistrationLock(context.Background(), uuid.MustParse(id))
	if err != nil {
		t.Fatal(err)
	}
	return l
}

// Um banco vazado não basta: o hash gravado depende da chave secreta, e um
// servidor com outra chave não consegue conferir o PIN.
func TestPinHashDependsOnSecretKey(t *testing.T) {
	keyer := randomLocalKeyer(t)
	samePhonePepper := func(c *config.Config) { c.PhonePepper = []byte("pepper-do-telefone-compartilhado") }
	ts, st := newTestEnv(t, keyer, samePhonePepper)
	owner := newAccount(t, ts.URL)
	owner.must(200, "PUT", "/v1/account/lock", map[string]any{"pin": "284917"})

	l := lockOf(t, st, owner.id)
	if l.PinScheme != "argon2id+"+keyer.ID() {
		t.Fatalf("esquema = %q", l.PinScheme)
	}
	if string(l.PinHash) == string(hashPin("284917", l.PinSalt)) {
		t.Fatal("o hash gravado não pode ser só o Argon2id do PIN")
	}

	// Mesmo banco, chave diferente (ex.: cópia do banco num servidor do
	// atacante, ou configuração trocada): o PIN certo não confere e isso é
	// erro do servidor, sem descontar tentativas do dono.
	other, _ := newTestEnv(t, randomLocalKeyer(t), samePhonePepper)
	owner.base = other.URL
	token := owner.attempt(423)["lock_token"].(string)
	unlock(t, other.URL, map[string]any{"lock_token": token, "pin": "284917"}, 500)
	if n := lockOf(t, st, owner.id).FailedAttempts; n != 0 {
		t.Fatalf("falha de configuração não pode contar como PIN errado (tentativas = %d)", n)
	}
}

// PINs criados antes da chave secreta (fase 1) são convertidos no primeiro acerto.
func TestLegacyPinIsUpgraded(t *testing.T) {
	keyer := randomLocalKeyer(t)
	ts, st := newTestEnv(t, keyer)
	owner := newAccount(t, ts.URL)
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	err := st.SetRegistrationLock(context.Background(), uuid.MustParse(owner.id),
		hashPin("antigo 2025", salt), salt, legacyPinScheme, recoveryHash("X"))
	if err != nil {
		t.Fatal(err)
	}

	token := owner.attempt(423)["lock_token"].(string)
	unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "errado 2025"}, 401)
	if lockOf(t, st, owner.id).PinScheme != legacyPinScheme {
		t.Fatal("PIN errado não pode converter o hash")
	}
	unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "antigo 2025"}, 200)
	l := lockOf(t, st, owner.id)
	if l.PinScheme != "argon2id+"+keyer.ID() || l.FailedAttempts != 0 {
		t.Fatalf("depois do acerto: esquema %q, tentativas %d", l.PinScheme, l.FailedAttempts)
	}

	// E o PIN continua valendo no novo formato.
	token = owner.attempt(423)["lock_token"].(string)
	unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "antigo 2025"}, 200)
}

func TestPinWithOpenBaoTransit(t *testing.T) {
	bao := transittest.New("token-do-servidor")
	t.Cleanup(bao.Close)
	keyer, err := pepper.NewTransit(pepper.TransitConfig{Addr: bao.URL, Key: "batepapo-pin", Token: "token-do-servidor"})
	if err != nil {
		t.Fatal(err)
	}
	ts, st := newTestEnv(t, keyer)
	owner := newAccount(t, ts.URL)
	owner.must(200, "PUT", "/v1/account/lock", map[string]any{"pin": "284917"})
	if l := lockOf(t, st, owner.id); !strings.HasPrefix(string(l.PinHash), "vault:v1:") ||
		l.PinScheme != "argon2id+transit:transit/batepapo-pin" {
		t.Fatalf("hash/esquema inesperados: %q %q", l.PinHash, l.PinScheme)
	}

	// Rotação da chave no OpenBao: o PIN gravado com a versão 1 continua valendo.
	bao.Rotate()
	token := owner.attempt(423)["lock_token"].(string)
	unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "000001"}, 401)
	ok := unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "284917"}, 200)
	fresh := &client{t: t, base: ts.URL, token: ok["token"].(string)}

	// OpenBao fora do ar: falha fechada (503), sem descontar tentativas.
	bao.SetDown(true)
	before := lockOf(t, st, owner.id).FailedAttempts
	token = (&account{client: fresh, phone: owner.phone}).attempt(423)["lock_token"].(string)
	out := unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "284917"}, 503)
	if out["code"] != "temporarily_unavailable" {
		t.Fatalf("resposta: %v", out)
	}
	unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "000002"}, 503)
	if after := lockOf(t, st, owner.id).FailedAttempts; after != before {
		t.Fatalf("indisponibilidade não pode contar como PIN errado (%d → %d)", before, after)
	}
	fresh.must(503, "PUT", "/v1/account/lock", map[string]any{"pin": "novo pin 99"})
	fresh.must(503, "POST", "/v1/account/lock/check", map[string]any{"pin": "284917"})

	bao.SetDown(false)
	unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "284917"}, 200)
}
