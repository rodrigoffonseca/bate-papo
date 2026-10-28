package api

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"

	"github.com/rodrigoffonseca/bate-papo/server/internal/push"
	"github.com/rodrigoffonseca/bate-papo/server/internal/store"
)

type pushed struct {
	token string
	ev    push.Event
}

// fakeSender faz o papel do FCM: registra os envios e recusa o token "velho".
type fakeSender struct{ sent chan pushed }

func (f *fakeSender) Validate(token string) error {
	if token == "ruim" {
		return errors.New("token inválido")
	}
	return nil
}

func (f *fakeSender) Send(_ context.Context, token string, ev push.Event) error {
	f.sent <- pushed{token, ev}
	if token == "velho" {
		return push.ErrInvalidToken
	}
	return nil
}

func expectPush(t *testing.T, f *fakeSender, want pushed) {
	t.Helper()
	select {
	case got := <-f.sent:
		if got != want {
			t.Fatalf("push %v, quero %v", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("push %v não chegou", want)
	}
}

func expectNoPush(t *testing.T, f *fakeSender) {
	t.Helper()
	select {
	case got := <-f.sent:
		t.Fatalf("push inesperado: %v", got)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestPush(t *testing.T) {
	fake := &fakeSender{sent: make(chan pushed, 16)}
	d := push.NewDispatcher()
	d.Add(push.KindFCM, fake)
	ts, st := newTestEnvWith(t, randomLocalKeyer(t), func(s *Server) { s.SetPush(d) })
	alice, bob, carol := register(t, ts.URL), register(t, ts.URL), register(t, ts.URL)
	withKeys(alice, bob, carol)
	send := func(to *client) {
		alice.must(201, "POST", "/v1/messages", map[string]any{
			"messages": []map[string]any{{"to": to.id, "registration_id": 7, "ciphertext": []byte("cifrado")}},
		})
	}

	out := bob.must(200, "GET", "/v1/push", nil)
	if fmt.Sprint(out["available"]) != "[fcm]" || out["registered"] != nil {
		t.Fatalf("estado inicial: %v", out)
	}
	if out := bob.must(400, "PUT", "/v1/push", map[string]string{"kind": "apns", "token": "abc"}); out["code"] != "push_unavailable" {
		t.Fatalf("tipo indisponível: %v", out)
	}
	bob.must(400, "PUT", "/v1/push", map[string]string{"kind": "fcm", "token": "ruim"})
	bob.must(204, "PUT", "/v1/push", map[string]string{"kind": "fcm", "token": "tok-bob"})
	if out := bob.must(200, "GET", "/v1/push", nil); out["registered"] != "fcm" {
		t.Fatalf("registrado: %v", out)
	}

	// App fechado: acorda, sem nada da mensagem. A segunda logo em seguida não acorda de novo.
	send(bob)
	expectPush(t, fake, pushed{"tok-bob", push.Message})
	send(bob)
	expectNoPush(t, fake)

	// App aberto (WebSocket): não precisa acordar.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/v1/ws?token="+bob.token, nil)
	if err != nil {
		t.Fatal(err)
	}
	var msg map[string]any
	if err := wsjson.Read(ctx, conn, &msg); err != nil || msg["type"] != "ready" {
		t.Fatalf("esperava ready: %v %v", msg, err)
	}
	send(bob)
	expectNoPush(t, fake)
	conn.Close(websocket.StatusNormalClosure, "")

	// Fechou de novo: a próxima mensagem acorda (o intervalo recomeça ao abrir).
	deadline := time.Now().Add(5 * time.Second)
	for {
		send(bob)
		select {
		case got := <-fake.sent:
			if got != (pushed{"tok-bob", push.Message}) {
				t.Fatalf("push %v", got)
			}
		case <-time.After(200 * time.Millisecond):
			if time.Now().After(deadline) {
				t.Fatal("push não chegou depois de fechar o app")
			}
			continue
		}
		break
	}

	// Token recusado pelo serviço (app desinstalado) é apagado.
	carol.must(204, "PUT", "/v1/push", map[string]string{"kind": "fcm", "token": "velho"})
	send(carol)
	expectPush(t, fake, pushed{"velho", push.Message})
	for deadline := time.Now().Add(5 * time.Second); ; {
		if carol.must(200, "GET", "/v1/push", nil)["registered"] == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("token inválido não foi apagado")
		}
		time.Sleep(25 * time.Millisecond)
	}

	// Sair da conta apaga o token.
	bob.must(204, "POST", "/v1/auth/logout", nil)
	bobID := mustUUID(t, bob.id)
	if _, err := st.GetPushToken(context.Background(), bobID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("token depois de sair: %v", err)
	}
}

func TestPushTokenRemovedOnReRegistration(t *testing.T) {
	ts, st := newTestEnv(t, randomLocalKeyer(t))
	anon := &client{t: t, base: ts.URL}
	ph := fmt.Sprintf("+55319%08d", time.Now().UnixNano()%100_000_000)
	verify := func() *client {
		code := anon.must(202, "POST", "/v1/auth/request-code", map[string]string{"phone": ph})["dev_code"].(string)
		out := anon.must(200, "POST", "/v1/auth/verify", map[string]string{"phone": ph, "code": code})
		return &client{t: t, base: ts.URL, token: out["token"].(string), id: out["user"].(map[string]any)["id"].(string)}
	}
	old := verify()
	// UnifiedPush vem ligado por padrão; aqui só o banco importa.
	if err := st.SetPushToken(context.Background(), mustUUID(t, old.id), push.KindUnifiedPush, "https://up.exemplo.com.br/x"); err != nil {
		t.Fatal(err)
	}
	fresh := verify()
	if fresh.id != old.id {
		t.Fatal("deveria ser a mesma conta")
	}
	// O aparelho antigo (talvez um chip clonado do outro lado) não é mais acordado.
	if _, err := st.GetPushToken(context.Background(), mustUUID(t, old.id)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("token do aparelho antigo: %v", err)
	}
}

func mustUUID(t *testing.T, s string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
