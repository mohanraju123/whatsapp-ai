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
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log("Scan this QR code with your phone's WhatsApp to log in:");
  qrcode.generate(qr, { small: true });
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

// Queue-based approval tracking. No message IDs involved -- avoids the
// getQuotedMessage()/sendMessage() ID-capture bugs we kept hitting.
// Oldest pending draft (index 0) is always the "active" one.
const pendingQueue = []; // [{ contactId, contactLabel, draftText }, ...]

client.on('message_create', async (msg) => {

  // --- Case 1: a command typed in your self-chat -> acts on the oldest pending draft ---
  if (msg.fromMe && msg.from === selfChatId) {
    const body = msg.body.trim();

    // Safety guard: only these exact patterns are treated as commands.
    // Anything else (e.g. a personal note) is left alone, even if a draft is pending.
    const isYes = body.toLowerCase() === 'y';
    const isNo = body.toLowerCase() === 'n';
    const sendMatch = body.match(/^send:\s*(.+)$/is); // "send: custom text"

    if (!isYes && !isNo && !sendMatch) return; // not a command, ignore entirely

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
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: "You are a helpful, casual, and brief personal AI assistant. Reply naturally. Keep responses short (1-2 sentences max).",
        messages: [{ role: 'user', content: msg.body }],
      });

      const draftText = response.content[0].text.trim();

      const contact = await msg.getContact();
      const contactLabel = contact.pushname || contact.name || contact.number;

      pendingQueue.push({ contactId: msg.from, contactLabel, draftText });

      const queuePosition = pendingQueue.length;
      await client.sendMessage(
        selfChatId,
        `📝 Draft reply for *${contactLabel}* (queue #${queuePosition}):\n\n"${draftText}"\n\nReply in THIS self-chat with:\n- "y" to send the OLDEST pending draft as-is\n- "n" to skip the OLDEST pending draft\n- "send: your text" to send custom text for the OLDEST pending draft`
      );

    } catch (error) {
      console.error('Error generating draft:', error);
    }
  }
});

client.initialize();
