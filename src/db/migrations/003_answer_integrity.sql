-- ============================================================================
-- 003_answer_integrity.sql
-- Bảo vệ tính toàn vẹn dữ liệu cho câu trả lời: chống nộp trùng & khóa ngoại option
-- ============================================================================

-- 1. Dọn dẹp câu trả lời trùng lặp nếu có trước khi áp đặt UNIQUE
DELETE FROM attempt_answers a USING attempt_answers b
WHERE a.id < b.id 
  AND a.attempt_id = b.attempt_id 
  AND a.question_index = b.question_index;

-- 2. Thêm UNIQUE(attempt_id, question_index)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_attempt_answers_attempt_qidx'
    ) THEN
        ALTER TABLE attempt_answers ADD CONSTRAINT uq_attempt_answers_attempt_qidx UNIQUE(attempt_id, question_index);
    END IF;
END $$;

-- 3. Xử lý selected_option_id không hợp lệ (nếu có dữ liệu cũ) trước khi tạo FK
UPDATE attempt_answers 
SET selected_option_id = NULL 
WHERE selected_option_id IS NOT NULL 
  AND selected_option_id NOT IN (SELECT id FROM question_options);

-- 4. Thêm FOREIGN KEY REFERENCES question_options(id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_attempt_answers_selected_option'
    ) THEN
        ALTER TABLE attempt_answers 
        ADD CONSTRAINT fk_attempt_answers_selected_option 
        FOREIGN KEY (selected_option_id) REFERENCES question_options(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attempt_answers_option_fk ON attempt_answers(selected_option_id);
