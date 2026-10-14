# Bate-Papo — aplicativo móvel

App para Android e iOS em React Native ([Expo](https://expo.dev) SDK 57 + Expo Router).

## O que já funciona (fatia 1)

- Cadastro pelo número de celular, com código por SMS
- Perfil: nome e `@nome de usuário`
- Lista de conversas, com não lidas e aviso de "Conectando…"
- Nova conversa pelo `@nome de usuário`
- Conversa 1:1 de texto, cifrada de ponta a ponta, em tempo real; mensagens enviadas sem rede ficam marcadas e são reenviadas com um toque
- Aviso quando a chave de segurança de um contato muda
- Sair (apaga os dados do aparelho) e apagar a conta

Próximas fatias: fotos e áudio; grupos e tela do número de segurança (QR code); notificações push.

## Onde ficam os dados

| Dado | Onde |
| --- | --- |
| Chave do banco local (256 bits, aleatória) | Keychain (iOS) / Keystore (Android), só neste aparelho e fora dos backups |
| Chaves privadas, sessões criptográficas, histórico de conversas | Banco SQLite cifrado com **SQLCipher** |
| Nada disso | no servidor |

O backup do Android está desativado (`allowBackup: false`): as conversas existem só no aparelho.

## Rodando

O app usa módulos nativos (SQLCipher, SecureStore), então **não funciona no Expo Go**: é preciso um *development build*.

```sh
# Na raiz do repositório
npm ci
npm run build                     # compila @bate-papo/crypto e @bate-papo/client

# Servidor local (outro terminal): veja o README da raiz
docker compose up --build

# App
cd apps/mobile
cp .env.example .env.local        # ajuste o endereço do servidor
npx expo run:android              # ou: npx expo run:ios (macOS + Xcode)
```

Sem Android Studio/Xcode instalados, gere o *development build* na nuvem com `npx eas-cli@latest build --profile development`.

Em desenvolvimento, o servidor com `BATEPAPO_DEV_EXPOSE_OTP=true` devolve o código SMS e o app já o preenche.

- **Emulador Android:** o padrão `http://10.0.2.2:8080` aponta para o seu computador.
- **Celular físico:** use o IP do computador na rede local (ex.: `http://192.168.0.10:8080`).
- **Builds de produção** só aceitam HTTPS.

## Estrutura

```
index.ts               entrada: carrega o polyfill de aleatoriedade antes de tudo
src/app/               telas (Expo Router)
  (auth)/              entrar → código → perfil
  index.tsx            conversas
  nova.tsx             nova conversa
  chat/[id].tsx        conversa
  ajustes.tsx          perfil, sair, apagar conta
src/core/              regras do app em TypeScript puro (testadas no Node)
  service.ts           estado, cadastro, envio/recebimento
  history.ts           histórico local de conversas
  sql.ts, kv.ts        esquema do banco e armazenamento do SDK
src/platform/          ligação com o React Native: banco cifrado, configuração, contexto React
test/                  testes (Vitest + node:sqlite + servidor Go real)
```

## Verificações

```sh
npx tsc --noEmit                    # tipos
npx expo lint                       # lint
BATEPAPO_TEST_DATABASE_URL=postgres://localhost/batepapo_test npx vitest run   # testes
npx expo export --platform android  # gera o bundle (pega erros de import sem aparelho)
```

Os testes do `src/core` rodam no Node com `node:sqlite` no lugar do SQLCipher e conversam com o servidor Go de verdade: cadastro, conversa por `@nome`, tempo real, não lidas, reenvio sem rede, restaurar sessão e sair.
