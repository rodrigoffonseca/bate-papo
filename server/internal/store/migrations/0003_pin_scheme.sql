-- Fase 2a: o hash do PIN passa a incluir uma chave secreta fora do banco
-- (HMAC(chave, Argon2id(PIN))). pin_scheme diz como o hash foi calculado:
--   'argon2id'            → formato antigo, sem chave (convertido no próximo acerto);
--   'argon2id+<chave>'    → com a chave identificada (ex.: 'argon2id+local:ab12…',
--                           'argon2id+transit:transit/batepapo-pin').
ALTER TABLE registration_locks ADD COLUMN pin_scheme TEXT NOT NULL DEFAULT 'argon2id';
