package config

import (
	"strings"
	"testing"
)

const (
	phoneHex = "1111111111111111111111111111111111111111111111111111111111111111"
	pinHex   = "2222222222222222222222222222222222222222222222222222222222222222"
)

// production configura um ambiente de produção válido; cada teste muda um item.
func production(t *testing.T) {
	t.Setenv("BATEPAPO_ENV", "production")
	t.Setenv("BATEPAPO_PHONE_PEPPER", phoneHex)
	t.Setenv("BATEPAPO_SMS_PROVIDER", "webhook")
	t.Setenv("BATEPAPO_SMS_WEBHOOK_URL", "https://sms.exemplo.br/enviar")
	t.Setenv("BATEPAPO_PIN_KEY_PROVIDER", "")
	t.Setenv("BATEPAPO_PIN_PEPPER", pinHex)
}

func expectErr(t *testing.T, contains string) {
	t.Helper()
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), contains) {
		t.Fatalf("esperava erro com %q, veio %v", contains, err)
	}
}

func TestPinKeyInProduction(t *testing.T) {
	production(t)
	c, err := Load()
	if err != nil || c.PinKeyProvider != "local" || len(c.PinPepper) != 32 {
		t.Fatalf("configuração válida recusada: %v", err)
	}

	t.Setenv("BATEPAPO_PIN_PEPPER", "")
	expectErr(t, "BATEPAPO_PIN_PEPPER é obrigatório")

	t.Setenv("BATEPAPO_PIN_PEPPER", "abcd")
	expectErr(t, "32 bytes")

	t.Setenv("BATEPAPO_PIN_PEPPER", phoneHex)
	expectErr(t, "diferente de BATEPAPO_PHONE_PEPPER")

	t.Setenv("BATEPAPO_PIN_KEY_PROVIDER", "hsm-magico")
	expectErr(t, "desconhecido")
}

func TestOpenBaoConfig(t *testing.T) {
	production(t)
	t.Setenv("BATEPAPO_PIN_KEY_PROVIDER", "openbao")
	t.Setenv("BATEPAPO_PIN_PEPPER", "")
	expectErr(t, "BATEPAPO_OPENBAO_ADDR")

	t.Setenv("BATEPAPO_OPENBAO_ADDR", "http://bao.exemplo.br:8200")
	t.Setenv("BATEPAPO_OPENBAO_TOKEN", "s.token")
	expectErr(t, "https")

	// Na mesma máquina (agente local), http é aceitável.
	t.Setenv("BATEPAPO_OPENBAO_ADDR", "http://127.0.0.1:8200")
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}

	t.Setenv("BATEPAPO_OPENBAO_ADDR", "https://bao.exemplo.br:8200")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.OpenBao.Mount != "transit" || c.OpenBao.Key != "batepapo-pin" {
		t.Fatalf("padrões inesperados: %+v", c.OpenBao)
	}
}

func TestDevelopmentDefaults(t *testing.T) {
	t.Setenv("BATEPAPO_ENV", "development")
	t.Setenv("BATEPAPO_PHONE_PEPPER", "")
	t.Setenv("BATEPAPO_PIN_PEPPER", "")
	t.Setenv("BATEPAPO_PIN_KEY_PROVIDER", "")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.PinPepper) < 32 || string(c.PinPepper) == string(c.PhonePepper) {
		t.Fatal("o padrão de desenvolvimento deve ter chave do PIN própria")
	}
}
