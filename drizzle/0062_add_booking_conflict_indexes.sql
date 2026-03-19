CREATE INDEX IF NOT EXISTS idx_booking_requests_reqdate_status ON booking_requests (request_date, status);
CREATE INDEX IF NOT EXISTS idx_booking_participants_session_invite ON booking_participants (session_id, invite_status);
