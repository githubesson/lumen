UPDATE api_tracker_pins
SET api_base_url = 'https://trackers.misleadi.ng/api'
WHERE api_base_url = 'https://trackers.musicfiles.su/api';

ALTER TABLE api_tracker_pins
    ALTER COLUMN api_base_url SET DEFAULT 'https://trackers.misleadi.ng/api';
