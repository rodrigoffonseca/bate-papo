package push

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"syscall"
	"time"
)

// UnifiedPush entrega pelo distribuidor que a pessoa escolheu no aparelho
// (ntfy, NextPush, um servidor próprio…), sem depender de Google ou Apple.
// O "token" é o endereço HTTPS que o distribuidor deu ao app.
//
// Como o endereço vem do usuário, o servidor só se conecta a endereços
// públicos: nada de localhost, rede interna ou metadados da nuvem (SSRF).
type UnifiedPush struct {
	// AllowPrivate libera endereços internos e http (apenas desenvolvimento e testes).
	AllowPrivate bool
	client       *http.Client
}

func NewUnifiedPush(allowPrivate bool) *UnifiedPush {
	u := &UnifiedPush{AllowPrivate: allowPrivate}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	if !allowPrivate {
		// Confere o IP de fato conectado (depois da resolução de DNS), o que
		// também barra truques de DNS que apontam para a rede interna.
		dialer.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if ip := net.ParseIP(host); ip == nil || !publicIP(ip) {
				return fmt.Errorf("endereço %s não permitido para push", host)
			}
			return nil
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = dialer.DialContext
	u.client = &http.Client{
		Timeout:   10 * time.Second,
		Transport: transport,
		// Sem redirecionamentos: o destino tem de ser o endereço registrado.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return u
}

func publicIP(ip net.IP) bool {
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast() ||
		// 100.64.0.0/10 (CGNAT) e 192.0.0.0/24 também não são destinos legítimos.
		cgnat.Contains(ip) || ietf.Contains(ip))
}

var (
	_, cgnat, _ = net.ParseCIDR("100.64.0.0/10")
	_, ietf, _  = net.ParseCIDR("192.0.0.0/24")
)

func (u *UnifiedPush) Validate(endpoint string) error {
	if len(endpoint) > 1024 {
		return errors.New("endereço UnifiedPush longo demais")
	}
	p, err := url.Parse(endpoint)
	if err != nil || p.Host == "" || p.User != nil {
		return errors.New("endereço UnifiedPush inválido")
	}
	if p.Scheme != "https" && !(u.AllowPrivate && p.Scheme == "http") {
		return errors.New("o endereço UnifiedPush precisa usar https")
	}
	if !u.AllowPrivate {
		if ip := net.ParseIP(p.Hostname()); ip != nil && !publicIP(ip) {
			return errors.New("endereço UnifiedPush não permitido")
		}
		if p.Hostname() == "localhost" {
			return errors.New("endereço UnifiedPush não permitido")
		}
	}
	return nil
}

func (u *UnifiedPush) Send(ctx context.Context, endpoint string, ev Event) error {
	if err := u.Validate(endpoint); err != nil {
		return ErrInvalidToken
	}
	// O corpo diz só o tipo do aviso; o app mostra o texto fixo.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader([]byte(`{"t":"`+string(ev)+`"}`)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	// Cabeçalhos do Web Push (RFC 8030): validade, urgência e substituição.
	req.Header.Set("TTL", "86400")
	req.Header.Set("Urgency", "high")
	req.Header.Set("Topic", string(ev))
	resp, err := u.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return ErrInvalidToken
	default:
		return fmt.Errorf("distribuidor UnifiedPush respondeu %s", resp.Status)
	}
}
