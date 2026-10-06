-- ============================================================================
-- 002_user_relationships.sql
-- Chuẩn hóa quan hệ người dùng với users.id (BIGINT) thay vì chỉ dùng VARCHAR username
-- ============================================================================

-- 1. Quizzes
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS owner_username_snapshot VARCHAR(50);

-- Backfill quizzes
UPDATE quizzes q 
SET owner_user_id = u.id, 
    owner_username_snapshot = q.owner_id
FROM users u 
WHERE LOWER(q.owner_id) = u.username_lower 
  AND q.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_quizzes_owner_user_id ON quizzes(owner_user_id);

-- 2. Questions
ALTER TABLE questions ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS owner_username_snapshot VARCHAR(50);

UPDATE questions q 
SET owner_user_id = u.id, 
    owner_username_snapshot = q.owner_id
FROM users u 
WHERE LOWER(q.owner_id) = u.username_lower 
  AND q.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_questions_owner_user_id ON questions(owner_user_id);

-- 3. Game Sessions
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS host_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS host_username_snapshot VARCHAR(50);

UPDATE game_sessions gs 
SET host_user_id = u.id,
    host_username_snapshot = gs.host_id
FROM users u 
WHERE LOWER(gs.host_id) = u.username_lower 
  AND gs.host_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_game_sessions_host_user_id ON game_sessions(host_user_id);

-- 4. Game Players (Registered user link)
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS account_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS username_snapshot VARCHAR(50);

UPDATE game_players gp
SET account_user_id = u.id,
    username_snapshot = gp.user_id
FROM users u
WHERE gp.user_id IS NOT NULL 
  AND LOWER(gp.user_id) = u.username_lower 
  AND gp.account_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_game_players_account_user_id ON game_players(account_user_id);

-- 5. Attempts
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS account_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS username_snapshot VARCHAR(50);

UPDATE attempts a
SET account_user_id = u.id,
    username_snapshot = a.user_id
FROM users u
WHERE LOWER(a.user_id) = u.username_lower 
  AND a.account_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_attempts_account_user_id ON attempts(account_user_id);

-- 6. Documents
ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

UPDATE documents d
SET owner_user_id = u.id
FROM users u
WHERE LOWER(d.owner_id) = u.username_lower 
  AND d.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_owner_user_id ON documents(owner_user_id);

-- 7. AI Generation Jobs
ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS account_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

UPDATE ai_generation_jobs j
SET account_user_id = u.id
FROM users u
WHERE LOWER(j.user_id) = u.username_lower 
  AND j.account_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_account_user_id ON ai_generation_jobs(account_user_id);
