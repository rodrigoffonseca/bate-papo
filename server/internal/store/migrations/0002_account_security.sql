-- Segurança da conta: bloqueio de registro com PIN, código de recuperação,
-- alertas ao aparelho legítimo e expiração de sessões por inatividade.

-- Última atividade da conta: o bloqueio por PIN deixa de valer se o
-- aparelho registrado ficar inativo por muito tempo (dono perdeu o PIN).
ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE registration_locks (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Argon2id(PIN, sal). O PIN em si nunca é armazenado.
    pin_hash        BYTEA NOT NULL,
    pin_salt        BYTEA NOT NULL,
    -- SHA-256 do código de recuperação (120 bits aleatórios).
    recovery_hash   BYTEA NOT NULL,
    -- Tentativas erradas de PIN desde a última definição do PIN.
    failed_attempts INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Desafios de desbloqueio: emitidos quando alguém confirma o código SMS de
-- uma conta protegida por PIN. Provam que o SMS foi confirmado há pouco.
CREATE TABLE unlock_challenges (
    token_hash BYTEA PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone_hash BYTEA NOT NULL,
    attempts   INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL
);

-- Alertas de segurança para o dono da conta (ex.: alguém confirmou o código
-- SMS do seu número em outro aparelho).
CREATE TABLE account_alerts (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_alerts_user_idx ON account_alerts(user_id, created_at);
