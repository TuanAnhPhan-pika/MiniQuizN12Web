-- ============================================================================
-- 005_user_topic_mastery.sql
-- Chuẩn hóa user_topic_mastery: liên kết user_id và unique(user_id, subject, topic_id)
-- ============================================================================

-- 1. Thêm user_id FK
ALTER TABLE user_topic_mastery ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

-- Backfill user_id
UPDATE user_topic_mastery utm 
SET user_id = u.id 
FROM users u 
WHERE LOWER(utm.username) = u.username_lower 
  AND utm.user_id IS NULL;

-- 2. Xóa constraint cũ UNIQUE(username, subject)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_topic_mastery_username_subject_key'
    ) THEN
        ALTER TABLE user_topic_mastery DROP CONSTRAINT user_topic_mastery_username_subject_key;
    END IF;
END $$;

-- 3. Dọn dẹp bản ghi trùng lặp trước khi đặt UNIQUE mới
DELETE FROM user_topic_mastery a USING user_topic_mastery b
WHERE a.id < b.id 
  AND a.user_id = b.user_id 
  AND a.subject = b.subject 
  AND (a.topic_id = b.topic_id OR (a.topic_id IS NULL AND b.topic_id IS NULL));

-- 4. Thêm constraint mới
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_user_topic_mastery_user_subject_topic'
    ) THEN
        ALTER TABLE user_topic_mastery 
        ADD CONSTRAINT uq_user_topic_mastery_user_subject_topic 
        UNIQUE(user_id, subject, topic_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_topic_mastery_user_id ON user_topic_mastery(user_id);
