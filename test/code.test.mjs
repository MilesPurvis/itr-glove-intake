// Runs apps-script/Code.gs in Node against in-memory fakes of the Apps Script services.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
// Dates created inside the vm sandbox come from a different realm, so `instanceof Date` fails.
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

// Builder APIs (conditional formats, data validation) only need to chain and build().
const chainable = () => {
  const proxy = new Proxy({}, { get: (_, key) => (key === 'build' ? () => ({}) : () => proxy) });
  return proxy;
};

function fakeSheet(name) {
  const cells = new Map(); // "row:col" -> value
  let maxRows = 1000;
  const key = (r, c) => `${r}:${c}`;
  const display = (v) => (isDate(v) ? v.toISOString().slice(0, 10) : v === undefined ? '' : String(v));

  const sheet = {
    getName: () => name,
    getMaxRows: () => maxRows,
    insertRowsAfter: (_, n) => { maxRows += n; },
    getLastRow: () => Math.max(0, ...[...cells.entries()].filter(([, v]) => v !== '').map(([k]) => Number(k.split(':')[0]))),
    getLastColumn: () => Math.max(0, ...[...cells.keys()].map((k) => Number(k.split(':')[1]))),
    setFrozenRows() {}, setFrozenColumns() {}, setConditionalFormatRules() {},
    getDataRange: () => sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()),
    getRange(row, col, numRows = 1, numCols = 1) {
      if (typeof row === 'string') return chainable();
      if (row > maxRows) throw new Error('Range out of bounds');
      const grid = (fn) => Array.from({ length: numRows }, (_, i) => Array.from({ length: numCols }, (_, j) => fn(row + i, col + j)));
      const range = {
        getSheet: () => sheet,
        getRow: () => row, getLastRow: () => row + numRows - 1,
        getColumn: () => col, getLastColumn: () => col + numCols - 1,
        getA1Notation: () => String.fromCharCode(64 + col) + row,
        getValue: () => cells.get(key(row, col)) ?? '',
        setValue: (v) => { cells.set(key(row, col), v); return range; },
        getValues: () => grid((r, c) => cells.get(key(r, c)) ?? ''),
        getDisplayValues: () => grid((r, c) => display(cells.get(key(r, c)))),
        setValues: (values) => { values.forEach((rowVals, i) => rowVals.forEach((v, j) => cells.set(key(row + i, col + j), v))); return range; },
        setNumberFormats: () => range, setDataValidation: () => range,
        setFontWeight: () => range, setFontColor: () => range, setBackground: () => range,
      };
      return range;
    },
  };
  return sheet;
}

let ctx, sheet, sent, props;

function load() {
  const sheets = {};
  const ss = {
    getId: () => 'sheet-id',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/sheet-id',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = fakeSheet(n)),
    toast() {},
  };
  sent = [];
  props = {};
  ctx = vm.createContext({
    console,
    SpreadsheetApp: {
      getActive: () => ss, openById: () => ss,
      newConditionalFormatRule: chainable, newDataValidation: chainable,
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: { sendEmail: (msg) => sent.push(msg) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => JSON.parse(s) }) },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), newBlob: (data, type, name) => ({ data, type, name }) },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'deployer@gmail.com' }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: chainable, deleteTrigger() {} },
  });
  vm.runInContext(SOURCE, ctx);
  ctx.setup();
  sheet = sheets.Orders;
}

const header = (name) => vm.runInContext('COLUMNS', ctx).findIndex((c) => c.header === name) + 1;
const cell = (row, name) => sheet.getRange(row, header(name)).getValue();
const post = (payload) => ctx.doPost({ postData: { contents: JSON.stringify(payload) } });

const valid = () => ({
  make: 'Bauer', model: 'Supreme Mach', quantity: '1', quantityUnit: 'Pair(s)', service: 'Standard',
  palmMaterial: 'AX Suede', palmOption: 'Orange 0.8mm', overlay: 'No', gussets: 'Yes',
  gussetMaterial: 'AirKnit', gussetColor: 'Navy Blue', backhandPads: 'None', shotBlockers: 'Upgraded D30 and Plastic',
  cuffMods: ['Cuff Reduction', 'Cuff Roll Swap'], embroidery: 'Yes', embroideryText: '#19 white, left cuff',
  name: 'Jane Doe', email: 'Jane@Example.com', phone: '+1 810 555 0100',
  address1: '1 Main St', city: 'Roanoke', state: 'VA', zip: '02134', website: '',
});

