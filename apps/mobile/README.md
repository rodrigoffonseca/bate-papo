# Bate-Papo — aplicativo móvel

App para Android e iOS em React Native ([Expo](https://expo.dev) SDK 57 + Expo Router).

## O que já funciona

- Cadastro pelo número de celular, com código por SMS
- Perfil: nome e `@nome de usuário`
- Lista de conversas, com não lidas e aviso de "Conectando…"
- Nova conversa pelo `@nome de usuário`
- Conversa 1:1 de texto, cifrada de ponta a ponta, em tempo real; mensagens enviadas sem rede ficam marcadas e são reenviadas com um toque
- Aviso quando a chave de segurança de um contato muda
- Sair (apaga os dados do aparelho) e apagar a conta
- PIN contra clonagem de chip, código de recuperação e alertas (veja `docs/seguranca-da-conta.md`)
- **Fotos e vídeos** da câmera ou da galeria, com legenda:
  - fotos reduzidas a 1600 px e recomprimidas, o que também remove metadados como a localização;
  - vídeos de até 3 minutos e 60 MB;
  - miniatura cifrada dentro da mensagem;
  - tela cheia para ver foto e assistir vídeo.
- **Mensagens de voz:** toque no microfone para gravar e em ➤ para enviar, com player na conversa.
- **Download:** fotos e áudios de até 8 MB chegam já baixados; vídeos baixam com um toque, para economizar dados.
- **Mídia que falha sem rede** fica guardada e é reenviada com um toque, sem cifrar de novo.
- **Armazenamento** (em Ajustes):
  - espaço usado por fotos, vídeos e áudios, no total, por tipo e por conversa;
  - apagar por conversa, por tipo, a mídia antiga (mais de 30 ou 90 dias) ou tudo;
  - **limpeza automática** opcional (30, 90 ou 365 dias), executada ao abrir o app;
  - apagar um item direto da tela cheia.

  As mensagens continuam na conversa, e a mídia apagada pode ser baixada de novo enquanto o servidor ainda tiver o arquivo (até 30 dias). Mídia ainda não enviada nunca é apagada.

- **Grupos:** criar com nome e participantes (por @nome ou entre os contatos), conversar com texto, fotos, vídeos e voz, ver os participantes, adicionar e remover pessoas, tornar administrador, renomear e sair.
  - Cada entrada, saída, troca de nome ou de administrador aparece como aviso na conversa para todos. Quem entra não vê as mensagens anteriores.
  - O servidor avisa pelo WebSocket quando um grupo muda; ao reconectar, o app confere todos os grupos.
  - Quem sai ou é removido mantém o histórico no aparelho, mas não pode mais enviar.

- **Número de segurança:** na tela do contato (ⓘ na conversa, ou tocando em alguém no grupo), com os 60 dígitos e o QR code.
  - Ler com a câmera o código do celular da outra pessoa marca o contato como verificado (✅ na conversa).
  - Se a chave mudar depois, a conversa mostra um aviso até a verificação ser refeita.
- **Notificações sem conteúdo:** o aviso diz só "Você tem novas mensagens" (ou "Alerta de segurança na sua conta"). Liga e desliga em Ajustes.
  - Usa o token FCM (Android) ou APNs (iOS) do próprio aparelho, sem passar pelo serviço de push da Expo.
  - No Android, o build precisa do Firebase: coloque o `google-services.json` do seu projeto e aponte `android.googleServicesFile` no `app.json`. Sem ele, o app funciona e mostra as notificações como indisponíveis.
  - O servidor já aceita UnifiedPush (Android sem Google); falta o módulo nativo no app.

Próximas fatias: UnifiedPush no app; assinatura das mudanças de grupo pelos administradores.

## Onde ficam os dados

| Dado | Onde |
| --- | --- |
| Chave do banco local (256 bits, aleatória) | Keychain (iOS) / Keystore (Android), só neste aparelho e fora dos backups |
| Chaves privadas, sessões criptográficas, histórico de conversas e chaves das mídias | Banco SQLite cifrado com **SQLCipher** |
| Fotos, vídeos e áudios | Pasta do app, **ainda cifrados** (a mesma cópia cifrada que trafega pelo servidor) |
| Vídeo ou áudio sendo reproduzido | Cópia decifrada temporária no cache do app, apagada ao sair da tela e a cada abertura do app |
| Fotos na tela | Decifradas só na memória |
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

Sem Android Studio/Xcode instalados, ou para instalar em celulares de outras pessoas, gere o app na nuvem com o EAS (perfis `preview` e `production` em `eas.json`). O passo a passo, com APK por link no Android e TestFlight no iPhone, está no [guia de testes](../../docs/guia-de-testes.md).

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
