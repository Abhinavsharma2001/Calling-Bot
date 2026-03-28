import '../env.js';
import { freshsalesService } from '../freshsales.js';
import twilio from 'twilio';

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/**
 * Delay function to prevent blasting the API/Twilio all at once.
 */
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function startCampaign() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   🚀 AI OUTBOUND DIALER STARTED      ║');
  console.log('╚══════════════════════════════════════╝\n');

  try {
    console.log('[Campaign] Fetching contacts from Freshsales CRM...');
    
    // Note: Due to 'Trial Expired' restrictions in Freshsales, this might throw a 403 limit.
    // If so, you will need to upgrade the Freshsales plan to fetch bulk contacts.
    const res = await freshsalesService.client.get('/contacts', { 
      params: { per_page: 50 } // Fetch up to 50 recent contacts
    });

    const contacts = res.data?.contacts || [];
    
    if (contacts.length === 0) {
      console.log('[Campaign] No contacts found in CRM.');
      return;
    }

    console.log(`[Campaign] Found ${contacts.length} contacts. Initiating calls...\n`);

    for (const contact of contacts) {
      let phone = contact.mobile_number || contact.work_number || contact.phone;
      
      if (!phone) {
        console.log(`[Campaign] Skipping contact ${contact.id} — no phone number.`);
        continue;
      }

      // Ensure proper formatting (optional, Twilio usually requires +CountryCode)
      if (!phone.startsWith('+')) {
         console.log(`[Campaign] Attempting to call ${phone} (make sure it includes country code)...`);
      }

      console.log(`[Campaign] 📞 Dialing ${phone} (Contact ID: ${contact.id})...`);

      try {
        const call = await twilioClient.calls.create({
          to: phone,
          from: process.env.TWILIO_PHONE_NUMBER,
          url: `${process.env.BASE_URL}/twilio/outbound`,
          statusCallback: `${process.env.BASE_URL}/twilio/status`,
          statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer'],
          statusCallbackMethod: 'POST',
          machineDetection: 'Enable',
          machineDetectionTimeout: 5,
        });

        console.log(`[Campaign] ✅ Call Initiated | SID: ${call.sid}`);
        
        // Wait 15 seconds between dispatching calls to prevent overlapping overload
        // (Adjust this based on how many concurrent agents you want running)
        await delay(15000); 

      } catch (callErr) {
        console.error(`[Campaign] ❌ Failed to call ${phone}:`, callErr.message);
      }
    }

    console.log('\n[Campaign] 🎉 All calls in the campaign have been dispatched!');

  } catch (err) {
    console.error('\n[Campaign] ❌ Error fetching CRM data:', err.response?.data || err.message);
    if (err.response?.status === 403) {
      console.log('⚠️ FRESHSALES PERMISSION DENIED: Your Freshsales trial has expired or your current plan does not allow bulk API fetching. Please upgrade your Freshsales plan to fetch CRM contacts.');
    }
  }
}

startCampaign();
