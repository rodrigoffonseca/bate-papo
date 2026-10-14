package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/rodrigoffonseca/bate-papo/server/internal/store"
)

const unlockChallengeTTL = 15 * time.Minute

// checkRegistrationLock decide se um registro por SMS pode prosseguir. Se a
// conta tem PIN e está em uso, responde 423 com um lock_token (prova de que o
// SMS foi confirmado) e devolve true.
func (s *Server) checkRegistrationLock(w http.ResponseWriter, r *http.Request, ph []byte) (bool, error) {
	st, err := s.store.LockStateByPhone(r.Context(), ph)
	if errors.Is(err, store.ErrNotFound) || (err == nil && st.Lock == nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if time.Since(st.LastSeen) >= s.cfg.LockInactivity {
		// O aparelho registrado está inativo há muito tempo: o dono pode ter
		// perdido o PIN e o aparelho. O bloqueio expira; o novo aparelho
		// definirá um novo PIN.
		s.log.Info("bloqueio de registro expirado por inatividade")
		return false, s.store.DeleteRegistrationLock(r.Context(), st.UserID)
	}

	token, err := randomToken()
	if err != nil {
		return false, err
	}
	if err := s.store.CreateUnlockChallenge(r.Context(), hashToken(token), st.UserID, ph, unlockChallengeTTL); err != nil {
		return false, err
	}
	s.alert(r, st.UserID, store.AlertRegistrationAttempt)
	writeJSON(w, http.StatusLocked, map[string]any{
		"error":         "esta conta é protegida por PIN",
		"code":          "registration_locked",
		"lock_token":    token,
		"expires_in":    int(unlockChallengeTTL.Seconds()),
		"attempts_left": max(0, MaxPinFailures-st.Lock.FailedAttempts),
	})
	return true, nil
}

// alert registra um alerta para o dono da conta e o avisa em tempo real.
func (s *Server) alert(r *http.Request, userID uuid.UUID, kind string) {
	a, err := s.store.AddAlert(r.Context(), userID, kind)
	if err != nil {
		s.log.Error("registrando alerta", "err", err)
		return
	}
	s.hub.NotifyAlert(userID, a)
}

// handleUnlock conclui um registro barrado pelo PIN, com o PIN ou com o
// código de recuperação.
func (s *Server) handleUnlock(w http.ResponseWriter, r *http.Request) {
	if !s.verifyLimiter.Allow(s.clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "muitas tentativas; tente mais tarde")
		return
	}
	var req struct {
		LockToken    string `json:"lock_token"`
		Pin          string `json:"pin"`
		RecoveryCode string `json:"recovery_code"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if (req.Pin == "") == (req.RecoveryCode == "") {
		writeError(w, http.StatusBadRequest, "informe o PIN ou o código de recuperação")
		return
	}
	userID, ph, err := s.store.UseUnlockChallenge(r.Context(), hashToken(req.LockToken), unlockAttemptsPerChallenge)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusUnauthorized, map[string]string{
			"error": "tempo esgotado; peça um novo código SMS", "code": "expired",
		})
		return
	case errors.Is(err, store.ErrChallengeExhausted):
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": "tentativas esgotadas; peça um novo código SMS", "code": "too_many_attempts",
		})
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	}

	lock, err := s.store.GetRegistrationLock(r.Context(), userID)
	if errors.Is(err, store.ErrNotFound) {
		// O dono removeu o PIN nesse meio-tempo.
		s.finishUnlock(w, r, req.LockToken, ph)
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}

	if req.RecoveryCode != "" {
		if !constantTimeEqual(recoveryHash(req.RecoveryCode), lock.RecoveryHash) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{
				"error": "código de recuperação incorreto", "code": "wrong_recovery_code",
			})
			return
		}
		// O código de recuperação é de uso único: o PIN é removido e o novo
		// aparelho define um novo PIN (com novo código).
		if err := s.store.DeleteRegistrationLock(r.Context(), userID); err != nil {
			s.internalError(w, r, err)
			return
		}
		s.finishUnlock(w, r, req.LockToken, ph)
		return
	}

	if lock.FailedAttempts >= MaxPinFailures {
		writeJSON(w, http.StatusLocked, map[string]any{
			"error": "tentativas de PIN esgotadas; use o código de recuperação",
			"code":  "pin_blocked",
		})
		return
	}
	if !pinMatches(req.Pin, lock.PinSalt, lock.PinHash) {
		n, err := s.store.RecordPinFailure(r.Context(), userID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		kind := store.AlertPinFailed
		if n >= MaxPinFailures {
			kind = store.AlertPinBlocked
		}
		s.alert(r, userID, kind)
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error":         "PIN incorreto",
			"code":          "wrong_pin",
			"attempts_left": max(0, MaxPinFailures-n),
		})
		return
	}
	if err := s.store.ResetPinFailures(r.Context(), userID); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.finishUnlock(w, r, req.LockToken, ph)
}

func (s *Server) finishUnlock(w http.ResponseWriter, r *http.Request, lockToken string, ph []byte) {
	if err := s.store.DeleteUnlockChallenge(r.Context(), hashToken(lockToken)); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.completeRegistration(w, r, ph)
}

// ---- gestão do PIN pelo próprio dono (sessão autenticada) ----

func (s *Server) handleGetLock(w http.ResponseWriter, r *http.Request) {
	lock, err := s.store.GetRegistrationLock(r.Context(), currentUser(r).ID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":         true,
		"created_at":      lock.CreatedAt,
		"failed_attempts": lock.FailedAttempts,
	})
}

// handleSetLock define ou troca o PIN e devolve um novo código de
// recuperação, que só é mostrado agora.
func (s *Server) handleSetLock(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Pin string `json:"pin"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if err := validatePin(req.Pin); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	pinHash, salt, err := newPinHash(req.Pin)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	code, err := newRecoveryCode()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.store.SetRegistrationLock(r.Context(), currentUser(r).ID, pinHash, salt, recoveryHash(code)); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recovery_code": code})
}

func (s *Server) handleDeleteLock(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteRegistrationLock(r.Context(), currentUser(r).ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleCheckPin confere o PIN (lembrete periódico para o dono não esquecê-lo).
func (s *Server) handleCheckPin(w http.ResponseWriter, r *http.Request) {
	if !s.pinCheckLimiter.Allow(currentUser(r).ID.String()) {
		writeError(w, http.StatusTooManyRequests, "muitas tentativas; tente mais tarde")
		return
	}
	var req struct {
		Pin string `json:"pin"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	lock, err := s.store.GetRegistrationLock(r.Context(), currentUser(r).ID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "a conta não tem PIN")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": pinMatches(req.Pin, lock.PinSalt, lock.PinHash)})
}

func (s *Server) handleNewRecoveryCode(w http.ResponseWriter, r *http.Request) {
	code, err := newRecoveryCode()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	err = s.store.SetRecoveryHash(r.Context(), currentUser(r).ID, recoveryHash(code))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "defina um PIN primeiro")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recovery_code": code})
}

func (s *Server) handleListAlerts(w http.ResponseWriter, r *http.Request) {
	alerts, err := s.store.ListAlerts(r.Context(), currentUser(r).ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"alerts": alerts})
}

func (s *Server) handleAckAlerts(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if err := s.store.AckAlerts(r.Context(), currentUser(r).ID, req.IDs); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
