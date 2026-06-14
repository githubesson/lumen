ALTER TABLE api_tracker_pins
    ADD COLUMN IF NOT EXISTS tab TEXT NOT NULL DEFAULT '';

DO $$
DECLARE
    old_constraint text;
BEGIN
    SELECT conname INTO old_constraint
    FROM pg_constraint
    WHERE conrelid = 'api_tracker_pins'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (root_path, destination_subdir, api_base_url, tracker_id)';

    IF old_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE api_tracker_pins DROP CONSTRAINT %I', old_constraint);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'api_tracker_pins'::regclass
          AND conname = 'api_tracker_pins_unique_source'
    ) THEN
        ALTER TABLE api_tracker_pins
            ADD CONSTRAINT api_tracker_pins_unique_source
            UNIQUE (root_path, destination_subdir, api_base_url, tracker_id, tab);
    END IF;
END $$;
