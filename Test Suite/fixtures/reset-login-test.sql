-- ============================================================================
-- Đặt lại dữ liệu phiên đăng nhập thử về trạng thái ban đầu (0 phiên)
-- Chạy trước mỗi ca kiểm thử TC01, TC02, TC03.
-- ============================================================================

DELETE FROM user_sessions
WHERE LOWER(username) = 'student_demo';

SELECT COUNT(*)::INT AS remaining_test_sessions
FROM user_sessions
WHERE LOWER(username) = 'student_demo';
