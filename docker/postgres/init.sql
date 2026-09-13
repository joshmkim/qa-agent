-- Runs once, on first start of an empty volume.
-- Separate database for the store contract tests (they truncate tables).
CREATE DATABASE qa_agent_test OWNER qa;
