# Bate-Papo

**Mensageiro open-source, 100% brasileiro, com criptografia de ponta a ponta e soberania dos dados.**

O Bate-Papo é um aplicativo de mensagens no estilo WhatsApp, pensado para o Brasil:

- **Segurança por padrão** — toda mensagem, foto e áudio é cifrada no aparelho de quem envia e só é decifrada no aparelho de quem recebe. O servidor não tem como ler o conteúdo.
- **Criptografia aberta e auditável** — usamos o mesmo desenho do protocolo Signal (X3DH + Double Ratchet), implementado sobre bibliotecas criptográficas auditadas (`@noble/*`).
- **Soberania dos dados** — qualquer pessoa, empresa ou órgão público pode hospedar o próprio servidor, no Brasil, com os dados sob sua jurisdição. Sem dependência de nuvem estrangeira, sem provedor de SMS imposto.
- **Coleta mínima (LGPD)** — o servidor guarda só o necessário para entregar mensagens; o número de telefone nem é salvo em texto claro.

> ⚠️ **Projeto em fase inicial (MVP).** A criptografia ainda não passou por auditoria independente. Não use para comunicações sensíveis até a primeira versão estável.

## O que o MVP faz

| Recurso | Situação |
| --- | --- |
| Cadastro com número de telefone (código por SMS) | ✅ servidor + SDK + app |
| Proteção contra SIM swap: PIN obrigatório, código de recuperação e alertas ([detalhes](docs/seguranca-da-conta.md)) | ✅ servidor + SDK + app |
| Nome de usuário (`@maria`) e nome de exibição | ✅ servidor + SDK + app |
| Busca de contatos por nome de usuário ou telefone | ✅ servidor + SDK + app |
| Mensagens de texto cifradas de ponta a ponta | ✅ servidor + SDK + app |
| Fotos e vídeos cifrados de ponta a ponta | ✅ servidor + SDK + app |
| Mensagens de voz cifradas de ponta a ponta | ✅ servidor + SDK + app |
| Grupos (criar, adicionar/remover membros, administradores, sair) | ✅ servidor + SDK + app |
| Entrega em tempo real (WebSocket) e fila para quem está offline | ✅ servidor + SDK + app |
| Número de segurança (verificação de identidade) com QR code e alerta de troca de chave | ✅ SDK + app |
| Notificações push sem conteúdo (FCM, APNs, UnifiedPush) | ✅ servidor + app (UnifiedPush só no servidor) |
| Aplicativo móvel (Android/iOS) | 🚧 em construção: cadastro, perfil, conversas e grupos com texto, fotos, vídeos e voz prontos ([apps/mobile](apps/mobile/)) |

## Arquitetura em 30 segundos

```
 ┌─────────────────────┐  HTTPS/WSS (só dados cifrados)  ┌────────────────────────┐
 │ App (RN)            │ ──────────────────────────────▶ │ batepapo-server (Go)   │
 │  @bate-papo/client  │ ◀────────────────────────────── │  PostgreSQL            │
 │  @bate-papo/crypto  │                                 │  anexos cifrados       │
 └─────────────────────┘                                 └────────────────────────┘
   chaves privadas                                         chaves públicas,
   ficam no aparelho                                       filas de entrega
```

- [`server/`](server/) — servidor em Go: cadastro, diretório de chaves públicas, grupos, fila de entrega, anexos cifrados, WebSocket.
- [`packages/crypto/`](packages/crypto/) — `@bate-papo/crypto`: X3DH, Double Ratchet, cifra de anexos, número de segurança.
- [`packages/client/`](packages/client/) — `@bate-papo/client`: SDK em TypeScript usado pelos apps (cadastro, envio, recebimento, grupos).
- [`apps/mobile/`](apps/mobile/) — app Android/iOS em React Native (Expo), com histórico cifrado no aparelho (SQLCipher + Keychain/Keystore).

Detalhes em [docs/arquitetura-funcional.md](docs/arquitetura-funcional.md) (capacidades, fluxos e infraestrutura de operação), [docs/arquitetura.md](docs/arquitetura.md), [docs/seguranca.md](docs/seguranca.md) e [docs/api.md](docs/api.md).

