package api

import (
	"sync"

	"github.com/google/uuid"

	"github.com/rodrigoffonseca/bate-papo/server/internal/store"
)

// Hub mantém as conexões WebSocket ativas e entrega envelopes e alertas de
// segurança em tempo real.
// Funciona dentro de uma única instância; para escalar horizontalmente,
// substitua por Postgres LISTEN/NOTIFY ou outro barramento.
type Hub struct {
	mu    sync.Mutex
	conns map[uuid.UUID]map[*subscriber]struct{}
}

// wsMessage é uma mensagem do servidor para o cliente no WebSocket.
type wsMessage map[string]any

type subscriber struct {
	ch     chan wsMessage
	closed chan struct{}
	once   sync.Once
}

func (s *subscriber) close() { s.once.Do(func() { close(s.closed) }) }

func NewHub() *Hub {
	return &Hub{conns: map[uuid.UUID]map[*subscriber]struct{}{}}
}

func (h *Hub) Subscribe(user uuid.UUID) *subscriber {
	sub := &subscriber{ch: make(chan wsMessage, 256), closed: make(chan struct{})}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[user] == nil {
		h.conns[user] = map[*subscriber]struct{}{}
	}
	h.conns[user][sub] = struct{}{}
	return sub
}

func (h *Hub) Unsubscribe(user uuid.UUID, sub *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.conns[user], sub)
	if len(h.conns[user]) == 0 {
		delete(h.conns, user)
	}
	sub.close()
}

// Notify entrega o envelope às conexões do destinatário. Se uma conexão
// estiver lenta demais, ela é encerrada; o cliente reconecta e busca o que
// estiver pendente no banco.
func (h *Hub) Notify(user uuid.UUID, env *store.Envelope) {
	h.send(user, wsMessage{"type": "envelope", "envelope": env})
}

// NotifyAlert avisa as conexões do usuário sobre um alerta de segurança.
func (h *Hub) NotifyAlert(user uuid.UUID, alert *store.AccountAlert) {
	h.send(user, wsMessage{"type": "alert", "alert": alert})
}

func (h *Hub) send(user uuid.UUID, msg wsMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.conns[user] {
		select {
		case sub.ch <- msg:
		default:
			sub.close()
		}
	}
}

func (h *Hub) Disconnect(user uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.conns[user] {
		sub.close()
	}
}
