-- Nullable until a successful ingest confirms both the file and its metadata.
ALTER TABLE tracks ADD COLUMN ingested_file_size BIGINT;
ALTER TABLE tracks ADD COLUMN ingested_mtime_ns BIGINT;
ALTER TABLE tracks ADD COLUMN ingested_file_path TEXT;
