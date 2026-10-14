package api

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/rodrigoffonseca/bate-papo/server/internal/config"
)

// account é uma conta de teste com o telefone guardado para novos registros.
type account struct {
	*client
	phone string
}

func newAccount(t *testing.T, base string) *account {
	t.Helper()
	phoneSeq++
	ph := fmt.Sprintf("+55319%08d", phoneSeq%100_000_000)
	a := &account{client: &client{t: t, base: base}, phone: ph}
	code := a.must(202, "POST", "/v1/auth/request-code", map[string]string{"phone": ph})["dev_code"].(string)
	out := a.must(200, "POST", "/v1/auth/verify", map[string]string{"phone": ph, "code": code})
	a.token = out["token"].(string)
	a.id = out["user"].(map[string]any)["id"].(string)
	return a
}

// attempt simula outro aparelho (ex.: um atacante com o chip clonado)
// confirmando o código SMS do número.
func (a *account) attempt(wantStatus int) map[string]any {
	a.t.Helper()
	other := &client{t: a.t, base: a.base}
	code := other.must(202, "POST", "/v1/auth/request-code", map[string]string{"phone": a.phone})["dev_code"].(string)
	return other.must(wantStatus, "POST", "/v1/auth/verify", map[string]string{"phone": a.phone, "code": code})
}

func unlock(t *testing.T, base string, body map[string]any, want int) map[string]any {
	t.Helper()
	return (&client{t: t, base: base}).must(want, "POST", "/v1/auth/unlock", body)
}

func TestRegistrationLockStopsSimSwap(t *testing.T) {
	ts := newTestServer(t)
	owner := newAccount(t, ts.URL)

	owner.must(400, "PUT", "/v1/account/lock", map[string]any{"pin": "123456"})
	code := owner.must(200, "PUT", "/v1/account/lock", map[string]any{"pin": "284917"})["recovery_code"].(string)
	if len(code) != 29 {
		t.Fatalf("código de recuperação inesperado: %q", code)
	}
	if lock := owner.must(200, "GET", "/v1/account/lock", nil); lock["enabled"] != true {
		t.Fatalf("bloqueio deveria estar ativo: %v", lock)
	}

	// O dono está conectado e recebe o alerta em tempo real.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/v1/ws?token="+owner.token, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	var msg map[string]any
	_ = wsjson.Read(ctx, conn, &msg) // ready

	// Atacante com o chip: o SMS confere, mas a conta não é entregue.
	locked := owner.attempt(423)
	if locked["code"] != "registration_locked" || locked["attempts_left"] != float64(MaxPinFailures) {
		t.Fatalf("resposta inesperada: %v", locked)
	}
	if err := wsjson.Read(ctx, conn, &msg); err != nil || msg["type"] != "alert" ||
		msg["alert"].(map[string]any)["kind"] != "registration_attempt" {
		t.Fatalf("esperava alerta de tentativa de registro: %v %v", msg, err)
	}
	owner.must(200, "GET", "/v1/me", nil) // o dono continua logado

	token := locked["lock_token"].(string)
	wrong := unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "000001"}, 401)
	if wrong["attempts_left"] != float64(MaxPinFailures-1) {
		t.Fatalf("tentativas restantes: %v", wrong)
	}
	if err := wsjson.Read(ctx, conn, &msg); err != nil || msg["alert"].(map[string]any)["kind"] != "pin_failed" {
		t.Fatalf("esperava alerta de PIN errado: %v %v", msg, err)
	}
	unlock(t, ts.URL, map[string]any{"lock_token": "inventado", "pin": "284917"}, 401)
	unlock(t, ts.URL, map[string]any{"lock_token": token}, 400)

	alerts := owner.must(200, "GET", "/v1/account/alerts", nil)["alerts"].([]any)
	if len(alerts) != 2 {
		t.Fatalf("alertas = %d", len(alerts))
	}
	owner.must(204, "POST", "/v1/account/alerts/ack", map[string]any{"ids": []any{alerts[0].(map[string]any)["id"]}})
	if n := len(owner.must(200, "GET", "/v1/account/alerts", nil)["alerts"].([]any)); n != 1 {
		t.Fatalf("depois do ack, alertas = %d", n)
	}

	// Com o PIN certo (o dono trocando de celular), o registro é concluído.
	ok := unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "284917"}, 200)
	if ok["user"].(map[string]any)["id"] != owner.id {
		t.Fatal("deveria assumir a mesma conta")
	}
	owner.must(401, "GET", "/v1/me", nil)
	unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "284917"}, 401) // uso único
	fresh := &client{t: t, base: ts.URL, token: ok["token"].(string)}
	if fresh.must(200, "GET", "/v1/account/lock", nil)["enabled"] != true {
		t.Fatal("o PIN deve continuar valendo depois de trocar de aparelho")
	}
}

