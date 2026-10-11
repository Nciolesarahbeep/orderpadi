// One shared database connection for every API file.
// Usage in an api/ file:
//   const { sql } = require('../lib/db');
//   const rows = await sql`SELECT * FROM vendors WHERE id = ${id}`;
//
// Talks to Neon over HTTPS with plain fetch (Neon's SQL-over-HTTP endpoint,
// the same one @neondatabase/serverless uses), so the server needs no npm
// packages and deploys anywhere. Values always travel as query parameters
// ($1, $2, ...), never pasted into the SQL text.

// Read the connection string when a query runs, not when the file loads:
// some hosts (Netlify) fill in environment variables per request.
function connectionString() {
  const netlify = globalThis.Netlify && globalThis.Netlify.env;
  return process.env.DATABASE_URL || process.env.POSTGRES_URL ||
    (netlify && (netlify.get('DATABASE_URL') || netlify.get('POSTGRES_URL'))) || '';
}

// Postgres sends every value as text; turn the common types back into
// JavaScript values the way the Neon driver does. Anything else (bigint,
// numeric, text, uuid, ...) stays a string.
function parseTimestamp(text, withZone) {
  let iso = text.replace(' ', 'T');
  if (withZone) iso = iso.replace(/([+-]\d\d)$/, '$1:00');
  else iso += 'Z';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? text : date;
}

function parseValue(text, typeId) {
  if (text === null || text === undefined) return null;
  switch (typeId) {
    case 16: return text === 't' || text === 'true';          // boolean
    case 21: case 23: case 26: return parseInt(text, 10);     // smallint, integer, oid
    case 700: case 701: return parseFloat(text);              // real, double
    case 114: case 3802: return JSON.parse(text);             // json, jsonb
    case 1114: return parseTimestamp(text, false);            // timestamp
    case 1184: return parseTimestamp(text, true);             // timestamptz
    default: return text;
  }
}

// How a JavaScript value is sent as a parameter (same rules as node-postgres).
function prepareValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function endpoints(connectionString) {
  const host = new URL(connectionString).hostname;
  // The Neon driver sends queries to api.<region host>; the endpoint's own
  // hostname answers too, so it's the fallback.
  const list = [`https://${host.replace(/^[^.]+\./, 'api.')}/sql`, `https://${host}/sql`];
  if (process.env.NEON_HTTP_ENDPOINT) list.unshift(process.env.NEON_HTTP_ENDPOINT); // local tests
  return [...new Set(list)];
}

class DatabaseError extends Error {}

function makeSql(connectionString) {
  const urls = endpoints(connectionString);
  let working = null; // the endpoint that answered last time

  async function post(body) {
    const order = working ? [working, ...urls.filter((u) => u !== working)] : urls;
    let lastError = null;
    for (const endpoint of order) {
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Neon-Connection-String': connectionString,
            'Neon-Raw-Text-Output': 'true',
            'Neon-Array-Mode': 'true'
          },
          body: JSON.stringify(body)
        });
      } catch (err) {
        lastError = new DatabaseError(`Could not reach the database (${err.message})`);
        continue;
      }
      if (response.status === 404) {
        lastError = new DatabaseError(`The database endpoint ${endpoint} was not found`);
        continue;
      }
      working = endpoint;
      let data = null;
      const text = await response.text();
      try { data = JSON.parse(text); } catch (err) { data = null; }
      if (!response.ok) {
        const error = new DatabaseError((data && data.message) || `Database error (HTTP ${response.status}): ${text.slice(0, 200)}`);
        if (data) {
          for (const field of ['code', 'detail', 'hint', 'constraint', 'table', 'column', 'severity', 'position']) {
            if (data[field] !== undefined) error[field] = data[field];
          }
        }
        throw error;
      }
      return data;
    }
    throw lastError || new DatabaseError('Could not reach the database');
  }

  return async function sql(strings, ...values) {
    let query = strings[0];
    for (let i = 0; i < values.length; i++) query += `$${i + 1}` + strings[i + 1];
    const result = await post({ query, params: values.map(prepareValue) });
    const fields = (result && result.fields) || [];
    const rows = (result && result.rows) || [];
    return rows.map((row) => {
      const out = {};
      fields.forEach((field, i) => { out[field.name] = parseValue(row[i], field.dataTypeID); });
      return out;
    });
  };
}

let client = null;
let clientFor = null;
function sql(strings, ...values) {
  const cs = connectionString();
  if (!cs) return Promise.reject(new DatabaseError('DATABASE_URL is not set'));
  if (clientFor !== cs) { client = makeSql(cs); clientFor = cs; }
  return client(strings, ...values);
}

module.exports = { sql, makeSql, parseValue, prepareValue, connectionString };
