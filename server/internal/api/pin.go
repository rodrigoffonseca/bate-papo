package api

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Parâmetros do Argon2id para o PIN (RFC 9106, perfil de memória reduzida).
// Cada verificação usa 64 MiB; o semáforo limita o uso simultâneo.
const (
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 2
	argonKeyLen  = 32

	// MaxPinFailures: depois disso, o PIN deixa de ser aceito num aparelho
	// novo até a conta ficar inativa (ou o dono redefinir o PIN). O código
	// de recuperação continua valendo.
	MaxPinFailures = 10
	// Tentativas de PIN por código SMS confirmado.
	unlockAttemptsPerChallenge = 5
)

var argonSlots = make(chan struct{}, 4)

func hashPin(pin string, salt []byte) []byte {
	argonSlots <- struct{}{}
	defer func() { <-argonSlots }()
	return argon2.IDKey([]byte(pin), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
}

func newPinHash(pin string) (hash, salt []byte, err error) {
	salt = make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, nil, err
	}
	return hashPin(pin, salt), salt, nil
}

func pinMatches(pin string, salt, hash []byte) bool {
	return subtle.ConstantTimeCompare(hashPin(pin, salt), hash) == 1
}

var errWeakPin = errors.New("o PIN deve ter ao menos 6 caracteres e não pode ser uma sequência ou repetição óbvia")

// validatePin aplica a política mínima: 6 a 64 caracteres, sem sequências ou
// repetições triviais (123456, 111111, 121212...).
func validatePin(pin string) error {
	r := []rune(pin)
	n := len(r)
	if n < 6 || n > 64 {
		return errWeakPin
	}
	asc, desc := true, true
	for i := 1; i < n; i++ {
		d := r[i] - r[i-1]
		asc = asc && d == 1
		desc = desc && d == -1
	}
	if asc || desc {
		return errWeakPin // 123456, 654321, abcdef...
	}
	// Um padrão curto repetido: 111111, 121212, 123123, 112112...
	for p := 1; p <= n/2; p++ {
		if n%p == 0 && strings.Repeat(string(r[:p]), n/p) == pin {
			return errWeakPin
		}
	}
	for _, common := range []string{"112233", "102030", "159753", "147258", "100200"} {
		if pin == common {
			return errWeakPin
		}
	}
	return nil
}

// ---- código de recuperação ----

// Alfabeto base32 sem caracteres ambíguos (0/O, 1/I/L) para ditar e anotar.
const recoveryAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

// newRecoveryCode gera 24 caracteres (~119 bits), em grupos de 4.
func newRecoveryCode() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	var b strings.Builder
	for i, x := range buf {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		// 256 não é múltiplo de 31: rejeição para evitar viés.
		for int(x) >= 256-256%len(recoveryAlphabet) {
			var one [1]byte
			if _, err := rand.Read(one[:]); err != nil {
				return "", err
			}
			x = one[0]
		}
		b.WriteByte(recoveryAlphabet[int(x)%len(recoveryAlphabet)])
	}
	return b.String(), nil
}

// normalizeRecoveryCode aceita minúsculas, espaços e hífens.
func normalizeRecoveryCode(code string) string {
	code = strings.ToUpper(code)
	var b strings.Builder
	for _, r := range code {
		if r != '-' && r != ' ' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func recoveryHash(code string) []byte {
	h := sha256.Sum256([]byte("batepapo-recovery-v1:" + normalizeRecoveryCode(code)))
	return h[:]
}
