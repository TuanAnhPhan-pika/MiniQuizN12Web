-- ========================================================
-- Schema SQL cho Mini Quiz Classroom trên Supabase (PostgreSQL)
-- Hướng dẫn: Mở Supabase Dashboard -> Vào mục "SQL Editor" -> Dán toàn bộ script này và bấm "Run"
-- ========================================================

-- 1. Bảng tài khoản người dùng
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

CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (username_lower);

-- 2. Bảng đề thi (Lưu trữ cả đề Public hệ thống và đề Private của từng giáo viên)
CREATE TABLE IF NOT EXISTS exams (
    id VARCHAR(100) PRIMARY KEY,
    code VARCHAR(50) NOT NULL,
    title TEXT NOT NULL,
    subject VARCHAR(100) DEFAULT '',
    author VARCHAR(100) DEFAULT '',
    time_per_q INT DEFAULT 15,
    points_per_q INT DEFAULT 100,
    description TEXT DEFAULT '',
    questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_public BOOLEAN DEFAULT false,
    owner_username VARCHAR(50) DEFAULT '',
    parent_code VARCHAR(50) DEFAULT '',
    copies_issued INT DEFAULT 0,
    shared_by VARCHAR(100) DEFAULT '',
    shared_at VARCHAR(100) DEFAULT '',
    created_at VARCHAR(100) DEFAULT '',
    updated_at VARCHAR(100) DEFAULT '',
    created_timestamp BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_exams_is_public ON exams (is_public);
CREATE INDEX IF NOT EXISTS idx_exams_owner ON exams (owner_username);
CREATE INDEX IF NOT EXISTS idx_exams_code ON exams (code);

-- 3. Bảng lịch sử làm bài thi của học sinh/thí sinh
CREATE TABLE IF NOT EXISTS user_history (
    id VARCHAR(100) PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    pin VARCHAR(50) DEFAULT '',
    room_title TEXT DEFAULT '',
    exam_title TEXT DEFAULT '',
    score INT DEFAULT 0,
    correct_count INT DEFAULT 0,
    total_questions INT DEFAULT 0,
    ratio_pct INT DEFAULT 0,
    formatted_time VARCHAR(100) DEFAULT '',
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    answers_detail JSONB DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_user_history_username ON user_history (username);

-- 4. Bảng lịch sử phòng thi do giáo viên / Host tổ chức
CREATE TABLE IF NOT EXISTS hosted_rooms (
    id VARCHAR(100) PRIMARY KEY,
    pin VARCHAR(50) NOT NULL,
    host_username VARCHAR(50) NOT NULL,
    room_title TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    finished_at BIGINT NOT NULL,
    formatted_time VARCHAR(100) DEFAULT '',
    stats JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_hosted_rooms_host ON hosted_rooms (host_username);

-- Bật Row Level Security (RLS) & cấp quyền truy cập cơ bản
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_rooms ENABLE ROW LEVEL SECURITY;

-- Tạo chính sách cho phép truy cập qua API Server Key / Anon Key
CREATE POLICY "Allow service and anon read write on users" ON users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service and anon read write on exams" ON exams FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service and anon read write on user_history" ON user_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service and anon read write on hosted_rooms" ON hosted_rooms FOR ALL USING (true) WITH CHECK (true);
