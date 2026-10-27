# Auto-hospedagem e soberania dos dados

Um dos pilares do Bate-Papo é que **os dados ficam onde você decide**. Uma prefeitura, universidade, empresa, sindicato ou associação pode rodar seu próprio servidor, em datacenter no Brasil, sob a legislação brasileira.

## Requisitos

- Linux com Docker (ou o binário Go compilado), 1 vCPU e 1 GB de RAM atendem milhares de usuários.
- PostgreSQL 16.
- Domínio com HTTPS (recomendamos Caddy ou Nginx como proxy reverso).
- Um provedor de SMS (de preferência nacional) acessível via um pequeno serviço HTTP seu.

## Configuração

Todas as opções são variáveis de ambiente (veja [.env.example](../.env.example)):

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `BATEPAPO_ENV` | `development` | Use `production`: o servidor passa a recusar configurações inseguras |
| `BATEPAPO_LISTEN_ADDR` | `:8080` | Endereço HTTP |
| `BATEPAPO_DATABASE_URL` | `postgres://batepapo:batepapo@localhost:5432/batepapo` | Conexão com o PostgreSQL |
| `BATEPAPO_PHONE_PEPPER` | — | **Obrigatório em produção.** 32 bytes em hex (`openssl rand -hex 32`). Faça backup seguro: sem ele, ninguém consegue entrar pelo número |
| `BATEPAPO_SMS_PROVIDER` | `console` | `webhook` em produção |
| `BATEPAPO_SMS_WEBHOOK_URL` / `_KEY` | — | Serviço que envia o SMS (veja abaixo) |
| `BATEPAPO_TRUST_PROXY_HEADERS` | `false` | `true` atrás de proxy reverso, para limitar por IP real |
| `BATEPAPO_BLOB_DIR` | `./data/blobs` | Onde guardar anexos cifrados |
| `BATEPAPO_MAX_ATTACHMENT_BYTES` | 25 MiB | Tamanho máximo de anexo |
| `BATEPAPO_RETENTION_DAYS` | `30` | Validade de mensagens não entregues, anexos e alertas de segurança |
| `BATEPAPO_SESSION_IDLE_DAYS` | `90` | Sessões sem uso por esse tempo expiram |
| `BATEPAPO_PIN_KEY_PROVIDER` | `local` | Onde fica a chave secreta do PIN: `local` (variável abaixo) ou `openbao` (OpenBao/Vault Transit, recomendado em produção). Veja a seção 3.9 de [seguranca-da-conta.md](seguranca-da-conta.md#39-chave-secreta-do-pin-fase-2a) |
| `BATEPAPO_PIN_PEPPER` | — | Com `local`, **obrigatório em produção**: 32 bytes em hex (`openssl rand -hex 32`), diferente de `BATEPAPO_PHONE_PEPPER` |
| `BATEPAPO_OPENBAO_ADDR` / `_TOKEN` ou `_TOKEN_FILE` | — | Com `openbao`: endereço (https) e token com permissão só de `hmac`/`verify` na chave do PIN. O arquivo do token é relido a cada uso |
| `BATEPAPO_OPENBAO_MOUNT` / `_KEY` | `transit` / `batepapo-pin` | Com `openbao`: onde está o motor Transit e o nome da chave |
| `BATEPAPO_LOCK_INACTIVITY_DAYS` | `7` | Depois desse tempo sem uso do aparelho registrado, o PIN deixa de ser exigido (recuperação para quem perdeu tudo). Veja [seguranca-da-conta.md](seguranca-da-conta.md) |

### Webhook de SMS

O Bate-Papo não se prende a nenhum fornecedor. Ele faz:

```http
POST {BATEPAPO_SMS_WEBHOOK_URL}
Authorization: Bearer {BATEPAPO_SMS_WEBHOOK_KEY}
Content-Type: application/json

{"to": "+5511987654321", "message": "Seu código Bate-Papo é 123456. Não compartilhe com ninguém."}
```

Qualquer resposta 2xx é sucesso. Basta um pequeno serviço que repasse para a API do seu provedor de SMS.

## LGPD

O desenho do servidor ajuda o controlador a cumprir a LGPD:

- **Minimização** (art. 6º, III): conteúdo cifrado de ponta a ponta; telefone em HMAC; sem log de IP.
- **Eliminação** (art. 18, VI): `DELETE /v1/me` apaga a conta e tudo associado.
- **Retenção limitada** (art. 15–16): mensagens são apagadas na entrega; o restante, após o prazo configurado.
- **Segurança** (art. 46): mesmo com o banco vazado, o conteúdo das conversas continua ilegível.

Quem hospeda continua sendo o controlador dos dados e deve manter sua própria política de privacidade, registro de operações e encarregado (DPO).

## Backups

Faça backup do PostgreSQL, do diretório de anexos e, **separadamente** e com cuidado redobrado, dos segredos:

- `BATEPAPO_PHONE_PEPPER`: se for perdido, ninguém consegue mais entrar pela conta do número;
- a chave secreta do PIN (`BATEPAPO_PIN_PEPPER` ou a chave do OpenBao): se for perdida, nenhum PIN confere mais e trocar de celular passa a exigir o código de recuperação.

Nunca guarde esses segredos junto com o backup do banco: a separação é o que protege os PINs se um backup vazar.
