-- ============================================================================
-- Seed dữ liệu thử cho chức năng Đăng nhập (Login Flow: TC01 - TC03)
-- Chạy bằng psql "$DATABASE_URL" -f scripts/seed-login-test.sql
-- hoặc dán vào Supabase SQL Editor.
-- Tài khoản thử (synthetic): student_demo / Pass123456!
-- ============================================================================

INSERT INTO users (
    username,
    username_lower,
    display_name,
    password_hash,
    salt,
    created_at,
    last_name_change_at,
    last_password_change_at
)
VALUES (
    'student_demo',
    'student_demo',
    'Sinh viên Demo',
    '182f74601601e4188f426c81c36cbf12919f8c7a25fd0188fefd634ea29012558754816f383dcbb49d7711c19fe10143a863b6df9571da15baf49f719eb5c3f4',
    'e907bf8186544038a71f3483b6b70620',
    (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    0,
    0
)
ON CONFLICT (username_lower) DO UPDATE
SET
    display_name = EXCLUDED.display_name,
    password_hash = EXCLUDED.password_hash,
    salt = EXCLUDED.salt;

INSERT INTO profiles (user_id, username, display_name, avatar, role)
SELECT id, username, display_name, '01', 'student'
FROM users
WHERE username_lower = 'student_demo'
ON CONFLICT (username) DO UPDATE
SET
    user_id = EXCLUDED.user_id,
    display_name = EXCLUDED.display_name,
    role = EXCLUDED.role;

-- Xóa các phiên cũ của tài khoản thử để bắt đầu kiểm thử ở trạng thái sạch (0 phiên)
DELETE FROM user_sessions
WHERE LOWER(username) = 'student_demo';

-- Kiểm tra trạng thái sau seed
SELECT id, username, display_name FROM users WHERE username_lower = 'student_demo';
SELECT COUNT(*)::INT AS active_test_sessions FROM user_sessions WHERE LOWER(username) = 'student_demo';
