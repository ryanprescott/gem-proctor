-- P1.5.md §4: gem_app reads and writes the LLM tables, except llm_call_log, which is append-only like
-- audit_log (the provenance record, SPEC §3B.4): SELECT and INSERT only.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE endpoint, role_assignment, llm_eval_run TO gem_app;
GRANT SELECT, INSERT ON TABLE llm_call_log TO gem_app;
