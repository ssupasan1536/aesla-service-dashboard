/**
 * ═══════════════════════════════════════════════════════════════
 *  AESLA Field Service — Backend API  v2.0
 *  Stack   : Node.js + Express
 *  Storage : Google Drive (JSON records) + Google Sheets (log)
 *  Deploy  : Vercel / Render / Railway
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const crypto     = require('crypto');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── ENV CONFIG ───────────────────────────────────────────────
const CONFIG = {
  googleServiceAccountJson : process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null,
  googleDriveFolderId      : process.env.GOOGLE_DRIVE_FOLDER_ID      || null,
  googleSheetId            : process.env.GOOGLE_SHEET_ID             || null,
  sapBaseUrl               : process.env.SAP_BASE_URL                || null,
  nodeEnv                  : process.env.NODE_ENV                    || 'development',
};

// ─── Google Auth (lazy init) ──────────────────────────────────
let _auth = null;
function getGoogleAuth() {
  if (_auth) return _auth;
  if (!CONFIG.googleServiceAccountJson) return null;
  try {
    const credentials = typeof CONFIG.googleServiceAccountJson === 'string'
      ? JSON.parse(CONFIG.googleServiceAccountJson)
      : CONFIG.googleServiceAccountJson;
    _auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/spreadsheets',
      ],
    });
    return _auth;
  } catch (err) {
    console.error('❌ Google Auth init failed:', err.message);
    return null;
  }
}

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));  // 10mb for base64 signature images
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ════════════════════════════════════════════════════════════════
//  GOOGLE DRIVE — Save JSON record as file
// ════════════════════════════════════════════════════════════════
async function saveToDrive(internalId, payload) {
  const auth = getGoogleAuth();
  if (!auth || !CONFIG.googleDriveFolderId) {
    console.log('⚠️  Google Drive not configured — skipping Drive save');
    return null;
  }

  const drive = google.drive({ version: 'v3', auth });
  const sr    = payload.serviceRecord;

  // Sanitise clinic name for filename
  const clinic = (sr.customer?.clinicName || 'Unknown')
    .replace(/[^a-zA-Z0-9ก-๙\s]/g, '').trim().replace(/\s+/g, '_').slice(0, 30);
  const date   = sr.serviceDetails?.serviceDate || new Date().toISOString().split('T')[0];
  const recId  = (sr.metadata?.recordId || internalId).replace(/[^a-zA-Z0-9\-]/g, '');
  const fileName = `AESLA_${recId}_${clinic}_${date}.json`;

  try {
    const { Readable } = require('stream');
    const bodyStream   = Readable.from([JSON.stringify(payload, null, 2)]);

    const res = await drive.files.create({
      requestBody: {
        name    : fileName,
        mimeType: 'application/json',
        parents : [CONFIG.googleDriveFolderId],
      },
      media: {
        mimeType : 'application/json',
        body     : bodyStream,
      },
      fields: 'id, name, webViewLink',
    });

    console.log(`✅ Drive saved: ${res.data.name} (${res.data.id})`);
    return { fileId: res.data.id, fileName: res.data.name, webViewLink: res.data.webViewLink };
  } catch (err) {
    console.error('❌ Drive save failed:', err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
//  GOOGLE SHEETS — Append summary row
// ════════════════════════════════════════════════════════════════
const SHEET_HEADERS = [
  'Report No.', 'Submitted At', 'Technician',
  'Customer Clinic', 'Customer Name', 'Customer Email',
  'Machine / Equipment', 'Serial Number', 'Software Model',
  'Service Type', 'Service Date',
  'Problem Category', 'Error Code', 'Symptom (short)',
  'Action Taken (short)', 'Parts Count', 'Downtime (hrs)',
  'Machine Status After', 'PM Pass Count', 'PM Fail Count',
  'Customer Signed', 'Drive File Link', 'Internal ID',
];

async function ensureSheetHeader(sheets) {
  if (!CONFIG.googleSheetId) return;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.googleSheetId,
      range: 'Sheet1!A1:A1',
    });
    if (!res.data.values || res.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId  : CONFIG.googleSheetId,
        range          : 'Sheet1!A1',
        valueInputOption: 'RAW',
        requestBody    : { values: [SHEET_HEADERS] },
      });
      console.log('✅ Sheet headers written');
    }
  } catch (e) {
    console.warn('⚠️  Could not write sheet headers:', e.message);
  }
}

async function appendToSheet(internalId, payload, driveResult) {
  const auth = getGoogleAuth();
  if (!auth || !CONFIG.googleSheetId) {
    console.log('⚠️  Google Sheets not configured — skipping Sheet append');
    return null;
  }

  const sheets = google.sheets({ version: 'v4', auth });
  const sr     = payload.serviceRecord;
  const sd     = sr.serviceDetails;
  const sigs   = sr.signatures || {};

  await ensureSheetHeader(sheets);

  const passCount = (sd.pmChecklist || []).filter(r => r.result === 'PASS').length;
  const failCount = (sd.pmChecklist || []).filter(r => r.result === 'FAIL').length;

  const row = [
    sr.metadata?.recordId                           || '',
    sr.metadata?.submittedAt                        || '',
    sr.metadata?.submittedBy                        || '',
    sr.customer?.clinicName                         || '',
    sr.customer?.contactName                        || '',
    sr.customer?.contactEmail                       || '',
    sr.equipment?.equipmentName                     || '',
    sr.equipment?.serialNumber                      || '',
    sr.equipment?.softwareModel                     || '',
    sd.serviceType                                  || '',
    sd.serviceDate                                  || '',
    (sd.problemCategory || []).join(', ')           || '',
    sd.errorCode                                    || '',
    (sd.symptom   || '').slice(0, 120),
    (sd.actionTaken || '').slice(0, 120),
    sd.replacedPartsCount                           || 0,
    sd.downtimeHours                                || 0,
    sd.machineStatusAfterService                    || '',
    passCount,
    failCount,
    sigs.customerSigned ? 'YES' : 'NO',
    driveResult?.webViewLink                        || '',
    internalId,
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId   : CONFIG.googleSheetId,
      range           : 'Sheet1!A:W',
      valueInputOption: 'RAW',
      requestBody     : { values: [row] },
    });
    console.log(`✅ Sheet row appended for ${sr.metadata?.recordId}`);
    return true;
  } catch (err) {
    console.error('❌ Sheet append failed:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
//  VALIDATION
// ════════════════════════════════════════════════════════════════
function validatePayload(payload) {
  const errors = [];
  const sr = payload?.serviceRecord;
  if (!sr)                                          errors.push('Missing serviceRecord');
  if (!sr?.metadata?.submittedBy?.trim())           errors.push('metadata.submittedBy required');
  if (!sr?.metadata?.recordId?.trim())              errors.push('metadata.recordId (Report No.) required');
  if (!sr?.customer?.clinicName?.trim())            errors.push('customer.clinicName required');
  if (!sr?.customer?.contactName?.trim())           errors.push('customer.contactName required');
  if (!sr?.customer?.contactEmail?.trim())          errors.push('customer.contactEmail required');
  if (!sr?.equipment?.equipmentName?.trim())        errors.push('equipment.equipmentName required');
  if (!sr?.equipment?.serialNumber?.trim())         errors.push('equipment.serialNumber required');
  if (!sr?.serviceDetails?.symptom?.trim())         errors.push('serviceDetails.symptom required');
  if (!sr?.serviceDetails?.actionTaken?.trim())     errors.push('serviceDetails.actionTaken required');
  return errors;
}

// ════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════

// ── Health ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status   : 'ok',
    service  : 'AESLA Field Service API v2',
    timestamp: new Date().toISOString(),
    storage  : {
      googleDrive : !!CONFIG.googleDriveFolderId && !!CONFIG.googleServiceAccountJson,
      googleSheets: !!CONFIG.googleSheetId && !!CONFIG.googleServiceAccountJson,
      sap         : !!CONFIG.sapBaseUrl,
    },
  });
});

// ── Submit Service Record ───────────────────────────────────────
app.post('/api/service-record', async (req, res) => {
  try {
    const payload = req.body;

    // 1. Validate
    const errors = validatePayload(payload);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    // 2. Internal ID
    const internalId = `AESLA-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    // 3. Save to Google Drive (JSON file)
    const driveResult = await saveToDrive(internalId, payload);

    // 4. Append to Google Sheets (summary log)
    await appendToSheet(internalId, payload, driveResult);

    // 5. (Optional) Forward to SAP — uncomment when SAP endpoint is ready
    /*
    if (CONFIG.sapBaseUrl) {
      const sapPayload = transformToSapFormat(payload.serviceRecord);
      const sapRes = await fetch(`${CONFIG.sapBaseUrl}/ServiceOrders`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getSapToken()}` },
        body   : JSON.stringify(sapPayload),
      });
      const sapData = await sapRes.json();
      console.log('SAP response:', sapData);
    }
    */

    // 6. Fallback local log (always — for debugging)
    try {
      const fs = require('fs');
      const logEntry = {
        internalId, receivedAt: new Date().toISOString(),
        recordId: payload.serviceRecord.metadata.recordId,
        clinicName: payload.serviceRecord.customer.clinicName,
        driveFileId: driveResult?.fileId || null,
        driveLink: driveResult?.webViewLink || null,
      };
      fs.appendFileSync(path.join(__dirname, 'service_records_log.jsonl'), JSON.stringify(logEntry) + '\n');
    } catch (_) { /* ignore log errors in serverless */ }

    // 7. Respond
    return res.status(201).json({
      success    : true,
      message    : 'Service record saved successfully',
      internalId,
      recordId   : payload.serviceRecord.metadata.recordId,
      driveFileId: driveResult?.fileId   || null,
      driveLink  : driveResult?.webViewLink || null,
      sheetLogged: !!CONFIG.googleSheetId,
      submittedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('❌ Error:', err);
    return res.status(500).json({
      success: false,
      message: CONFIG.nodeEnv === 'development' ? err.message : 'Server error — contact administrator',
    });
  }
});

// ── List records (local log) ────────────────────────────────────
app.get('/api/service-records', (req, res) => {
  const fs = require('fs');
  const logPath = path.join(__dirname, 'service_records_log.jsonl');
  try {
    if (!fs.existsSync(logPath)) return res.json({ records: [], total: 0 });
    const lines = fs.readFileSync(logPath, 'utf8')
      .split('\n').filter(Boolean).map(JSON.parse).reverse();
    res.json({ records: lines, total: lines.length });
  } catch (err) {
    res.status(500).json({ error: 'Could not read records' });
  }
});

// ── Fallback → serve frontend ──────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  const driveOk  = !!CONFIG.googleDriveFolderId && !!CONFIG.googleServiceAccountJson;
  const sheetsOk = !!CONFIG.googleSheetId && !!CONFIG.googleServiceAccountJson;
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   AESLA Field Service API v2  — RUNNING      ║');
  console.log(`║   http://localhost:${PORT}                      ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║   Google Drive  : ${driveOk  ? '✅ CONNECTED   ' : '⚠️  NOT SET     '}           ║`);
  console.log(`║   Google Sheets : ${sheetsOk ? '✅ CONNECTED   ' : '⚠️  NOT SET     '}           ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;  // for Vercel serverless
