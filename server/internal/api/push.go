package api

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/rodrigoffonseca/bate-papo/server/internal/push"
	"github.com/rodrigoffonseca/bate-papo/server/internal/store"
)

// Depois de acordar o aparelho por causa de mensagens, espera este tempo
// antes de acordá-lo de novo: o app, ao abrir, busca tudo o que chegou.
const pushInterval = 30 * time.Second

type pushState struct {
	d    *push.Dispatcher
	mu   sync.Mutex
	last map[uuid.UUID]time.Time
}

func newPushState(d *push.Dispatcher) *pushState {
	if d == nil {
		d = push.NewDispatcher()
	}
	return &pushState{d: d, last: map[uuid.UUID]time.Time{}}
}

// SetPush define os serviços de push (FCM, APNs, UnifiedPush) configurados.
func (s *Server) SetPush(d *push.Dispatcher) {
	s.pusher = newPushState(d)
}

// due diz se já pode acordar o aparelho de novo por causa de mensagens.
func (p *pushState) due(user uuid.UUID, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if now.Sub(p.last[user]) < pushInterval {
		return false
	}
	p.last[user] = now
	return true
}

// reset: o app abriu; a próxima mensagem com ele fechado acorda de novo.
func (p *pushState) reset(user uuid.UUID) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.last, user)
}

func (p *pushState) cleanup(now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for u, t := range p.last {
		if now.Sub(t) >= pushInterval {
			delete(p.last, u)
		}
	}
}

// wake acorda o aparelho do usuário se o app estiver fechado. A notificação
// não leva nada da mensagem (veja o pacote push). Roda em segundo plano para
// não atrasar quem enviou.
func (s *Server) wake(user uuid.UUID, ev push.Event) {
	p := s.pusher
	if len(p.d.Kinds()) == 0 || s.hub.Connected(user) {
		return
	}
	if ev == push.Message && !p.due(user, time.Now()) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		t, err := s.store.GetPushToken(ctx, user)
		if err != nil {
			if !errors.Is(err, store.ErrNotFound) {
				s.log.Error("buscando token de push", "err", err)
			}
			return
		}
		sender := p.d.Sender(t.Kind)
		if sender == nil {
			return
		}
		err = sender.Send(ctx, t.Token, ev)
		switch {
		case errors.Is(err, push.ErrInvalidToken):
			if err := s.store.DeletePushToken(ctx, user, t.Token); err != nil {
				s.log.Error("apagando token de push inválido", "err", err)
			}
		case err != nil:
			s.log.Warn("falha ao enviar push", "kind", t.Kind, "err", err)
		}
	}()
}

func (s *Server) handleGetPush(w http.ResponseWriter, r *http.Request) {
	var registered *string
	t, err := s.store.GetPushToken(r.Context(), currentUser(r).ID)
	switch {
	case err == nil:
		registered = &t.Kind
	case !errors.Is(err, store.ErrNotFound):
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": s.pusher.d.Kinds(), "registered": registered})
}

func (s *Server) handlePutPush(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind  string `json:"kind"`
		Token string `json:"token"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	sender := s.pusher.d.Sender(req.Kind)
	if sender == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "este servidor não envia notificações por " + req.Kind,
			"code":  "push_unavailable",
		})
		return
	}
	if err := sender.Validate(req.Token); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.store.SetPushToken(r.Context(), currentUser(r).ID, req.Kind, req.Token); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeletePush(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeletePushToken(r.Context(), currentUser(r).ID, ""); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
