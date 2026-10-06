-- ============================================================================
-- 006_permissions_hardening.sql
-- Thu hồi các quyền cấp thừa cho các role công khai (anon, authenticated)
-- ============================================================================

DO $$ 
DECLARE
    role_name TEXT;
BEGIN
    FOR role_name IN SELECT unnest(ARRAY['anon', 'authenticated']) LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ' || quote_ident(role_name);
            EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ' || quote_ident(role_name);
            EXECUTE 'REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM ' || quote_ident(role_name);
            EXECUTE 'REVOKE USAGE ON SCHEMA public FROM ' || quote_ident(role_name);
        END IF;
    END LOOP;
END $$;
