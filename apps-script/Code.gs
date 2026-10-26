/**
 * ITR Hockey glove intake — Google Apps Script backend.
 *
 * Bound to the "Orders" Google Sheet and deployed as a web app. The intake form POSTs
 * JSON here; each submission becomes a row with status "Intake" and emails go out from
 * the deploying Gmail account. Status is then managed from the sheet's dropdown.
 */

const CONFIG = {
  // Where new-order notifications go. Leave '' to use the Google account that deployed the script.
  // Emails are always sent *from* the deploying account.
  OWNER_EMAIL: 'milespurvis11@gmail.com',
  BUSINESS_NAME: 'ITR Hockey',
  PHONE: '810.275.8629',
  SHIP_TO: ['Ian Roberts - ITR Hockey', '2767 Derwent Drive SW', 'Roanoke, VA 24015'],
  SHEET_NAME: 'Orders',
  ORDER_PREFIX: 'ITR-',
  FIRST_ORDER_NUMBER: 1001,
  STANDARD_TURNAROUND_DAYS: 28,
  EXPEDITED_TURNAROUND_DAYS: 7,
  SEND_CUSTOMER_CONFIRMATION: true,
  EMAIL_CUSTOMER_ON_STATUS_CHANGE: false,
};

const STATUSES = ['Intake', 'Confirmed', 'Waiting on Gloves', 'In Progress', 'Completed', 'Shipped', 'Cancelled'];

const STATUS_COLORS = {
  Intake: '#fff4c2',
  Confirmed: '#d6e6ff',
  'Waiting on Gloves': '#ffe0c2',
  'In Progress': '#e6dcff',
  Completed: '#d4f2d9',
  Shipped: '#e5e5e5',
  Cancelled: '#f8d4d4',
};

// Sheet column order. Keys match normalizeOrder_() output; `type` drives number formats.
const COLUMNS = [
  { key: 'orderId', header: 'Order ID' },
  { key: 'submittedAt', header: 'Submitted', type: 'datetime' },
  { key: 'status', header: 'Status' },
  { key: 'statusUpdatedAt', header: 'Status Updated', type: 'datetime' },
  { key: 'intakeDate', header: 'Intake Date', type: 'date' },
  { key: 'dueDate', header: 'Est. Due Date', type: 'date' },
  { key: 'service', header: 'Service' },
  { key: 'name', header: 'Name' },
  { key: 'email', header: 'Email' },
  { key: 'phone', header: 'Phone' },
  { key: 'returnAddress', header: 'Return Address' },
  { key: 'make', header: 'Make' },
  { key: 'model', header: 'Model' },
  { key: 'quantity', header: '# Gloves / Pairs' },
  { key: 'palmMaterial', header: 'Palm Material' },
  { key: 'palmOption', header: 'Palm Color / Thickness' },
  { key: 'overlay', header: 'Overlay' },
  { key: 'overlayMaterial', header: 'Overlay Material' },
  { key: 'overlayOption', header: 'Overlay Color / Thickness' },
  { key: 'overlayStyle', header: 'Overlay Style' },
  { key: 'palmInstructions', header: 'Palm Instructions' },
  { key: 'gussets', header: 'Gussets' },
  { key: 'gussetMaterial', header: 'Gusset Material' },
  { key: 'gussetColor', header: 'Gusset Color' },
  { key: 'gussetInstructions', header: 'Gusset Instructions' },
  { key: 'backhandPads', header: 'Backhand Pads' },
  { key: 'shotBlockers', header: 'Shot Blockers' },
  { key: 'cuffMods', header: 'Cuff Mods' },
  { key: 'cleaning', header: 'Ozone Cleaning' },
  { key: 'embroidery', header: 'Embroidery' },
  { key: 'gussetTaper', header: 'Gusset Height Reduction' },
  { key: 'notes', header: 'Notes / Comments / Mods' },
  { key: 'shopNotes', header: 'Shop Notes' },
];

// Shown in emails; workflow columns (status, dates) are left out.
const SUMMARY_KEYS = [
  'orderId', 'service', 'name', 'email', 'phone', 'returnAddress', 'make', 'model', 'quantity',
  'palmMaterial', 'palmOption', 'overlay', 'overlayMaterial', 'overlayOption', 'overlayStyle', 'palmInstructions',
  'gussets', 'gussetMaterial', 'gussetColor', 'gussetInstructions',
  'backhandPads', 'shotBlockers', 'cuffMods', 'cleaning', 'embroidery', 'gussetTaper', 'notes',
];