func TestRecoveryCodeAndPinBlocking(t *testing.T) {
	ts := newTestServer(t)
	owner := newAccount(t, ts.URL)
	code := owner.must(200, "PUT", "/v1/account/lock", map[string]any{"pin": "venha logo 42"})["recovery_code"].(string)

	// 10 PINs errados (5 por código SMS) bloqueiam o PIN.
	for range 2 {
		token := owner.attempt(423)["lock_token"].(string)
		for range unlockAttemptsPerChallenge {
			unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "chute 1234"}, 401)
		}
		unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "chute 1234"}, 429)
	}
	locked := owner.attempt(423)
	if locked["attempts_left"] != float64(0) {
		t.Fatalf("tentativas restantes: %v", locked)
	}
	token := locked["lock_token"].(string)
	blocked := unlock(t, ts.URL, map[string]any{"lock_token": token, "pin": "venha logo 42"}, 423)
	if blocked["code"] != "pin_blocked" {
		t.Fatalf("esperava PIN bloqueado: %v", blocked)
	}
	kinds := map[string]int{}
	for _, a := range owner.must(200, "GET", "/v1/account/alerts", nil)["alerts"].([]any) {
		kinds[a.(map[string]any)["kind"].(string)]++
	}
	if kinds["pin_blocked"] != 1 || kinds["pin_failed"] != 9 || kinds["registration_attempt"] != 3 {
		t.Fatalf("alertas inesperados: %v", kinds)
	}

	// O código de recuperação continua valendo, digitado de qualquer jeito.
	unlock(t, ts.URL, map[string]any{"lock_token": token, "recovery_code": "AAAA-BBBB"}, 401)
	typed := strings.ToLower(strings.ReplaceAll(code, "-", " "))
	ok := unlock(t, ts.URL, map[string]any{"lock_token": token, "recovery_code": typed}, 200)
	fresh := &client{t: t, base: ts.URL, token: ok["token"].(string)}
	// Uso único: o PIN é removido e o app pede um novo.
	if fresh.must(200, "GET", "/v1/account/lock", nil)["enabled"] != false {
		t.Fatal("o código de recuperação deveria remover o PIN antigo")
	}
}

func TestOwnerManagesPin(t *testing.T) {
	ts := newTestServer(t)
	owner := newAccount(t, ts.URL)
	owner.must(404, "POST", "/v1/account/lock/check", map[string]any{"pin": "284917"})
	owner.must(404, "POST", "/v1/account/recovery-code", nil)
	first := owner.must(200, "PUT", "/v1/account/lock", map[string]any{"pin": "284917"})["recovery_code"]

	if owner.must(200, "POST", "/v1/account/lock/check", map[string]any{"pin": "284917"})["ok"] != true ||
		owner.must(200, "POST", "/v1/account/lock/check", map[string]any{"pin": "284918"})["ok"] != false {
		t.Fatal("conferência do PIN incorreta")
	}
	second := owner.must(200, "POST", "/v1/account/recovery-code", nil)["recovery_code"]
	if first == second {
		t.Fatal("deveria gerar um novo código")
	}

	// O código antigo deixa de valer.
	token := owner.attempt(423)["lock_token"].(string)
	unlock(t, ts.URL, map[string]any{"lock_token": token, "recovery_code": first}, 401)

	owner.must(204, "DELETE", "/v1/account/lock", nil)
	owner.attempt(200) // sem PIN, o SMS volta a bastar
}

func TestLockExpiresWhenAccountIsInactive(t *testing.T) {
	ts := newTestServer(t, func(c *config.Config) { c.LockInactivity = time.Second })
	owner := newAccount(t, ts.URL)
	owner.must(200, "PUT", "/v1/account/lock", map[string]any{"pin": "284917"})
	owner.attempt(423)
	// Dono sumiu (perdeu o aparelho e o PIN): passado o prazo, o SMS basta.
	time.Sleep(1500 * time.Millisecond)
	out := owner.attempt(200)
	fresh := &client{t: t, base: ts.URL, token: out["token"].(string)}
	if fresh.must(200, "GET", "/v1/account/lock", nil)["enabled"] != false {
		t.Fatal("o novo aparelho deve definir um novo PIN")
	}
}

func TestIdleSessionsExpire(t *testing.T) {
	ts := newTestServer(t, func(c *config.Config) { c.SessionIdle = time.Second })
	a := newAccount(t, ts.URL)
	a.must(200, "GET", "/v1/me", nil)
	time.Sleep(1500 * time.Millisecond)
	a.must(401, "GET", "/v1/me", nil)
}
