package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"time"

	"github.com/rodrigoffonseca/bate-papo/server/internal/phone"
	"github.com/rodrigoffonseca/bate-papo/server/internal/store"
)

const (
	otpTTL         = 10 * time.Minute
	otpMinInterval = time.Minute
	otpMaxAttempts = 5
)

func (s *Server) codeHash(phoneHash []byte, code string) []byte {
	h := sha256.New()
	h.Write(s.cfg.PhonePepper)
	h.Write(phoneHash)
	h.Write([]byte(code))
	return h.Sum(nil)
}

func randomCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func (s *Server) handleRequestCode(w http.ResponseWriter, r *http.Request) {
	if !s.otpLimiter.Allow(s.clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "muitas solicitações; tente mais tarde")
		return
	}
	var req struct {
		Phone string `json:"phone"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	e164, err := phone.Normalize(req.Phone)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ph := phone.Hash(s.cfg.PhonePepper, e164)
	if !s.phoneLimiter.Allow(string(ph)) {
		writeError(w, http.StatusTooManyRequests, "muitas solicitações para este número; tente mais tarde")
		return
	}
	// Números de teste têm código fixo e não recebem SMS. Sem provedor de
	// SMS (BATEPAPO_SMS_PROVIDER=none), só eles podem se cadastrar.
	code, testPhone := s.cfg.TestPhones[e164]
	if !testPhone {
		if s.sms == nil {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error": "o cadastro neste servidor está restrito a números de teste",
				"code":  "signup_closed",
			})
			return
		}
		var err error
		if code, err = randomCode(); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	err = s.store.PutOTP(r.Context(), ph, s.codeHash(ph, code), otpTTL, otpMinInterval)
	if errors.Is(err, store.ErrTooSoon) {
		writeError(w, http.StatusTooManyRequests, err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !testPhone {
		if err := s.sms.SendCode(r.Context(), e164, code); err != nil {
			s.log.Error("envio de SMS", "err", err)
			writeError(w, http.StatusBadGateway, "não foi possível enviar o SMS")
			return
		}
	}
	resp := map[string]any{"expires_in": int(otpTTL.Seconds())}
	if s.cfg.DevExposeOTP {
		resp["dev_code"] = code
	}
	writeJSON(w, http.StatusAccepted, resp)
}

func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	if !s.verifyLimiter.Allow(s.clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "muitas tentativas; tente mais tarde")
		return
	}
	var req struct {
		Phone string `json:"phone"`
		Code  string `json:"code"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	e164, err := phone.Normalize(req.Phone)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ph := phone.Hash(s.cfg.PhonePepper, e164)
	ok, err := s.store.CheckOTP(r.Context(), ph, s.codeHash(ph, req.Code), otpMaxAttempts)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "código inválido ou expirado")
		return
	}

	// Conta protegida por PIN: o SMS sozinho não basta (proteção contra
	// SIM swap). O dono legítimo é avisado na hora.
	locked, err := s.checkRegistrationLock(w, r, ph)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !locked {
		s.completeRegistration(w, r, ph)
	}
}

// completeRegistration cria a conta (ou assume a existente) neste aparelho e
// responde com o token da nova sessão.
func (s *Server) completeRegistration(w http.ResponseWriter, r *http.Request, ph []byte) {
	token, err := randomToken()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	user, isNew, err := s.store.RegisterDevice(r.Context(), ph, hashToken(token))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// Um novo aparelho invalida as conexões em tempo real do anterior.
	s.hub.Disconnect(user.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"token":       token,
		"user":        user,
		"new_account": isNew,
	})
}

func randomToken() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteSession(r.Context(), hashToken(bearerToken(r))); err != nil {
		s.internalError(w, r, err)
		return
	}
	// Um aparelho por conta: depois de sair, ele não recebe mais avisos.
	if err := s.store.DeletePushToken(r.Context(), currentUser(r).ID, ""); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