const REQUIRED_FIELDS = ['name', 'email', 'phone', 'make', 'model', 'quantity', 'palmMaterial', 'address1', 'city', 'state', 'zip'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Web app endpoints
// ---------------------------------------------------------------------------

function doGet() {
  return json_({ ok: true, service: 'itr-glove-intake' });
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Invalid request.' });
  }

  // Honeypot filled in: almost certainly a bot. Pretend it worked, save nothing.
  if (payload.website) return json_({ ok: true, orderId: '' });

  const missing = REQUIRED_FIELDS.filter(function (key) { return !text_(payload[key]); });
  if (missing.length) return json_({ ok: false, error: 'Missing required fields: ' + missing.join(', ') + '.' });
  if (!EMAIL_RE.test(text_(payload.email))) return json_({ ok: false, error: 'Please enter a valid email address.' });

  let order;
  try {
    order = saveOrder_(normalizeOrder_(payload));
  } catch (err) {
    console.error('Failed to save order', err);
    return json_({ ok: false, error: 'We could not save your order.' });
  }

  // The order is already saved; an email failure shouldn't tell the customer it didn't go through.
  try {
    sendOwnerNotification_(order);
    if (CONFIG.SEND_CUSTOMER_CONFIRMATION) sendCustomerConfirmation_(order);
  } catch (err) {
    console.error('Order ' + order.orderId + ' saved but email failed', err);
  }

  return json_({ ok: true, orderId: order.orderId });
}

// ---------------------------------------------------------------------------
// Sheet setup + menu
// ---------------------------------------------------------------------------

