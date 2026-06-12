DROP INDEX IF EXISTS artists_name_lower_uniq;
ALTER TABLE artists ADD CONSTRAINT artists_name_key UNIQUE (name);
