ALTER TABLE camera_check_requests ADD COLUMN source_event_id uuid REFERENCES proctor_events(id);
CREATE INDEX camera_checks_source_event ON camera_check_requests(source_event_id);
