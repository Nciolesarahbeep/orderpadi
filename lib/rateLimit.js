// Login lockout, ported from Apex Horizon Bank: 5 wrong passwords for the
// same email, or from the same IP, within 15 minutes blocks further tries
// until the window clears.
const { sql } = require('./db');

const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;

async function checkLoginRateLimit({ email, ip }) {
  const rows = await sql`
    SELECT created_at FROM login_attempts
    WHERE success = FALSE
      AND created_at > now() - make_interval(mins => ${WINDOW_MINUTES})
      AND (email = ${email} OR ip = ${ip})
    ORDER BY created_at ASC
  `;
  if (rows.length < MAX_FAILURES) return { blocked: false };

  // The oldest of the failures that tipped it over decides when it clears.
  const oldest = new Date(rows[rows.length - MAX_FAILURES].created_at).getTime();
  const unlockAt = oldest + WINDOW_MINUTES * 60 * 1000;
  return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((unlockAt - Date.now()) / 1000)) };
}

async function recordLoginAttempt({ email, ip, success }) {
  await sql`INSERT INTO login_attempts (email, ip, success) VALUES (${email}, ${ip}, ${success})`;
}

// After a password reset the owner has proved they control the email, so
// wrong guesses made by someone else shouldn't keep them locked out.
// The failed tries stay on record by IP, so the device that made them is
// still blocked; only the lock on the email itself is lifted.
async function clearLoginFailures(email) {
  await sql`UPDATE login_attempts SET email = NULL WHERE email = ${email} AND success = FALSE`;
}

// Keeps the table small. Called now and then, never awaited by a login.
async function pruneOldAttempts() {
  await sql`DELETE FROM login_attempts WHERE created_at < now() - interval '1 day'`;
}

module.exports = { checkLoginRateLimit, recordLoginAttempt, clearLoginFailures, pruneOldAttempts };
