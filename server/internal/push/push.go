// Package push acorda o aplicativo quando chega algo e ele está fechado.
//
// As notificações nunca levam conteúdo: nem texto, nem remetente, nem grupo.
// Só "você tem novas mensagens" ou "alerta de segurança na sua conta". O app
// abre, conecta e busca o que estiver pendente, já cifrado de ponta a ponta.
// Assim Google e Apple (ou o distribuidor UnifiedPush) ficam sabendo apenas
// que algo chegou, e quando.
package push

import (
	"context"
	"errors"
)

// Event diz por que o app está sendo acordado.
type Event string

const (
	// Message: há mensagens novas para buscar.
	Message Event = "message"
	// Alert: alerta de segurança da conta (ex.: tentativa de registro do seu
	// número em outro aparelho, típica de SIM swap).
	Alert Event = "alert"
)

// Tipos de token aceitos.
const (
	KindFCM         = "fcm"         // Firebase Cloud Messaging (Android)
	KindAPNs        = "apns"        // Apple Push Notification service (iOS)
	KindUnifiedPush = "unifiedpush" // distribuidor escolhido pela pessoa, sem Google/Apple
)

// AndroidChannel é o canal de notificação que o app cria no Android.
const AndroidChannel = "mensagens"

// Textos fixos: nada da mensagem em si.
const title = "Bate-Papo"

func body(ev Event) string {
	if ev == Alert {
		return "Alerta de segurança na sua conta. Abra o app."
	}
	return "Você tem novas mensagens"
}

// ErrInvalidToken: o serviço de push não reconhece mais o token (app
// desinstalado, token trocado). O token deve ser apagado.
var ErrInvalidToken = errors.New("token de push inválido ou expirado")

// Sender envia uma notificação a um aparelho.
type Sender interface {
	// Validate confere o formato do token antes de guardá-lo.
	Validate(token string) error
	Send(ctx context.Context, token string, ev Event) error
}

// Dispatcher reúne os serviços configurados neste servidor.
type Dispatcher struct {
	senders map[string]Sender
}

func NewDispatcher() *Dispatcher {
	return &Dispatcher{senders: map[string]Sender{}}
}

// Add registra o serviço de um tipo de token.
func (d *Dispatcher) Add(kind string, s Sender) {
	d.senders[kind] = s
}

// Kinds lista os tipos disponíveis.
func (d *Dispatcher) Kinds() []string {
	out := []string{}
	for _, k := range []string{KindFCM, KindAPNs, KindUnifiedPush} {
		if _, ok := d.senders[k]; ok {
			out = append(out, k)
		}
	}
	return out
}

// Sender devolve o serviço do tipo, ou nil se não estiver configurado.
func (d *Dispatcher) Sender(kind string) Sender {
	if d == nil {
		return nil
	}
	return d.senders[kind]
}
