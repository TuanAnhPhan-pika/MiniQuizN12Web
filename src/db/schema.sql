-- ============================================================================
-- PRODUCTION-READY DATABASE SCHEMA FOR MINI QUIZ CLASSROOM
-- PostgreSQL / Supabase
-- ============================================================================

-- Bật extension pgcrypto (hỗ trợ sinh UUID nếu cần)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. USERS & PROFILES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    username_lower VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    last_name_change_at BIGINT DEFAULT 0,
    last_password_change_at BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(username_lower);

-- Quản lý Session lưu trong PostgreSQL (không dùng local file JSON)
CREATE TABLE IF NOT EXISTS user_sessions (
    token VARCHAR(128) PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_username ON user_sessions(username);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

-- Bảng hồ sơ chi tiết (Profiles)
CREATE TABLE IF NOT EXISTS profiles (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    username VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    avatar VARCHAR(100) DEFAULT '01',
    bio TEXT DEFAULT '',
    role VARCHAR(30) DEFAULT 'teacher', -- teacher, student, admin
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);

-- ----------------------------------------------------------------------------
-- 2. ORGANIZATIONS & MEMBERS (Mở rộng cho trường học / trung tâm)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(30) DEFAULT 'member', -- owner, admin, teacher, member
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(organization_id, user_id)
);

