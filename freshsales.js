// ============================================================
// src/services/freshsales.js — Freshsales CRM Integration
//
// Automatically:
//  - Creates/updates contact on incoming call
//  - Logs call activity with transcript
//  - Updates lead score based on conversation
// ============================================================

import axios from 'axios';

export class FreshsalesService {
  constructor() {
    this.apiKey = process.env.FRESHSALES_API_KEY;
    this.domain = process.env.FRESHSALES_DOMAIN;
    this.baseUrl = `https://${this.domain}.myfreshworks.com/crm/sales/api`;

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Token token=${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  async listSalesActivityTypes() {
    try {
      const res = await this.client.get('/selector/sales_activity_types');
      console.log('[Freshsales] Available Activity Types:', JSON.stringify(res.data, null, 2));
    } catch (err) {
      console.log('[Freshsales] Could not list activity types:', err.message);
    }
  }

  // ── Upsert Contact ─────────────────────────────────────────
  // Creates contact if not found, or returns { contact, isNew }
  async upsertContact({ phone, source, callSid }) {
    if (!this.apiKey || !this.domain) {
      console.log('[Freshsales] Skipping — API key not configured');
      return null;
    }

    try {
      console.log(`[Freshsales] Upserting contact for phone: ${phone}`);
      
      // 1. Single efficient search
      const searchRes = await this.client.get('/contacts/search', {
        params: { q: encodeURIComponent(phone) },
      });

      let existing = searchRes.data?.contacts?.[0];
      
      if (existing) {
        console.log(`[Freshsales] Found existing contact: ${existing.id}`);
        return existing;
      }

      // Create new contact
      const createRes = await this.client.post('/contacts', {
        contact: {
          mobile_number: phone,
          email: `call_${Date.now()}@placeholder.ai`,
          lead_source_id: 3,
        },
      });

      const contact = createRes.data?.contact;
      console.log(`[Freshsales] Contact created: ${contact?.id}`);

      return contact;

    } catch (err) {
      const errorMsg = err.response?.data?.errors?.message?.[0] || err.message;
      
      // If the error is about duplicate contact, just log it as a info/warning rather than an error
      if (err.response?.status === 400 && errorMsg.includes('Something went wrong')) {
        console.log(`[Freshsales] Contact for ${phone} likely already exists (duplicate mobile_number). skipping create.`);
        return null;
      }

      console.error('[Freshsales] upsertContact error:', errorMsg);
      return null;
    }
  }

  // ── Log Call Activity (Shows up in the main Timeline) ──────
  async logCallActivity({ callSid, status, duration, phone, contactId }) {
    // Deprecated: We now log everything powerfully via Tasks in logCallSummary
    return;
  }

  // ── Log Full Conversation Summary (Consolidated Note) ─────
  async logCallSummary({ phone, callSid, history, contactId, status, duration }) {
    if (!this.apiKey || !this.domain) return;
    if (!history || history.length < 2) return;

    try {
      let cid = contactId;
      if (!cid) {
        console.log(`[Freshsales] No contactId provided, searching/creating for ${phone}...`);
        const contact = await this.upsertContact({ phone, source: 'call_summary', callSid });
        cid = contact?.id;
      }
      
      if (!cid) {
        console.error(`[Freshsales] ❌ Could not acquire Contact ID. Call summary will be lost!`);
        return;
      }

      // Build concise transcript as plain text (Freshsales might 500 on HTML/complex emojis)
      const lines = history.map(turn => {
        const role = turn.role === 'user' ? 'Customer' : 'Agent';
        const text = turn.parts?.[0]?.text || '';
        return `${role}: ${text}`;
      });

      const summary =
        `CALL SUMMARY\n` +
        `--------------------------\n` +
        `Status: ${status || 'Completed'}\n` +
        `Duration: ${duration || 0}s\n` +
        `Date: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n` +
        `SID: ${callSid}\n\n` +
        `TRANSCRIPT:\n` +
        lines.join('\n');

      // 1. Add traditional Note (lives in the Notes tab)
      await this._addNote(cid, summary);
      console.log(`[Freshsales] Consolidated note logged for contact ${cid}`);

      // 2. Add Timeline Task (hyper-visible on the front-page Timeline)
      try {
        await this.client.post('/tasks', {
          task: {
            title: `AI Outbound Call — ${status || 'Completed'}`,
            description: summary,
            targetable_type: 'Contact',
            targetable_id: cid,
            due_date: new Date().toISOString(),
            status: 1 // Completed task
          }
        });
        console.log(`[Freshsales] Timeline Task successfully created for contact ${cid}`);
      } catch (taskErr) {
        console.error(`[Freshsales] Failed to add Timeline Task:`, taskErr.response?.data || taskErr.message);
      }
    } catch (err) {
      console.error('[Freshsales] logCallSummary error:', err.response?.data || err.message);
    }
  }

  // ── Log Conversation Turn ──────────────────────────────────
  // (No longer used in real-time — consolidated summary at end)
  async logConversationTurn() {
    return;
  }

  // ── Private: Post a Note to a Contact ─────────────────────
  async _addNote(contactId, description) {
    try {
      // Small delay on new contacts to ensure eventual consistency
      await new Promise(r => setTimeout(r, 1000));

      const res = await this.client.post('/notes', {
        note: {
          description: description,
          targetable_type: 'Contact',
          targetable_id: contactId,
        },
      });
      console.log(`[Freshsales] Note created for ID ${contactId} | Status: ${res.status}`);
    } catch (err) {
      console.error(`[Freshsales] Failed to add note for ${contactId}:`, err.response?.data || err.message);
    }
  }

  // ── Update Lead Stage ──────────────────────────────────────
  async updateLeadStage({ contactId, stage }) {
    if (!this.apiKey || !this.domain) return;

    try {
      await this.client.put(`/contacts/${contactId}`, {
        contact: {
          lifecycle_stage_id: stage,
        },
      });
      console.log(`[Freshsales] Lead stage updated to ${stage} for contact ${contactId}`);
    } catch (err) {
      console.error('[Freshsales] updateLeadStage error:', err.message);
    }
  }
}

export const freshsalesService = new FreshsalesService();