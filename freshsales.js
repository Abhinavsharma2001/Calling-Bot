// ============================================================
// src/services/freshsales.js — Freshsales CRM Integration
//
// Automatically:
//  - Creates/updates contact on incoming call
//  - Logs call activity with transcript
//  - Updates lead score based on conversation
// ============================================================

import axios from 'axios';

class FreshsalesService {
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
      timeout: 8000,
    });
  }

  // ── Upsert Contact ─────────────────────────────────────────
  // Creates contact if not found, or returns existing
  async upsertContact({ phone, source, callSid }) {
    if (!this.apiKey || !this.domain) {
      console.log('[Freshsales] Skipping — API key not configured');
      return null;
    }

    try {
      // Search for existing contact by phone
      const searchRes = await this.client.get('/contacts/search', {
        params: { q: phone, include: 'owner' },
      });

      const existing = searchRes.data?.contacts?.[0];
      if (existing) {
        console.log(`[Freshsales] Found existing contact: ${existing.id}`);
        return existing;
      }

      // Create new contact
      const createRes = await this.client.post('/contacts', {
        contact: {
          mobile_number: phone,
          email: `call_${Date.now()}@placeholder.ai`,
          lead_source_id: 3,         // Phone — adjust based on your Freshsales setup
          custom_field: {
            call_sid: callSid,
            lead_source_channel: source,
          },
        },
      });

      console.log(`[Freshsales] Contact created: ${createRes.data?.contact?.id}`);
      return createRes.data?.contact;

    } catch (err) {
      console.error('[Freshsales] upsertContact error:', err.response?.data || err.message);
      return null;
    }
  }

  // ── Log Call Activity ──────────────────────────────────────
  async logCallActivity({ callSid, status, duration, phone }) {
    if (!this.apiKey || !this.domain) return;

    try {
      // Find contact first
      const contact = await this.upsertContact({ phone, source: 'call_end', callSid });
      if (!contact?.id) return;

      // Log as a Sales Activity in Freshsales
      await this.client.post('/sales_activities', {
        sales_activity: {
          sales_activity_type_id: 1,        // Phone Call type — adjust as needed
          title: `AI Call — ${status} (${duration}s)`,
          start_date: new Date().toISOString(),
          end_date: new Date().toISOString(),
          targetable_type: 'Contact',
          targetable_id: contact.id,
          notes: `Call SID: ${callSid} | Duration: ${duration}s | Status: ${status}`,
        },
      });

      console.log(`[Freshsales] Call activity logged for contact ${contact.id}`);

    } catch (err) {
      console.error('[Freshsales] logCallActivity error:', err.response?.data || err.message);
    }
  }

  // ── Log Conversation Turn ──────────────────────────────────
  async logConversationTurn({ phone, userSaid, agentSaid, callSid }) {
    if (!this.apiKey || !this.domain) return;

    try {
      const contact = await this.upsertContact({ phone, source: 'conversation', callSid });
      if (!contact?.id) return;

      // Append note to contact
      await this.client.post('/notes', {
        note: {
          description: `📞 Call Transcript\n\nUser: "${userSaid}"\nAgent: "${agentSaid}"`,
          targetable_type: 'Contact',
          targetable_id: contact.id,
        },
      });

    } catch (err) {
      // Non-critical — don't throw
      console.error('[Freshsales] logConversationTurn error:', err.response?.data || err.message);
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