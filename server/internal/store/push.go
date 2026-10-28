package store

import (
	"context"

	"github.com/google/uuid"
)

// PushToken é o endereço para acordar o aparelho da conta.
type PushToken struct {
	Kind  string
	Token string
}

// SetPushToken grava (ou troca) o token de push da conta.
func (s *Store) SetPushToken(ctx context.Context, userID uuid.UUID, kind, token string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO push_tokens (user_id, kind, token) VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET kind = excluded.kind, token = excluded.token, updated_at = now()`,
		userID, kind, token)
	return err
}

// GetPushToken devolve o token da conta, ou ErrNotFound.
func (s *Store) GetPushToken(ctx context.Context, userID uuid.UUID) (*PushToken, error) {
	var t PushToken
	err := s.pool.QueryRow(ctx, `SELECT kind, token FROM push_tokens WHERE user_id = $1`, userID).Scan(&t.Kind, &t.Token)
	if err != nil {
		return nil, notFound(err)
	}
	return &t, nil
}

// DeletePushToken apaga o token da conta. Com token não vazio, só apaga se
// ainda for o mesmo (o app pode ter registrado outro nesse meio-tempo).
func (s *Store) DeletePushToken(ctx context.Context, userID uuid.UUID, token string) error {
	if token == "" {
		_, err := s.pool.Exec(ctx, `DELETE FROM push_tokens WHERE user_id = $1`, userID)
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM push_tokens WHERE user_id = $1 AND token = $2`, userID, token)
	return err
}
