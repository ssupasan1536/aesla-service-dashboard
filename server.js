/**
 * ═══════════════════════════════════════════════════════════════
 *  AESLA Field Service — Backend API  v3.0
 *  Stack   : Node.js + Express
 *  Storage : Supabase (PostgreSQL)
 *  Deploy  : Vercel
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const crypto     = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── ENV CONFIG ───────────────────────────────────────────────
const CONFIG = {
  supabaseUrl            : process.env.SUPABASE_URL              || null,
  supabaseServiceRoleKey : process.env.SUPABASE_SERVICE_ROLE_KEY || null,
  nodeEnv                : process.env.NODE_ENV                   || 'development',
};

// ─── Supabase Client (lazy init) ─────────────────────────────
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseServiceRoleKey) {
    console.warn('⚠️  Supabase not configured — check env vars');
    return null;
  }
  _supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
  return _supabase;
}

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════

// ── Health ────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status   : 'ok',
    service  : 'AESLA Field Service API v3.0',
    timestamp: new Date().toISOString(),
    storage  : {
      supabase: !!CONFIG.supabaseUrl && !!CONFIG.supabaseServiceRoleKey,
    },
  });
});

// ── POST /api/tickets — บันทึก ticket ใหม่ ────────────────────
app.post('/api/tickets', async (req, res) => {
  try {
    const body = req.body;
    if (!body || !body.title || !body.customer) {
      return res.status(400).json({ success: false, message: 'title and customer are required' });
    }

    const ticketId = body.id || `TK-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const now      = new Date().toISOString();

    const record = {
      ticket_id     : ticketId,
      submitted_at  : now,
      title         : body.title        || '',
      customer      : body.customer     || '',
      machine       : body.machine      || '',
      brand         : body.brand        || '',
      branch        : body.branch       || '',
      priority      : body.priority     || 'medium',
      type          : body.type         || '',
      assignee      : body.assignee     || null,
      step          : body.step         || 1,
      call_status   : body.callStatus   || null,
      parts_required: body.parts ? true : false,
      raw_payload   : body,
    };

    const sb = getSupabase();
    if (!sb) {
      console.warn('⚠️  Supabase not ready — returning ticket ID only');
      return res.status(201).json({
        success : true,
        message : 'Ticket created (Supabase not configured — data not persisted)',
        ticketId,
        savedAt : now,
      });
    }

    const { data, error } = await sb.from('tickets').insert(record).select().single();
    if (error) throw error;

    return res.status(201).json({
      success : true,
      message : 'Ticket saved to Supabase ✅',
      ticketId,
      dbId    : data.id,
      savedAt : now,
    });
  } catch (err) {
    console.error('❌ /api/tickets error:', err);
    return res.status(500).json({ success: false, message: CONFIG.nodeEnv === 'development' ? err.message : 'Server error' });
  }
});

// ── GET /api/tickets — ดึง tickets จาก Supabase ──────────────
app.get('/api/tickets', async (req, res) => {
  try {
    const sb = getSupabase();
    if (!sb) return res.json({ success: true, tickets: [], message: 'Supabase not configured' });

    const { data, error } = await sb
      .from('tickets')
      .select('*')
      .order('submitted_at', { ascending: false });

    if (error) throw error;

    const tickets = (data || []).map(r => ({
      ticketId     : r.ticket_id,
      submittedAt  : r.submitted_at,
      title        : r.title,
      customer     : r.customer,
      machine      : r.machine,
      brand        : r.brand,
      branch       : r.branch,
      priority     : r.priority,
      type         : r.type,
      assignee     : r.assignee,
      step         : r.step,
      callStatus   : r.call_status,
      partsRequired: r.parts_required,
    }));

    res.json({ success: true, tickets, total: tickets.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/tickets/:ticketId — อัปเดต step/assignee/status ─
app.patch('/api/tickets/:ticketId', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const updates      = req.body;

    const sb = getSupabase();
    if (!sb) return res.status(503).json({ success: false, message: 'Supabase not configured' });

    const patch = {};
    if (updates.step       !== undefined) patch.step          = updates.step;
    if (updates.assignee   !== undefined) patch.assignee      = updates.assignee;
    if (updates.callStatus !== undefined) patch.call_status   = updates.callStatus;
    if (updates.parts      !== undefined) patch.parts_required = updates.parts;

    const { data, error } = await sb
      .from('tickets')
      .update(patch)
      .eq('ticket_id', ticketId)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, ticket: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/service-record — Field Service Report ────────────
app.post('/api/service-record', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload?.serviceRecord) {
      return res.status(400).json({ success: false, message: 'Missing serviceRecord' });
    }

    const sr         = payload.serviceRecord;
    const internalId = `AESLA-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const recordId   = sr.metadata?.recordId || internalId;
    const now        = new Date().toISOString();
    const sd         = sr.serviceDetails || {};

    const record = {
      record_id      : recordId,
      submitted_at   : sr.metadata?.submittedAt || now,
      technician     : sr.metadata?.submittedBy || '',
      clinic         : sr.customer?.clinicName  || '',
      equipment      : sr.equipment?.equipmentName || '',
      serial_no      : sr.equipment?.serialNumber  || '',
      service_type   : sd.serviceType            || '',
      service_date   : sd.serviceDate            || null,
      symptom        : (sd.symptom     || '').slice(0, 500),
      action_taken   : (sd.actionTaken || '').slice(0, 500),
      parts_count    : sd.replacedPartsCount  || 0,
      downtime_hours : sd.downtimeHours       || 0,
      machine_status : sd.machineStatusAfterService || '',
      raw_payload    : payload,
    };

    const sb = getSupabase();
    if (!sb) {
      return res.status(201).json({
        success    : true,
        message    : 'Record created (Supabase not configured — not persisted)',
        internalId , recordId,
        submittedAt: now,
      });
    }

    const { data, error } = await sb.from('service_records').insert(record).select().single();
    if (error) throw error;

    return res.status(201).json({
      success    : true,
      message    : 'Service record saved to Supabase ✅',
      internalId ,
      recordId   ,
      dbId       : data.id,
      submittedAt: now,
    });
  } catch (err) {
    console.error('❌ /api/service-record error:', err);
    return res.status(500).json({ success: false, message: CONFIG.nodeEnv === 'development' ? err.message : 'Server error' });
  }
});

// ── GET /api/service-records ───────────────────────────────────
app.get('/api/service-records', async (req, res) => {
  try {
    const sb = getSupabase();
    if (!sb) return res.json({ success: true, records: [] });

    const { data, error } = await sb
      .from('service_records')
      .select('*')
      .order('submitted_at', { ascending: false });

    if (error) throw error;

    const records = (data || []).map(r => ({
      recordId     : r.record_id,
      submittedAt  : r.submitted_at,
      technician   : r.technician,
      clinic       : r.clinic,
      equipment    : r.equipment,
      serialNo     : r.serial_no,
      serviceType  : r.service_type,
      serviceDate  : r.service_date,
      symptom      : r.symptom,
      actionTaken  : r.action_taken,
      partsCount   : r.parts_count,
      downtime     : r.downtime_hours,
      machineStatus: r.machine_status,
    }));

    res.json({ success: true, records, total: records.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Fallback → serve frontend ──────────────────────────────────
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('*',         (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  const sbOk = !!CONFIG.supabaseUrl && !!CONFIG.supabaseServiceRoleKey;
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   AESLA Field Service API v3.0 — RUNNING     ║');
  console.log(`║   http://localhost:${PORT}                      ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║   Supabase : ${sbOk ? '✅ CONNECTED             ' : '⚠️  NOT SET               '}║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
