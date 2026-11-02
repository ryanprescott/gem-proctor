-- P2.2.md §4. A PDF is soft-deleted, like a source: a revision made from it keeps pointing at it, so gem_app can't
-- delete the row.
GRANT SELECT, INSERT, UPDATE ON TABLE source_file TO gem_app;
