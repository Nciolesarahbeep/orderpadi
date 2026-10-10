// One shared database connection for every API file.
// Usage in an api/ file:
//   const { sql } = require('../lib/db');
//   const rows = await sql`SELECT * FROM vendors WHERE id = ${id}`;
const { neon } = require('@neondatabase/serverless');

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// neon() throws if the URL is missing, so stay null and let callers report it.
const sql = url ? neon(url) : null;

module.exports = { sql };
