-- ============================================================================
-- 004_soft_delete_and_status.sql
-- Thêm Soft Delete (deleted_at, status) và chuẩn hóa timestamps
-- ============================================================================

-- 1. Quizzes soft delete
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE NULL;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_quizzes_deleted_at ON quizzes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_quizzes_status ON quizzes(status);

-- 2. Questions soft delete
ALTER TABLE questions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_questions_deleted_at ON questions(deleted_at);

-- 3. Game sessions soft delete & timestamps
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE NULL;
CREATE INDEX IF NOT EXISTS idx_game_sessions_deleted_at ON game_sessions(deleted_at);
