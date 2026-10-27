// Package pepper aplica a chave secreta do PIN ("pepper") sem que ela fique
// no banco de dados. O servidor guarda HMAC(chave, Argon2id(PIN)): um banco
// vazado não serve para testar PINs sem acesso também à chave.
package pepper

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
)

// ErrUnavailable indica que o serviço de chaves não respondeu. Quem chama
// deve falhar fechado (recusar a operação), nunca tratar como PIN errado.
var ErrUnavailable = errors.New("serviço de chaves indisponível")

// Keyer calcula e confere o HMAC com a chave secreta do PIN.
type Keyer interface {
	// ID identifica a chave (provedor e nome/impressão digital). É gravado
	// junto de cada hash para detectar configuração trocada.
	ID() string
	MAC(ctx context.Context, data []byte) ([]byte, error)
	Verify(ctx context.Context, data, mac []byte) (bool, error)
}

// Local guarda a chave na memória do processo (vinda de variável de ambiente
// ou arquivo), separada do banco de dados.
type Local struct {
	key []byte
	id  string
}

func NewLocal(key []byte) (*Local, error) {
	if len(key) < 32 {
		return nil, errors.New("a chave do PIN precisa de pelo menos 32 bytes")
	}
	fp := sha256.Sum256(append([]byte("batepapo-pin-pepper-id:"), key...))
	return &Local{key: key, id: "local:" + hex.EncodeToString(fp[:8])}, nil
}

func (l *Local) ID() string { return l.id }

func (l *Local) MAC(_ context.Context, data []byte) ([]byte, error) {
	m := hmac.New(sha256.New, l.key)
	m.Write(data)
	return m.Sum(nil), nil
}

func (l *Local) Verify(ctx context.Context, data, mac []byte) (bool, error) {
	want, _ := l.MAC(ctx, data)
	return hmac.Equal(want, mac), nil
}
