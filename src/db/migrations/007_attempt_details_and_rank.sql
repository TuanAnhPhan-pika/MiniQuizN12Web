-- Migration 007: Thêm các cột rank, total_players, details (JSONB) cho bảng attempts
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS rank INT DEFAULT 1;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS total_players INT DEFAULT 1;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS details JSONB;