## Rodando localmente

Pré-requisitos: Go 1.25+, Node.js 22+, PostgreSQL 16 (ou Docker).

**Com Docker:**

```sh
docker compose up --build
curl localhost:8080/healthz
```

**Sem Docker:**

```sh
createdb batepapo
cd server
BATEPAPO_DATABASE_URL=postgres://localhost/batepapo BATEPAPO_DEV_EXPOSE_OTP=true go run ./cmd/batepapo-server
```

Em desenvolvimento, o código SMS aparece no log do servidor (e, com `BATEPAPO_DEV_EXPOSE_OTP=true`, na própria resposta da API).

**Usando o SDK:**

```ts
import { KeyValueStorage, BatePapoClient } from '@bate-papo/client';

const chat = new BatePapoClient({ serverUrl: 'http://localhost:8080', storage: new KeyValueStorage() });
const { dev_code } = await chat.requestCode('+55 11 98765-4321');
await chat.verifyCode('+55 11 98765-4321', dev_code!);
await chat.setProfile({ username: 'maria', displayName: 'Maria' });

chat.on('message', (m) => console.log(m.from, m.kind, m.text));
chat.connect();

const joao = await chat.findByUsername('@joao');
await chat.sendText({ userId: joao.id }, 'Oi, João!');
await chat.sendImage({ userId: joao.id }, fotoBytes, { mime: 'image/jpeg', width: 1080, height: 1350 });
await chat.sendVoice({ userId: joao.id }, audioBytes, { mime: 'audio/ogg; codecs=opus', durationMs: 5300 });

const grupo = await chat.createGroup('Família', [joao.id]);
await chat.sendText({ groupId: grupo.id }, 'Bom dia, família!');
```

## Testes

```sh
# Servidor (os testes de integração precisam de um banco descartável)
cd server && BATEPAPO_TEST_DATABASE_URL=postgres://localhost/batepapo_test go test -race ./...

# Criptografia + SDK (o teste ponta a ponta compila e sobe o servidor Go)
npm ci
BATEPAPO_TEST_DATABASE_URL=postgres://localhost/batepapo_test npm test
```

## Roteiro

**MVP (agora)**
- [x] Servidor, protocolo criptográfico e SDK
- [x] App React Native (Expo) — fatia 1: cadastro, perfil, conversas e chat de texto
- [x] App — fatia 2: fotos e vídeos (câmera/galeria) e mensagens de voz
- [x] App — fatia 3: grupos (criar, conversar, participantes, administradores, sair)
- [x] App: número de segurança com QR code
- [x] Notificações push sem conteúdo (apenas "você tem mensagens"): FCM, APNs e UnifiedPush no servidor
- [ ] UnifiedPush no app (Android sem Google)
- [ ] Rotação periódica da signed prekey
- [x] Segurança da conta — fase 1: PIN contra SIM swap, código de recuperação, alertas ([roteiro completo](docs/seguranca-da-conta.md#4-roteiro-até-a-versão-de-produção))
- [x] Segurança da conta — fase 2a: chave secreta do PIN fora do banco (variável de ambiente ou OpenBao)
- [ ] Segurança da conta — fase 2b: passkeys
- [x] Armazenamento local cifrado (SQLCipher + Keychain/Keystore)

**Depois do MVP**
- [ ] Auditoria de segurança independente
- [ ] Vários aparelhos por conta (celular + computador)
- [ ] *Sealed sender* (servidor sem saber quem enviou) e metadados de grupo cifrados
- [ ] Chave de grupo (*sender keys*) para grupos grandes
- [ ] Chamadas de voz e vídeo
- [ ] Federação entre servidores independentes
- [ ] Backup cifrado

## Como contribuir

Toda ajuda é bem-vinda: código, revisão de segurança, design, tradução, documentação, testes. Leia o [CONTRIBUTING.md](CONTRIBUTING.md). Encontrou uma vulnerabilidade? Siga o [SECURITY.md](SECURITY.md) — não abra issue pública.

## Licença

[GPL-3.0](LICENSE). O Bate-Papo é e sempre será software livre.
