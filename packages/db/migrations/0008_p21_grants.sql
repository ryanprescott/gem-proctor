-- P2.1.md §4: verification_run is provenance, append-only like audit_log and llm_call_log (SELECT and INSERT only).
-- verification_job is an ordinary working table.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE verification_job TO gem_app;
GRANT SELECT, INSERT ON TABLE verification_run TO gem_app;