/** Run once from the Apps Script editor: formats the sheet and installs the status trigger. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  if (!ss) throw new Error('Open this script from the Orders sheet (Extensions → Apps Script) and run setup again.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  initSheet_(ss);

  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'handleEdit'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('handleEdit').forSpreadsheet(ss).onEdit().create();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ITR Orders')
    .addItem('Email me a CSV export', 'emailCsvExport')
    .addSeparator()
    .addItem('Re-run setup', 'setup')
    .addToUi();
}

function initSheet_(ss) {
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
  sheet.getRange(1, 1, 1, COLUMNS.length)
    .setValues([COLUMNS.map(function (c) { return c.header; })])
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#000000');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);

  // Open-ended A1 range (e.g. "C2:C") so the colors keep applying as rows are added.
  const statusLetter = sheet.getRange(1, col_('status')).getA1Notation().replace(/\d+/, '');
  const statusRange = sheet.getRange(statusLetter + '2:' + statusLetter);
  sheet.setConditionalFormatRules(STATUSES.map(function (status) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(status)
      .setBackground(STATUS_COLORS[status])
      .setRanges([statusRange])
      .build();
  }));
  return sheet;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function normalizeOrder_(p) {
  const embroideryText = text_(p.embroideryText);
  const yes = function (v) { return text_(v) === 'Yes' ? 'Yes' : ''; };
  const none = function (v) { return text_(v) === 'None' ? '' : text_(v); };

  return {
    submittedAt: new Date(),
    status: STATUSES[0],
    service: text_(p.service) || 'Standard',
    name: text_(p.name),
    email: text_(p.email).toLowerCase(),
    phone: text_(p.phone),
    returnAddress: [p.address1, p.address2, p.city, [p.state, p.zip].map(text_).filter(String).join(' ')]
      .map(text_).filter(String).join(', '),
    make: text_(p.make),
    model: text_(p.model),
    quantity: [text_(p.quantity), text_(p.quantityUnit) || 'Pair(s)'].join(' '),
    palmMaterial: text_(p.palmMaterial),
    palmOption: text_(p.palmOption),
    overlay: text_(p.overlay) || 'No',
    overlayMaterial: text_(p.overlayMaterial),
    overlayOption: text_(p.overlayOption),
    overlayStyle: text_(p.overlayStyle),
    palmInstructions: text_(p.palmInstructions),
    gussets: text_(p.gussets) || 'No',
    gussetMaterial: text_(p.gussetMaterial),
    gussetColor: text_(p.gussetColor),
    gussetInstructions: text_(p.gussetInstructions),
    backhandPads: none(p.backhandPads),
    shotBlockers: none(p.shotBlockers),
    cuffMods: [].concat(p.cuffMods || []).map(text_).filter(String).join(', '),
    cleaning: yes(p.cleaning),
    embroidery: embroideryText || yes(p.embroidery),
    gussetTaper: yes(p.gussetTaper),
    notes: text_(p.notes),
  };
}

function saveOrder_(order) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet_();
    order.orderId = nextOrderId_();

    const row = sheet.getLastRow() + 1;
    if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 100);

    const range = sheet.getRange(row, 1, 1, COLUMNS.length);
    // Formats go on before values so phone numbers / postal codes stay text (no lost leading zeros).
    range.setNumberFormats([COLUMNS.map(numberFormat_)]);
    range.setValues([COLUMNS.map(function (c) { return cellValue_(order[c.key]); })]);
    sheet.getRange(row, col_('status')).setDataValidation(statusRule_());
    return order;
  } finally {
    lock.releaseLock();
  }
}

function nextOrderId_() {
  const props = PropertiesService.getScriptProperties();
  const next = Number(props.getProperty('NEXT_ORDER_NUMBER')) || CONFIG.FIRST_ORDER_NUMBER;
  props.setProperty('NEXT_ORDER_NUMBER', String(next + 1));
  return CONFIG.ORDER_PREFIX + next;
}

// ---------------------------------------------------------------------------
// Status changes (installable onEdit trigger created by setup)
// ---------------------------------------------------------------------------

function handleEdit(e) {
  const range = e && e.range;
  if (!range) return;
  const sheet = range.getSheet();
  const statusCol = col_('status');
  if (sheet.getName() !== CONFIG.SHEET_NAME) return;
  if (range.getColumn() > statusCol || range.getLastColumn() < statusCol) return;

  for (let row = Math.max(range.getRow(), 2); row <= range.getLastRow(); row++) {
    onStatusChanged_(sheet, row);
  }
}

function onStatusChanged_(sheet, row) {
  const cell = function (key) { return sheet.getRange(row, col_(key)); };
  const status = text_(cell('status').getValue());
  if (STATUSES.indexOf(status) === -1) return;

  const now = new Date();
  cell('statusUpdatedAt').setValue(now);

  // "In Progress" means the gloves have arrived, so that's the intake date on the spec sheet.
  if (status === 'In Progress' && !cell('intakeDate').getValue()) {
    const today = startOfDay_(now);
    cell('intakeDate').setValue(today);
    if (!cell('dueDate').getValue()) {
      const expedited = text_(cell('service').getValue()) === 'Expedited';
      cell('dueDate').setValue(addDays_(today, expedited ? CONFIG.EXPEDITED_TURNAROUND_DAYS : CONFIG.STANDARD_TURNAROUND_DAYS));
    }
  }

  if (CONFIG.EMAIL_CUSTOMER_ON_STATUS_CHANGE) {
    const values = sheet.getRange(row, 1, 1, COLUMNS.length).getValues()[0];
    const order = {};
    COLUMNS.forEach(function (c, i) { order[c.key] = values[i]; });
    sendStatusUpdate_(order);
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function sendOwnerNotification_(order) {
  MailApp.sendEmail({
    to: ownerEmail_(),
    replyTo: order.email,
    name: CONFIG.BUSINESS_NAME + ' Intake',
    subject: 'New glove intake ' + order.orderId + ': ' + order.make + ' ' + order.model + ' - ' + order.name,
    htmlBody:
      '<p>New intake form submitted. Reply to this email to reach the customer.</p>' +
      summaryTable_(order) +
      '<p><a href="' + getSpreadsheet_().getUrl() + '">Open the Orders sheet</a></p>',
  });
}

function sendCustomerConfirmation_(order) {
  MailApp.sendEmail({
    to: order.email,
    replyTo: ownerEmail_(),
    name: CONFIG.BUSINESS_NAME,
    subject: CONFIG.BUSINESS_NAME + ': we received your glove intake form (' + order.orderId + ')',
    htmlBody:
      '<p>Hi ' + escape_(order.name) + ',</p>' +
      '<p>Thanks for your intake form. We\'ll review your specs and email you to confirm before you ship.</p>' +
      '<p>Once confirmed, ship your gloves to:<br><strong>' + CONFIG.SHIP_TO.map(escape_).join('<br>') + '</strong><br>' +
      'Please include a note with your order number (<strong>' + escape_(order.orderId) + '</strong>) in the box.</p>' +
      summaryTable_(order) +
      '<p>Questions? Reply to this email or call/text ' + CONFIG.PHONE + '.</p>' +
      '<p>- ' + CONFIG.BUSINESS_NAME + '</p>',
  });
}

const STATUS_MESSAGES = {
  Confirmed: 'Your order is confirmed. If you haven\'t already, ship your gloves to:<br><strong>' + CONFIG.SHIP_TO.join('<br>') + '</strong>',
  'Waiting on Gloves': 'We\'re ready for your gloves. Ship them to:<br><strong>' + CONFIG.SHIP_TO.join('<br>') + '</strong>',
  'In Progress': 'Your gloves have arrived and are in progress.',
  Completed: 'Your gloves are finished! We\'ll be in touch about return shipping.',
  Shipped: 'Your gloves are on their way back to you.',
};

function sendStatusUpdate_(order) {
  const message = STATUS_MESSAGES[order.status];
  if (!message || !EMAIL_RE.test(text_(order.email))) return;
  const due = order.status === 'In Progress' && order.dueDate instanceof Date
    ? '<p>Estimated completion: <strong>' + formatDate_(order.dueDate, 'MMM d, yyyy') + '</strong></p>'
    : '';
  MailApp.sendEmail({
    to: order.email,
    replyTo: ownerEmail_(),
    name: CONFIG.BUSINESS_NAME,
    subject: CONFIG.BUSINESS_NAME + ' order ' + order.orderId + ': ' + order.status,
    htmlBody: '<p>Hi ' + escape_(order.name) + ',</p><p>' + message + '</p>' + due +
      '<p>Questions? Reply to this email or call/text ' + CONFIG.PHONE + '.</p><p>- ' + CONFIG.BUSINESS_NAME + '</p>',
  });
}

function summaryTable_(order) {
  const headers = {};
  COLUMNS.forEach(function (c) { headers[c.key] = c.header; });
  const rows = SUMMARY_KEYS
    .filter(function (key) { return text_(order[key]); })
    .map(function (key) {
      return '<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top">' + escape_(headers[key]) + '</td>' +
        '<td style="padding:4px 0">' + escape_(order[key]) + '</td></tr>';
    });
  return '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">' + rows.join('') + '</table>';
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function emailCsvExport() {
  const rows = getSheet_().getDataRange().getDisplayValues();
  const csv = rows.map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n');
  const filename = 'itr-orders-' + formatDate_(new Date(), 'yyyy-MM-dd') + '.csv';
  MailApp.sendEmail({
    to: ownerEmail_(),
    subject: CONFIG.BUSINESS_NAME + ' orders export (' + (rows.length - 1) + ' orders)',
    body: 'Attached: ' + filename,
    attachments: [Utilities.newBlob(csv, 'text/csv', filename)],
  });
  const ss = SpreadsheetApp.getActive();
  if (ss) ss.toast('CSV sent to ' + ownerEmail_());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ownerEmail_() {
  return CONFIG.OWNER_EMAIL || Session.getEffectiveUser().getEmail();
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function getSheet_() {
  const ss = getSpreadsheet_();
  return ss.getSheetByName(CONFIG.SHEET_NAME) || initSheet_(ss);
}

function col_(key) {
  for (let i = 0; i < COLUMNS.length; i++) if (COLUMNS[i].key === key) return i + 1;
  throw new Error('Unknown column ' + key);
}

function statusRule_() {
  return SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build();
}

function numberFormat_(column) {
  if (column.type === 'datetime') return 'yyyy-mm-dd h:mm am/pm';
  if (column.type === 'date') return 'yyyy-mm-dd';
  return '@';
}

function text_(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, MAX_FIELD_LENGTH);
}

// Values that start like a formula are prefixed with ' so Sheets / Excel treat them as text.
// "+1 810..." style phone numbers are left alone.
const FORMULA_RE = /^(?:[=@\t\r]|[+-](?![\d\s(]))/;

function cellValue_(value) {
  if (value instanceof Date) return value;
  const s = text_(value);
  return FORMULA_RE.test(s) ? "'" + s : s;
}

function csvCell_(value) {
  let s = String(value);
  if (FORMULA_RE.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function escape_(value) {
  return text_(value).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays_(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate_(date, pattern) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), pattern);
}

function json_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
