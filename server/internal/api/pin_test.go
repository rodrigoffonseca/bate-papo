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

func TestArgon2idIsSaltedAndDeterministic(t *testing.T) {
	salt1, salt2 := []byte("sal-1-com-16-byt"), []byte("sal-2-com-16-byt")
	if string(hashPin("284917", salt1)) != string(hashPin("284917", salt1)) {
		t.Fatal("o mesmo PIN e sal devem dar o mesmo resultado")
	}
	if string(hashPin("284917", salt1)) == string(hashPin("284917", salt2)) {
		t.Fatal("o sal deveria tornar cada hash único")
	}
	if string(hashPin("284917", salt1)) == string(hashPin("284918", salt1)) {
		t.Fatal("PINs diferentes devem dar resultados diferentes")
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
