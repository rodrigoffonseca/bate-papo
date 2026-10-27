package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RegistrationLock é o bloqueio de registro de uma conta.
type RegistrationLock struct {
	PinHash        []byte
	PinSalt        []byte
	PinScheme      string
	RecoveryHash   []byte
	FailedAttempts int
	CreatedAt      time.Time
}

// LockState descreve uma conta existente no momento de um novo registro.
type LockState struct {
	UserID   uuid.UUID
	Lock     *RegistrationLock // nil se a conta não tem PIN
	LastSeen time.Time
}

// LockStateByPhone devolve a conta do telefone e seu bloqueio, se houver.
func (s *Store) LockStateByPhone(ctx context.Context, phoneHash []byte) (*LockState, error) {
	st := &LockState{}
	var l RegistrationLock
	var pinHash []byte
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, u.last_seen_at, l.pin_hash, l.pin_salt, COALESCE(l.pin_scheme, ''), l.recovery_hash,
		       COALESCE(l.failed_attempts, 0), COALESCE(l.created_at, now())
		  FROM users u LEFT JOIN registration_locks l ON l.user_id = u.id
		 WHERE u.phone_hash = $1`, phoneHash).
		Scan(&st.UserID, &st.LastSeen, &pinHash, &l.PinSalt, &l.PinScheme, &l.RecoveryHash, &l.FailedAttempts, &l.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	if pinHash != nil {
		l.PinHash = pinHash
		st.Lock = &l
	}
	return st, nil
}

func (s *Store) GetRegistrationLock(ctx context.Context, userID uuid.UUID) (*RegistrationLock, error) {
	var l RegistrationLock
	err := s.pool.QueryRow(ctx, `
		SELECT pin_hash, pin_salt, pin_scheme, recovery_hash, failed_attempts, created_at
		  FROM registration_locks WHERE user_id = $1`, userID).
		Scan(&l.PinHash, &l.PinSalt, &l.PinScheme, &l.RecoveryHash, &l.FailedAttempts, &l.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return &l, nil
}

// SetRegistrationLock define (ou troca) o PIN e o código de recuperação,
// zerando as tentativas erradas.
func (s *Store) SetRegistrationLock(ctx context.Context, userID uuid.UUID, pinHash, pinSalt []byte, pinScheme string, recoveryHash []byte) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO registration_locks (user_id, pin_hash, pin_salt, pin_scheme, recovery_hash)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (user_id) DO UPDATE SET
		    pin_hash = EXCLUDED.pin_hash, pin_salt = EXCLUDED.pin_salt, pin_scheme = EXCLUDED.pin_scheme,
		    recovery_hash = EXCLUDED.recovery_hash, failed_attempts = 0, updated_at = now()`,
		userID, pinHash, pinSalt, pinScheme, recoveryHash)
	return err
}

// UpgradePinHash troca o hash do PIN por um calculado com outro esquema (ex.:
// incluir a chave secreta), sem mexer em tentativas nem no código de
// recuperação. Só atualiza se o esquema atual ainda for oldScheme.
func (s *Store) UpgradePinHash(ctx context.Context, userID uuid.UUID, oldScheme string, pinHash []byte, pinScheme string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE registration_locks SET pin_hash = $3, pin_scheme = $4
		 WHERE user_id = $1 AND pin_scheme = $2`, userID, oldScheme, pinHash, pinScheme)
	return err
}

// SetRecoveryHash troca apenas o código de recuperação.
func (s *Store) SetRecoveryHash(ctx context.Context, userID uuid.UUID, recoveryHash []byte) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE registration_locks SET recovery_hash = $2, updated_at = now() WHERE user_id = $1`,
		userID, recoveryHash)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (s *Store) DeleteRegistrationLock(ctx context.Context, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM registration_locks WHERE user_id = $1`, userID)
	return err
}

// RecordPinFailure soma uma tentativa errada e devolve o total.
func (s *Store) RecordPinFailure(ctx context.Context, userID uuid.UUID) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		UPDATE registration_locks SET failed_attempts = failed_attempts + 1
		 WHERE user_id = $1 RETURNING failed_attempts`, userID).Scan(&n)
	return n, notFound(err)
}

func (s *Store) ResetPinFailures(ctx context.Context, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE registration_locks SET failed_attempts = 0 WHERE user_id = $1`, userID)
	return err
}

// ---- desafios de desbloqueio ----

var ErrChallengeExhausted = errors.New("tentativas esgotadas para este código")

func (s *Store) CreateUnlockChallenge(ctx context.Context, tokenHash []byte, userID uuid.UUID, phoneHash []byte, ttl time.Duration) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO unlock_challenges (token_hash, user_id, phone_hash, expires_at)
		VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
		tokenHash, userID, phoneHash, ttl.Seconds())
	return err
}

// UseUnlockChallenge registra uma tentativa no desafio e devolve o usuário e
// o telefone. Falha com ErrNotFound se expirou e com ErrChallengeExhausted
// (apagando o desafio) após maxAttempts tentativas.
func (s *Store) UseUnlockChallenge(ctx context.Context, tokenHash []byte, maxAttempts int) (uuid.UUID, []byte, error) {
	var userID uuid.UUID
	var phoneHash []byte
	var attempts int
	err := s.pool.QueryRow(ctx, `
		UPDATE unlock_challenges SET attempts = attempts + 1
		 WHERE token_hash = $1 AND expires_at > now()
		RETURNING user_id, phone_hash, attempts`, tokenHash).Scan(&userID, &phoneHash, &attempts)
	if err != nil {
		return uuid.Nil, nil, notFound(err)
	}
	if attempts > maxAttempts {
		if err := s.DeleteUnlockChallenge(ctx, tokenHash); err != nil {
			return uuid.Nil, nil, err
		}
		return uuid.Nil, nil, ErrChallengeExhausted
	}
	return userID, phoneHash, nil
}

func (s *Store) DeleteUnlockChallenge(ctx context.Context, tokenHash []byte) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM unlock_challenges WHERE token_hash = $1`, tokenHash)
	return err
}

// ---- alertas ----

type AccountAlert struct {
	ID        uuid.UUID `json:"id"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"created_at"`
}

const (
	// AlertRegistrationAttempt: alguém confirmou o código SMS do número em
	// outro aparelho, mas foi barrado pelo PIN. Indício forte de SIM swap.
	AlertRegistrationAttempt = "registration_attempt"
	// AlertPinFailed: tentativa de PIN errada num novo aparelho.
	AlertPinFailed = "pin_failed"
	// AlertPinBlocked: tentativas de PIN esgotadas.
	AlertPinBlocked = "pin_blocked"
)

func (s *Store) AddAlert(ctx context.Context, userID uuid.UUID, kind string) (*AccountAlert, error) {
	a := &AccountAlert{ID: uuid.New(), Kind: kind}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO account_alerts (id, user_id, kind) VALUES ($1, $2, $3) RETURNING created_at`,
		a.ID, userID, kind).Scan(&a.CreatedAt)
	return a, err
}

func (s *Store) ListAlerts(ctx context.Context, userID uuid.UUID) ([]AccountAlert, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, kind, created_at FROM account_alerts
		 WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (AccountAlert, error) {
		var a AccountAlert
		err := r.Scan(&a.ID, &a.Kind, &a.CreatedAt)
		return a, err
	})
}

func (s *Store) AckAlerts(ctx context.Context, userID uuid.UUID, ids []uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM account_alerts WHERE user_id = $1 AND id = ANY($2)`, userID, ids)
	return err
}
