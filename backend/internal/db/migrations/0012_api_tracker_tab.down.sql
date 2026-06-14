ALTER TABLE api_tracker_pins
    DROP CONSTRAINT IF EXISTS api_tracker_pins_unique_source;

ALTER TABLE api_tracker_pins
    ADD CONSTRAINT api_tracker_pins_root_path_destination_subdir_api_base_url_tracker_id_key
    UNIQUE (root_path, destination_subdir, api_base_url, tracker_id);

ALTER TABLE api_tracker_pins
    DROP COLUMN IF EXISTS tab;
