require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Anthropic } = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// On Railway, the Dockerfile sets PUPPETEER_EXECUTABLE_PATH to apt's installed Chromium.
// Locally on your Mac, this env var won't be set, so Puppeteer uses its own bundled Chromium.
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
if (executablePath) {
  console.log(`Using Chromium at: ${executablePath}`);
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath,
    protocolTimeout: 120000, // 2 min, up from Puppeteer's 30s default -- Railway's container can be slower
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  }
});

client.on('qr', (qr) => {
  console.log("Scan this QR code with your phone's WhatsApp to log in:");
  qrcode.generate(qr, { small: true });
  console.log('\n--- RAW QR DATA (if the ASCII code above looks broken/misaligned) ---');
  console.log('Paste this into: https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(qr));
  console.log('--- (open that URL in a browser to see a clean, scannable QR image) ---\n');
});

let selfChatId = null;

client.on('ready', () => {
  selfChatId = client.info.wid._serialized; // your own "Message Yourself" chat
  console.log('WhatsApp AI Assistant is ready and running!');
  console.log('Drafts will be sent to your self-chat:', selfChatId);

  // Active health check every 60s -- catches silent drops that don't fire 'disconnected'.
  setInterval(async () => {
    try {
      const state = await client.getState();
      if (state !== 'CONNECTED') {
        console.error(`\n⚠️  Health check: state is "${state}", not CONNECTED. Exiting so the process can be restarted fresh...\n`);
        process.exit(1);
      } else {
        console.log(`Health check OK (${new Date().toLocaleTimeString()}): CONNECTED`);
      }
    } catch (err) {
      console.error(`\n⚠️  Health check failed (client likely dead): ${err.message}`);
      console.error('Exiting so the process can be restarted fresh...\n');
      process.exit(1);
    }
  }, 60000);
});

client.on('disconnected', (reason) => {
  console.error(`\n⚠️  Session disconnected: ${reason}`);
  console.error('Attempting to reconnect in 5 seconds...\n');
  setTimeout(() => {
    client.initialize();
  }, 5000);
});

client.on('auth_failure', (msg) => {
  console.error('\n❌ Authentication failed:', msg);
  console.error('You will likely need to delete .wwebjs_auth and rescan the QR code.\n');
});

// --- Per-contact conversation memory ---
// key: contactId -> array of { role: 'user'|'assistant', content: string }
// Capped to the last MEMORY_LIMIT entries per contact, so prompts stay small and cheap.
const conversationMemory = new Map();
const MEMORY_LIMIT = 8; // ~4 exchanges of context per contact

function pushMemory(contactId, role, content) {
  if (!conversationMemory.has(contactId)) conversationMemory.set(contactId, []);
  const history = conversationMemory.get(contactId);
  history.push({ role, content });
  if (history.length > MEMORY_LIMIT) history.shift();
}

// Queue-based approval tracking (no message IDs -- avoids library bugs we hit with
// getQuotedMessage()/sendMessage() ID capture). Oldest pending draft is always "active".
const pendingQueue = []; // [{ contactId, contactLabel, draftText }, ...]

const DRAFT_SYSTEM_PROMPT = `You are a helpful, casual, brief personal AI assistant drafting WhatsApp replies on behalf of the user.

Rules:
- Keep replies short: 1-2 sentences max.
- Match the contact's tone: if they write casually (slang, no punctuation, emoji), reply casually. If they write formally, reply more formally. Base this on their message and the conversation history if provided.
- If the contact's message is in a language other than English, write your reply in THAT SAME language.
- Assess the incoming message for urgency or emotional distress (e.g. genuine emergencies, upset/angry tone, time-sensitive asks). Most everyday messages are NOT urgent.

Output format (follow EXACTLY, two lines):
Line 1: either the word URGENT or the word NORMAL (nothing else on this line)
Line 2: ONLY the drafted reply text (nothing else -- no labels, no quotes)`;

function parseDraftResponse(rawText) {
  const lines = rawText.trim().split('\n');
  const flagLine = (lines[0] || '').trim().toUpperCase();
  if (flagLine === 'URGENT' || flagLine === 'NORMAL') {
    return {
      urgent: flagLine === 'URGENT',
      draftText: lines.slice(1).join('\n').trim()
    };
  }
  // Model didn't follow the format -- fail safe, treat whole thing as the draft, not urgent.
  return { urgent: false, draftText: rawText.trim() };
}

client.on('message_create', async (msg) => {

  // --- Case 1: a command typed in your self-chat -> acts on the oldest pending draft ---
  if (msg.fromMe && msg.from === selfChatId) {
    const body = msg.body.trim();

    const isYes = body.toLowerCase() === 'y';
    const isNo = body.toLowerCase() === 'n';
    const sendMatch = body.match(/^send:\s*(.+)$/is); // "send: custom text"

    if (!isYes && !isNo && !sendMatch) return; // not a command, ignore entirely (e.g. personal notes)

    if (pendingQueue.length === 0) {
      await client.sendMessage(selfChatId, 'ℹ️ No pending drafts to act on.');
      return;
    }

    const pending = pendingQueue.shift(); // take the oldest
    let finalText = null;

    if (isYes) {
      finalText = pending.draftText;
    } else if (isNo) {
      await client.sendMessage(selfChatId, `❌ Skipped draft for ${pending.contactLabel}.`);
    } else if (sendMatch) {
      finalText = sendMatch[1].trim();
    }

    if (finalText) {
      await client.sendMessage(pending.contactId, finalText);
      await client.sendMessage(selfChatId, `✅ Sent to ${pending.contactLabel}: "${finalText}"`);
      pushMemory(pending.contactId, 'assistant', finalText); // remember what was actually sent
    }

    if (pendingQueue.length > 0) {
      await client.sendMessage(selfChatId, `(${pendingQueue.length} more draft(s) still pending — next up: ${pendingQueue[0].contactLabel})`);
    }

    return;
  }

  // --- Case 2: incoming message from ANY individual (not a group, not yourself) -> draft a reply ---
  const isIndividualChat = msg.from.endsWith('@c.us') || msg.from.endsWith('@lid');
  const isFromSomeoneElse = !msg.fromMe;
  const isNotSelfChat = msg.from !== selfChatId;

  if (isIndividualChat && isFromSomeoneElse && isNotSelfChat) {
    let chat = null;
    try {
      chat = await msg.getChat();
    } catch (err) {
      // Can't confirm chat status due to a known library/@lid resolution bug.
      // Proceeding as unlocked, since this was previously blocking 100% of messages.
      console.log(`Could not verify lock status (proceeding as unlocked): ${msg.from} — error: ${err.message}`);
    }

    if (chat && chat.isLocked) {
      console.log(`Skipped [GENUINELY LOCKED chat]: ${msg.from}`);
      return;
    }

    console.log(`Received text from: ${msg.from} — "${msg.body}"`);

    if (!msg.body || !msg.body.trim()) {
      console.log(`Skipped (no text content — likely media/sticker/reaction): ${msg.from}`);
      return;
    }

    try {
      pushMemory(msg.from, 'user', msg.body);
      const history = conversationMemory.get(msg.from) || [];

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: DRAFT_SYSTEM_PROMPT,
        messages: history, // includes the just-added incoming message as the latest entry
      });

      const { urgent, draftText } = parseDraftResponse(response.content[0].text);

      const contact = await msg.getContact();
      const contactLabel = contact.pushname || contact.name || contact.number;

      pendingQueue.push({ contactId: msg.from, contactLabel, draftText });

      const queuePosition = pendingQueue.length;
      const urgentTag = urgent ? '🚨 *URGENT* — ' : '';

      await client.sendMessage(
        selfChatId,
        `📝 ${urgentTag}Draft reply for *${contactLabel}* (queue #${queuePosition}):\n\n"${draftText}"\n\nReply in THIS self-chat with:\n- "y" to send the OLDEST pending draft as-is\n- "n" to skip the OLDEST pending draft\n- "send: your text" to send custom text for the OLDEST pending draft`
      );

    } catch (error) {
      console.error('Error generating draft:', error);
    }
  }
});

client.initialize();
