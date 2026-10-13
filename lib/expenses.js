// Expenses: money a seller spends running the business (restocking,
// delivery riders, packaging, data, adverts…). Together with each product's
// cost price they turn "sales" into real profit in the report.
const { sql } = require('./db');
const { HttpError } = require('./auth');
const { cleanText, nairaToKobo } = require('./format');

const CATEGORIES = ['Stock', 'Delivery', 'Packaging', 'Data and airtime', 'Adverts', 'Rent and bills', 'Staff', 'Other'];
const MAX_KOBO = 100000000000; // ₦1 billion
const MAX_PER_MONTH = 500;

// Dates are Lagos dates ("2026-10-13"); Lagos is UTC+1 all year.
function lagosToday() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
}

function validDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(text + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

// "2026-10" (defaults to this month)
function readMonth(raw) {
  const text = String(raw || '');
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(text) && text >= '2020-01' && text <= lagosToday().slice(0, 7)) return text;
  return lagosToday().slice(0, 7);
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function readExpense(body) {
  const amount = nairaToKobo(body.amount);
  if (amount === null || amount <= 0 || amount > MAX_KOBO) {
    throw new HttpError(400, 'Enter how much you spent in naira, like 3500.', { field: 'amount' });
  }
  const category = CATEGORIES.find((c) => c.toLowerCase() === String(body.category || '').toLowerCase());
  if (!category) throw new HttpError(400, 'Pick what the money was for.', { field: 'category' });
  const note = cleanText(body.note);
  if (note.length > 120) throw new HttpError(400, 'Keep the note under 120 characters.', { field: 'note' });
  const date = body.date ? String(body.date) : lagosToday();
  if (!validDate(date) || date < '2020-01-01') throw new HttpError(400, 'Pick the day you spent it.', { field: 'date' });
  if (date > lagosToday()) throw new HttpError(400, "That day hasn't happened yet.", { field: 'date' });
  return { amount, category, note: note || null, date };
}

function expenseForClient(e) {
  return {
    id: Number(e.id),
    amountKobo: Number(e.amount_kobo),
    category: e.category,
    note: e.note || '',
    date: e.day
  };
}

async function expenseList(vendor, rawMonth) {
  const month = readMonth(rawMonth);
  const start = month + '-01';
  const stop = nextMonth(month) + '-01';
  const [rows, [prev]] = await Promise.all([
    sql`
      SELECT id, amount_kobo, category, note, to_char(spent_on, 'YYYY-MM-DD') AS day FROM expenses
      WHERE vendor_id = ${vendor.id} AND spent_on >= ${start}::date AND spent_on < ${stop}::date
      ORDER BY spent_on DESC, id DESC
      LIMIT ${MAX_PER_MONTH}
    `,
    sql`
      SELECT coalesce(sum(amount_kobo), 0)::bigint AS total FROM expenses
      WHERE vendor_id = ${vendor.id} AND spent_on >= (${start}::date - interval '1 month') AND spent_on < ${start}::date
    `
  ]);
  const expenses = rows.map(expenseForClient);
  const byCategory = new Map();
  expenses.forEach((e) => byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amountKobo));
  return {
    month,
    thisMonth: lagosToday().slice(0, 7),
    expenses,
    totalKobo: expenses.reduce((s, e) => s + e.amountKobo, 0),
    lastMonthKobo: Number(prev.total),
    byCategory: [...byCategory.entries()].map(([category, totalKobo]) => ({ category, totalKobo })).sort((a, b) => b.totalKobo - a.totalKobo),
    categories: CATEGORIES
  };
}

async function saveExpense(vendor, body) {
  const e = readExpense(body);
  let row;
  if (body.id != null && body.id !== '') {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which expense? The id is missing.');
    [row] = await sql`
      UPDATE expenses SET amount_kobo = ${e.amount}, category = ${e.category}, note = ${e.note}, spent_on = ${e.date}::date, updated_at = now()
      WHERE id = ${id} AND vendor_id = ${vendor.id}
      RETURNING id
    `;
    if (!row) throw new HttpError(404, "That expense doesn't exist any more.");
  } else {
    [row] = await sql`
      INSERT INTO expenses (vendor_id, amount_kobo, category, note, spent_on)
      SELECT ${vendor.id}, ${e.amount}, ${e.category}, ${e.note}, ${e.date}::date
      WHERE (SELECT count(*) FROM expenses WHERE vendor_id = ${vendor.id}
             AND spent_on >= date_trunc('month', ${e.date}::date) AND spent_on < date_trunc('month', ${e.date}::date) + interval '1 month') < ${MAX_PER_MONTH}
      RETURNING id
    `;
    if (!row) throw new HttpError(400, `You can add up to ${MAX_PER_MONTH} expenses a month. Put small ones together.`);
  }
  return { savedId: Number(row.id), ...(await expenseList(vendor, e.date.slice(0, 7))) };
}

async function deleteExpense(vendor, body) {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which expense? The id is missing.');
  const [row] = await sql`
    DELETE FROM expenses WHERE id = ${id} AND vendor_id = ${vendor.id}
    RETURNING to_char(spent_on, 'YYYY-MM') AS month
  `;
  if (!row) throw new HttpError(404, "That expense doesn't exist any more.");
  return expenseList(vendor, row.month);
}

// ---------- the profit report's dates ----------
// period: "30d" (default), "month" (this month so far) or "last" (last month).
// Returns Lagos dates: start (first day) and stop (the day after the last).
const PERIODS = { '30d': 'Last 30 days', month: 'This month', last: 'Last month' };
function periodRange(raw) {
  const period = PERIODS[raw] ? raw : '30d';
  const today = lagosToday();
  const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  let start;
  let stop;
  if (period === 'month') { start = thisMonth + '-01'; stop = addDays(today, 1); }
  else if (period === 'last') {
    const [y, m] = thisMonth.split('-').map(Number);
    start = (m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`) + '-01';
    stop = thisMonth + '-01';
  } else { start = addDays(today, -29); stop = addDays(today, 1); }
  return { period, label: PERIODS[period], start, stop, lastDay: addDays(stop, -1) };
}

// CSV cells: quoted, and never read as a formula by spreadsheet apps.
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

async function expensesCsv(vendor, res) {
  const rows = await sql`
    SELECT to_char(spent_on, 'YYYY-MM-DD') AS day, category, note, amount_kobo FROM expenses
    WHERE vendor_id = ${vendor.id}
    ORDER BY spent_on DESC, id DESC
    LIMIT 20000
  `;
  const lines = [['Date', 'For', 'Note', 'Amount (NGN)'].map(csvCell).join(',')];
  rows.forEach((e) => lines.push([e.day, e.category, e.note || '', (Number(e.amount_kobo) / 100).toFixed(2)].map(csvCell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orderpadi-expenses-${lagosToday()}.csv"`);
  return res.status(200).send('﻿' + lines.join('\r\n'));
}

module.exports = {
  CATEGORIES, PERIODS, lagosToday, readMonth, readExpense, expenseList, saveExpense, deleteExpense, periodRange, csvCell, expensesCsv
};
