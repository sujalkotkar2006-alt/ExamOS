ALTER TABLE exam_attempts ADD COLUMN paused_at timestamptz;
ALTER TABLE exam_attempts ADD COLUMN control_reason text NOT NULL DEFAULT '';
CREATE TABLE exam_controls(
 id uuid PRIMARY KEY,
 teacher_id uuid NOT NULL REFERENCES teachers(id),
 attempt_id uuid NOT NULL REFERENCES exam_attempts(id),
 session_id uuid NOT NULL REFERENCES sessions(id),
 device_id uuid NOT NULL REFERENCES devices(id),
 action text NOT NULL CHECK(action IN ('pause','resume','end')),
 reason text NOT NULL,
 incident_id uuid REFERENCES proctor_events(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exam_controls_attempt_time ON exam_controls(attempt_id,created_at);
