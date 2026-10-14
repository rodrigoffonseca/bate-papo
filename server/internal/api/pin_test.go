package api

import (
	"strings"
	"testing"
)

func TestValidatePin(t *testing.T) {
	for _, ok := range []string{"284917", "93a!kd", "minha senha forte", "142857", "pão-de-queijo"} {
		if err := validatePin(ok); err != nil {
			t.Errorf("validatePin(%q) = %v; esperava aceitar", ok, err)
		}
	}
	for _, bad := range []string{"", "12345", "123456", "654321", "111111", "121212", "123123", "abcdef", "112233", "çççççç", strings.Repeat("9", 65)} {
		if validatePin(bad) == nil {
			t.Errorf("validatePin(%q) aceitou um PIN fraco", bad)
		}
	}
}

func TestPinHash(t *testing.T) {
	h, salt, err := newPinHash("284917")
	if err != nil {
		t.Fatal(err)
	}
	if !pinMatches("284917", salt, h) || pinMatches("284918", salt, h) {
		t.Fatal("verificação do PIN incorreta")
	}
	h2, salt2, _ := newPinHash("284917")
	if string(h) == string(h2) || string(salt) == string(salt2) {
		t.Fatal("o sal deveria tornar cada hash único")
	}
}

func TestRecoveryCode(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		c, err := newRecoveryCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(c) != 29 || strings.Count(c, "-") != 5 {
			t.Fatalf("formato inesperado: %q", c)
		}
		for _, r := range strings.ReplaceAll(c, "-", "") {
			if !strings.ContainsRune(recoveryAlphabet, r) {
				t.Fatalf("caractere fora do alfabeto em %q", c)
			}
		}
		if seen[c] {
			t.Fatal("código repetido")
		}
		seen[c] = true
	}
	c, _ := newRecoveryCode()
	typed := strings.ToLower(strings.ReplaceAll(c, "-", " "))
	if string(recoveryHash(c)) != string(recoveryHash(typed)) {
		t.Fatal("o código digitado em minúsculas e com espaços deveria valer")
	}
}
