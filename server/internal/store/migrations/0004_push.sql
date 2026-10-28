-- Notificações push sem conteúdo: um token por conta (um aparelho por conta).
-- kind: 'fcm' (Android), 'apns' (iOS) ou 'unifiedpush' (endereço do distribuidor).
CREATE TABLE push_tokens (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    token      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
