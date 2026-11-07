-- A PDF's pages as read (P2.2, after F4). A re-read overwrites a page; a page is never deleted, as its file isn't.
GRANT SELECT, INSERT, UPDATE ON TABLE source_file_page TO gem_app;
