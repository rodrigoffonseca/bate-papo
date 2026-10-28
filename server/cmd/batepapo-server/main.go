// Comando batepapo-server: servidor de mensagens do Bate-Papo.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rodrigoffonseca/bate-papo/server/internal/api"
	"github.com/rodrigoffonseca/bate-papo/server/internal/blob"
	"github.com/rodrigoffonseca/bate-papo/server/internal/config"
	"github.com/rodrigoffonseca/bate-papo/server/internal/pepper"
	"github.com/rodrigoffonseca/bate-papo/server/internal/push"
	"github.com/rodrigoffonseca/bate-papo/server/internal/sms"
	"github.com/rodrigoffonseca/bate-papo/server/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("encerrando", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.DevExposeOTP {
		log.Warn("BATEPAPO_DEV_EXPOSE_OTP ativo: códigos de verificação são devolvidos pela API. Nunca use em produção.")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}

	blobs, err := blob.NewFS(cfg.BlobDir)
	if err != nil {
		return err
	}

	var sender sms.Sender
	switch cfg.SMSProvider {
	case "console":
		sender = sms.Console{Log: log}
	case "webhook":
		sender = sms.Webhook{URL: cfg.SMSWebhookURL, Key: cfg.SMSWebhookKey}
	case "none":
		// Teste fechado: só os números de BATEPAPO_TEST_PHONES se cadastram.
		log.Warn("sem provedor de SMS: cadastro restrito aos números de teste", "numeros", len(cfg.TestPhones))
	default:
		return errors.New("BATEPAPO_SMS_PROVIDER desconhecido: " + cfg.SMSProvider)
	}

	pinKeyer, err := newPinKeyer(ctx, cfg)
	if err != nil {
		return err
	}
	if len(cfg.TestPhones) > 0 && cfg.SMSProvider != "none" {
		log.Warn("números de teste ativos (código fixo, sem SMS)", "numeros", len(cfg.TestPhones))
	}
	log.Info("chave secreta do PIN configurada", "provider", cfg.PinKeyProvider, "id", pinKeyer.ID())

	srv := api.New(cfg, st, blobs, sender, pinKeyer, log)
	pusher, err := newPusher(cfg)
	if err != nil {
		return err
	}
	srv.SetPush(pusher)
	log.Info("notificações push", "servicos", pusher.Kinds())
	go srv.RunJanitor(ctx, time.Hour)

	httpSrv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		log.Info("servidor Bate-Papo ouvindo", "addr", cfg.ListenAddr, "env", cfg.Env)
		errc <- httpSrv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return httpSrv.Shutdown(shutdownCtx)
}

// newPinKeyer prepara a chave secreta do PIN e, com o OpenBao, confere na
// partida que o serviço responde (melhor falhar agora do que no primeiro PIN).
func newPinKeyer(ctx context.Context, cfg *config.Config) (pepper.Keyer, error) {
	if cfg.PinKeyProvider == "local" {
		return pepper.NewLocal(cfg.PinPepper)
	}
	t, err := pepper.NewTransit(pepper.TransitConfig{
		Addr: cfg.OpenBao.Addr, Token: cfg.OpenBao.Token, TokenFile: cfg.OpenBao.TokenFile,
		Mount: cfg.OpenBao.Mount, Key: cfg.OpenBao.Key,
	})
	if err != nil {
		return nil, err
	}
	probe, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := t.MAC(probe, []byte("batepapo-startup-check")); err != nil {
		return nil, fmt.Errorf("testando o OpenBao: %w", err)
	}
	return t, nil
}

// newPusher prepara os serviços de push configurados.
func newPusher(cfg *config.Config) (*push.Dispatcher, error) {
	d := push.NewDispatcher()
	p := cfg.Push
	if p.FCMCredentialsFile != "" {
		f, err := push.NewFCMFromFile(p.FCMCredentialsFile)
		if err != nil {
			return nil, err
		}
		d.Add(push.KindFCM, f)
	}
	if p.APNsKeyFile != "" {
		a, err := push.NewAPNs(push.APNsConfig{
			KeyFile: p.APNsKeyFile, KeyID: p.APNsKeyID, TeamID: p.APNsTeamID, Topic: p.APNsTopic, Sandbox: p.APNsSandbox,
		})
		if err != nil {
			return nil, err
		}
		d.Add(push.KindAPNs, a)
	}
	if p.UnifiedPush {
		d.Add(push.KindUnifiedPush, push.NewUnifiedPush(p.AllowPrivateEndpoints))
	}
	return d, nil
}
