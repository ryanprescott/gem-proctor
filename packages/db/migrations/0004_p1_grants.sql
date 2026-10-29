-- P1.md §4: gem_app reads and writes the practice tables. 0002's GRANT ... ON ALL TABLES only covered the
-- tables that existed then, so each new table is granted explicitly; audit_log stays SELECT/INSERT only.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE practice_attempt, response TO gem_app;