-- ----------------------------------------------------------------------------
-- 3. TAXONOMY: SUBJECTS, TOPICS, TAGS (Ngân hàng câu hỏi theo môn/chủ đề)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subjects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    code VARCHAR(50) UNIQUE,
    description TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS topics (
    id SERIAL PRIMARY KEY,
    subject_id INT REFERENCES subjects(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    description TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_topics_subject_id ON topics(subject_id);

CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 4. QUESTION BANK & VERSIONING
-- Câu hỏi độc lập, có thể tái sử dụng qua nhiều Quiz.
-- Khi sửa nội dung, tạo version mới để không ảnh hưởng lịch sử bài thi đã thi.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
    id VARCHAR(100) PRIMARY KEY, -- UUID hoặc string format q-timestamp
    owner_id VARCHAR(50) DEFAULT 'system',
    subject_id INT REFERENCES subjects(id) ON DELETE SET NULL,
    topic_id INT REFERENCES topics(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_questions_owner_id ON questions(owner_id);
CREATE INDEX IF NOT EXISTS idx_questions_subject_id ON questions(subject_id);

CREATE TABLE IF NOT EXISTS question_versions (
    id VARCHAR(120) PRIMARY KEY, -- q-id-v1, q-id-v2,...
    question_id VARCHAR(100) REFERENCES questions(id) ON DELETE CASCADE,
    version INT NOT NULL DEFAULT 1,
    content TEXT NOT NULL,
    explanation TEXT DEFAULT '',
    difficulty VARCHAR(30) DEFAULT 'medium', -- easy, medium, hard
    image_url TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(question_id, version)
);
CREATE INDEX IF NOT EXISTS idx_question_versions_question_id ON question_versions(question_id);

CREATE TABLE IF NOT EXISTS question_options (
    id VARCHAR(140) PRIMARY KEY,
    question_version_id VARCHAR(120) REFERENCES question_versions(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL DEFAULT false,
    order_index INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_question_options_version ON question_options(question_version_id);

CREATE TABLE IF NOT EXISTS question_tags (
    question_id VARCHAR(100) REFERENCES questions(id) ON DELETE CASCADE,
    tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (question_id, tag_id)
);

-- ----------------------------------------------------------------------------
-- 5. QUIZZES & MAPPING
-- Quiz ánh xạ sang question_versions qua bảng quiz_questions.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quizzes (
    id VARCHAR(100) PRIMARY KEY,
    code VARCHAR(50) NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    subject VARCHAR(100) DEFAULT '',
    author VARCHAR(100) DEFAULT '',
    time_per_q INT DEFAULT 15,
    points_per_q INT DEFAULT 100,
    is_public BOOLEAN DEFAULT false,
    owner_id VARCHAR(50) DEFAULT '',
    parent_code VARCHAR(50) DEFAULT '',
    copies_issued INT DEFAULT 0,
    shared_by VARCHAR(100) DEFAULT '',
    shared_at VARCHAR(100) DEFAULT '',
    created_at VARCHAR(100) DEFAULT '',
    updated_at VARCHAR(100) DEFAULT '',
    created_timestamp BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_quizzes_owner_id ON quizzes(owner_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_is_public ON quizzes(is_public);
CREATE INDEX IF NOT EXISTS idx_quizzes_code ON quizzes(code);

CREATE TABLE IF NOT EXISTS quiz_questions (
    id VARCHAR(120) PRIMARY KEY,
    quiz_id VARCHAR(100) REFERENCES quizzes(id) ON DELETE CASCADE,
    question_version_id VARCHAR(120) REFERENCES question_versions(id) ON DELETE CASCADE,
    order_index INT NOT NULL,
    points INT DEFAULT 100,
    time_limit INT DEFAULT 15,
    UNIQUE(quiz_id, order_index)
);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz_id ON quiz_questions(quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_version ON quiz_questions(question_version_id);

-- ----------------------------------------------------------------------------
-- 6. MULTIPLAYER ROOMS: GAME SESSIONS & PLAYERS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_sessions (
    id VARCHAR(100) PRIMARY KEY,
    quiz_id VARCHAR(100) REFERENCES quizzes(id) ON DELETE SET NULL,
    host_id VARCHAR(50) NOT NULL,
    room_code VARCHAR(20) NOT NULL,
    room_title TEXT NOT NULL,
    status VARCHAR(30) DEFAULT 'waiting', -- waiting, countdown, started, finished, closed
    capacity INT DEFAULT 40,
    is_locked BOOLEAN DEFAULT false,
    total_players INT DEFAULT 0,
    started_at BIGINT,
    ended_at BIGINT,
    formatted_time VARCHAR(100) DEFAULT '',
    stats JSONB DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_game_sessions_room_code ON game_sessions(room_code);
CREATE INDEX IF NOT EXISTS idx_game_sessions_host_id ON game_sessions(host_id);
CREATE INDEX IF NOT EXISTS idx_game_sessions_created_at ON game_sessions(created_at);

CREATE TABLE IF NOT EXISTS game_players (
    id VARCHAR(100) PRIMARY KEY,
    game_session_id VARCHAR(100) REFERENCES game_sessions(id) ON DELETE CASCADE,
    user_id VARCHAR(50),
    nickname VARCHAR(100) NOT NULL,
    avatar VARCHAR(50) DEFAULT '01',
    final_score INT DEFAULT 0,
    rank INT DEFAULT 0,
    correct_count INT DEFAULT 0,
    wrong_count INT DEFAULT 0,
    joined_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    finished_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_game_players_session ON game_players(game_session_id);
CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);

-- ----------------------------------------------------------------------------
-- 7. ATTEMPTS & GRANULAR ANSWERS
-- Lịch sử làm bài phân tách rõ ràng từng câu trả lời thay vì 1 JSON answers_detail.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attempts (
    id VARCHAR(100) PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL, -- username hoặc id
    quiz_id VARCHAR(100) REFERENCES quizzes(id) ON DELETE SET NULL,
    game_session_id VARCHAR(100) REFERENCES game_sessions(id) ON DELETE SET NULL,
    pin VARCHAR(50) DEFAULT '',
    room_title TEXT DEFAULT '',
    exam_title TEXT DEFAULT '',
    score INT DEFAULT 0,
    max_score INT DEFAULT 0,
    correct_count INT DEFAULT 0,
    wrong_count INT DEFAULT 0,
    unanswered_count INT DEFAULT 0,
    total_questions INT DEFAULT 0,
    ratio_pct INT DEFAULT 0,
    total_time_ms BIGINT DEFAULT 0,
    formatted_time VARCHAR(100) DEFAULT '',
    started_at BIGINT,
    finished_at BIGINT,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_attempts_user_created ON attempts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_quiz_id ON attempts(quiz_id);

CREATE TABLE IF NOT EXISTS attempt_answers (
    id BIGSERIAL PRIMARY KEY,
    attempt_id VARCHAR(100) REFERENCES attempts(id) ON DELETE CASCADE,
    question_version_id VARCHAR(120) REFERENCES question_versions(id) ON DELETE SET NULL,
    question_index INT NOT NULL,
    selected_option_id VARCHAR(140),
    user_choice INT DEFAULT -1,
    is_correct BOOLEAN NOT NULL DEFAULT false,
    response_time_ms INT DEFAULT 0,
    score_awarded INT DEFAULT 0,
    streak_before INT DEFAULT 0,
    streak_after INT DEFAULT 0,
    answered_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_attempt_answers_attempt ON attempt_answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_attempt_answers_q_version ON attempt_answers(question_version_id);

-- ----------------------------------------------------------------------------
-- 8. ANALYTICS & MASTERY
-- Thống kê độ khó, tỷ lệ đúng của câu hỏi và năng lực của từng học sinh
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_statistics (
    question_id VARCHAR(100) PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
    total_attempts INT DEFAULT 0,
    correct_attempts INT DEFAULT 0,
    avg_response_time_ms INT DEFAULT 0,
    accuracy_pct NUMERIC(5, 2) DEFAULT 0.00,
    last_calculated_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS user_topic_mastery (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    topic_id INT REFERENCES topics(id) ON DELETE SET NULL,
    subject VARCHAR(100) NOT NULL,
    questions_attempted INT DEFAULT 0,
    questions_correct INT DEFAULT 0,
    mastery_score NUMERIC(5, 2) DEFAULT 0.00,
    updated_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    UNIQUE(username, subject)
);
CREATE INDEX IF NOT EXISTS idx_user_topic_mastery_user ON user_topic_mastery(username);

-- ----------------------------------------------------------------------------
-- 9. FOUNDATIONS FOR FUTURE EXTENSIONS (AI, DOCS, AUDIT)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    file_path TEXT,
    content_text TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(50) NOT NULL,
    status VARCHAR(30) DEFAULT 'pending', -- pending, processing, completed, failed
    prompt TEXT,
    result_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_question_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_version_id VARCHAR(120) REFERENCES question_versions(id) ON DELETE CASCADE,
    review_score INT,
    feedback TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(50),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id VARCHAR(100),
    ip_address VARCHAR(45),
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);

-- ----------------------------------------------------------------------------
-- 10. CẤP QUYỀN TRUY CẬP CHO SUPABASE & POSTGRESQL (ROLES & PERMISSIONS)
-- Cho phép Server Backend (service_role) và Client API đọc/ghi trơn tru
-- ----------------------------------------------------------------------------
DO $$ 
DECLARE
    r RECORD;
    role_name TEXT;
BEGIN
    -- Tắt RLS để Server Backend toàn quyền kiểm soát dữ liệu
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'ALTER TABLE public.' || quote_ident(r.tablename) || ' DISABLE ROW LEVEL SECURITY;';
    END LOOP;

    -- Cấp quyền nếu chạy trên Supabase (có các role anon, authenticated, service_role)
    FOR role_name IN SELECT unnest(ARRAY['anon', 'authenticated', 'service_role']) LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE 'GRANT USAGE ON SCHEMA public TO ' || quote_ident(role_name);
            EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA public TO ' || quote_ident(role_name);
            EXECUTE 'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ' || quote_ident(role_name);
            EXECUTE 'GRANT ALL ON ALL ROUTINES IN SCHEMA public TO ' || quote_ident(role_name);
        END IF;
    END LOOP;
END $$;