beforeEach(load);

test('saves a submission as an Intake row and emails owner + customer', () => {
  const res = post(valid());
  assert.deepEqual(res, { ok: true, orderId: 'ITR-1001' });
  assert.equal(cell(2, 'Order ID'), 'ITR-1001');
  assert.equal(cell(2, 'Status'), 'Intake');
  assert.equal(cell(2, 'Email'), 'jane@example.com');
  assert.equal(cell(2, 'Phone'), '+1 810 555 0100');
  assert.equal(cell(2, 'Return Address'), '1 Main St, Roanoke, VA 02134');
  assert.equal(cell(2, 'Cuff Mods'), 'Cuff Reduction, Cuff Roll Swap');
  assert.equal(cell(2, 'Embroidery'), '#19 white, left cuff');
  assert.equal(cell(2, 'Backhand Pads'), '');
  assert.ok(isDate(cell(2, 'Submitted')));

  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, 'milespurvis11@gmail.com');
  assert.equal(sent[0].replyTo, 'jane@example.com');
  assert.match(sent[0].subject, /ITR-1001/);
  assert.equal(sent[1].to, 'jane@example.com');
  assert.match(sent[1].htmlBody, /2767 Derwent Drive SW/);
});

test('blank OWNER_EMAIL falls back to the deploying account', () => {
  vm.runInContext("CONFIG.OWNER_EMAIL = ''", ctx);
  post(valid());
  assert.equal(sent[0].to, 'deployer@gmail.com');
  assert.equal(sent[1].replyTo, 'deployer@gmail.com');
});

test('order IDs increment', () => {
  post(valid());
  assert.equal(post(valid()).orderId, 'ITR-1002');
  assert.equal(cell(3, 'Order ID'), 'ITR-1002');
});

test('rejects missing required fields without saving or emailing', () => {
  const res = post({ ...valid(), email: '', model: ' ' });
  assert.equal(res.ok, false);
  assert.match(res.error, /email/);
  assert.match(res.error, /model/);
  assert.equal(sheet.getLastRow(), 1);
  assert.equal(sent.length, 0);
});

test('rejects malformed JSON and invalid email', () => {
  assert.equal(ctx.doPost({ postData: { contents: '{nope' } }).ok, false);
  assert.equal(post({ ...valid(), email: 'not-an-email' }).ok, false);
});

test('honeypot submissions look successful but are dropped', () => {
  assert.equal(post({ ...valid(), website: 'http://spam' }).ok, true);
  assert.equal(sheet.getLastRow(), 1);
  assert.equal(sent.length, 0);
});

test('formula-like input is stored as text and HTML is escaped in emails', () => {
  post({ ...valid(), notes: '=HYPERLINK("http://evil","x")', name: '<b>Jane</b>' });
  assert.equal(cell(2, 'Notes / Comments / Mods'), '\'=HYPERLINK("http://evil","x")');
  assert.doesNotMatch(sent[1].htmlBody, /<b>Jane<\/b>/);
});

test('moving to In Progress stamps intake date and due date', () => {
  post(valid());
  post({ ...valid(), service: 'Expedited' });
  for (const row of [2, 3]) {
    const status = sheet.getRange(row, header('Status')).setValue('In Progress');
    ctx.handleEdit({ range: status });
  }
  const days = (row) => Math.round((cell(row, 'Est. Due Date') - cell(row, 'Intake Date')) / 86400000);
  assert.ok(isDate(cell(2, 'Intake Date')));
  assert.equal(days(2), 28);
  assert.equal(days(3), 7);
  assert.ok(isDate(cell(2, 'Status Updated')));
});

test('edits outside the Status column are ignored', () => {
  post(valid());
  ctx.handleEdit({ range: sheet.getRange(2, header('Shop Notes')) });
  assert.equal(cell(2, 'Status Updated'), '');
});

test('CSV export emails the sheet as an attachment', () => {
  post({ ...valid(), notes: 'Tight, "snug" fit' });
  sent.length = 0;
  ctx.emailCsvExport();
  const [{ attachments: [csv] }] = sent;
  const lines = csv.data.split('\r\n');
  assert.equal(csv.type, 'text/csv');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Order ID,Submitted,Status,/);
  assert.match(lines[1], /"Tight, ""snug"" fit"/);
});
