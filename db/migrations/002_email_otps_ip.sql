-- Step 2 database update. Run once in the Neon SQL Editor.
-- Lets the server limit how many email codes one device (IP) can request.
-- Safe to run more than once.
ALTER TABLE email_otps ADD COLUMN IF NOT EXISTS ip TEXT;
CREATE INDEX IF NOT EXISTS email_otps_ip ON email_otps (ip, created_at DESC);
