-- P2.md §4. Working tables get the usual grants. question_event, validation_result and retrieval_log are the
-- provenance record, append-only like audit_log and verification_run (SELECT and INSERT only).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  source, source_revision, source_section,
  authoring_session, authoring_session_source, objective, revision, authoring_batch, draft_question
TO gem_app;
GRANT SELECT, INSERT ON TABLE question_event, validation_result, retrieval_log TO gem_app;

-- Chunks are immutable (SPEC §3C.2): only the embedding, the endpoint's token count and the flag can change, by
-- column grant. Everything a citation depends on stays out of reach.
GRANT SELECT, INSERT ON TABLE source_chunk TO gem_app;
GRANT UPDATE (embedding, embedding_model, token_count, flagged_at, flag_reason) ON TABLE source_chunk TO gem_app;
