require('dotenv').config();
const cron = require('node-cron');
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
      '--disable-dev-shm-usage',
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

  // --- Daily news headlines, 7:00 AM IST ---
  cron.schedule('0 7 * * *', () => {
    sendDailyNews();
  }, { timezone: 'Asia/Kolkata' });

  // --- Nightly self-chat cleanup, 12:00 AM IST ---
  cron.schedule('0 0 * * *', () => {
    cleanupSelfChat();
  }, { timezone: 'Asia/Kolkata' });

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

async function sendDailyNews() {
  try {
    console.log('Fetching daily news headlines...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: 'Search for today\'s top world/general news. Give me exactly 5 headlines, each as one short line with a 1-sentence summary. No preamble, no closing remarks -- just a numbered list of 5 headlines with summaries.'
      }],
    });

    const newsText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    if (!newsText) {
      console.error('No news text generated.');
      return;
    }

    await client.sendMessage(selfChatId, `☀️ *Good morning! Today's headlines:*\n\n${newsText}`);
    console.log('Daily news sent.');

  } catch (error) {
    console.error('Error fetching/sending daily news:', error);
  }
}

// Prefixes that mark a message as bot-generated (drafts, confirmations, news).
// Anything NOT starting with one of these is treated as a personal note and left alone.
const BOT_MESSAGE_MARKERS = ['📝', '✅', '❌', 'ℹ️', '☀️'];

async function cleanupSelfChat() {
  try {
    console.log('Running nightly self-chat cleanup...');
    const chat = await client.getChatById(selfChatId);
    const messages = await chat.fetchMessages({ limit: 500 });

    let deletedCount = 0;
    for (const msg of messages) {
      if (!msg.fromMe) continue; // only ever touch messages the bot itself could have sent
      const body = (msg.body || '').trim();
      const isBotMessage = BOT_MESSAGE_MARKERS.some(marker => body.startsWith(marker));
      if (!isBotMessage) continue; // leave personal notes untouched

      try {
        await msg.delete(true);
        deletedCount++;
      } catch (err) {
        console.error(`Could not delete a message during cleanup: ${err.message}`);
      }
    }

    console.log(`Self-chat cleanup done. Deleted ${deletedCount} bot message(s).`);

  } catch (error) {
    console.error('Error during self-chat cleanup:', error);
  }
}

client.on('disconnected', (reason) => {
  console.error(`\n⚠️  Session disconnected: ${reason}`);
  console.error('Exiting so the process can be restarted fresh...\n');
  process.exit(1);
});

client.on('auth_failure', (msg) => {
  console.error('\n❌ Authentication failed:', msg);
  console.error('You will likely need to delete .wwebjs_auth and rescan the QR code.\n');
});

// ============================================================
// BIRTHDAY WISH FEATURE (groups)
// ============================================================

// The group chat IDs you want this to run in. Format: '<numbers>@g.us'
// Leave empty to watch ALL groups, or list specific ones to restrict it.
const ALLOWED_GROUPS = [
  // '120363012345678901@g.us',
  // '120363019876543210@g.us',
];

// Loose pre-filter: cheap check to avoid calling Claude on every single group message.
// Deliberately broad -- the real "is this actually a birthday wish?" judgment happens
// via Claude below, so false positives here are fine (they just get filtered next).
const BIRTHDAY_REGEX = /birthday|hbd|b'?day|returns?\s+of\s+the\s+day/i;

// Tracks who's already been wished, per group, per day -- so it only fires once per
// person even if multiple people post variations of a birthday wish for the same person.
const wishedTracker = new Set(); // holds strings like "groupId|name|YYYY-MM-DD"

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

const BIRTHDAY_SYSTEM_PROMPT = `You are reading a WhatsApp group message to determine if it is wishing someone a happy birthday. This could be phrased many different ways, for example: "happy birthday", "happiest birthday", "hbd", "many happy returns of the day", "many happy returns", "wishing you an amazing birthday", "b'day wishes", etc. -- and many other natural phrasings with the same meaning.

If the message IS wishing someone a birthday: respond with ONLY that person's first name, exactly as it appears (or the word UNKNOWN if a wish is clearly present but no name is identifiable).

If the message is NOT a birthday wish (e.g. it just mentions "birthday" in an unrelated way, like recounting a past party): respond with ONLY the exact word: NOT_BIRTHDAY

Respond with ONLY the name, UNKNOWN, or NOT_BIRTHDAY -- nothing else, no punctuation, no extra words.`;

function parseBirthdayResponse(rawText) {
  const result = rawText.trim().split('\n')[0].trim();
  return { result };
}

async function handleBirthdayMessage(msg) {
  if (ALLOWED_GROUPS.length && !ALLOWED_GROUPS.includes(msg.from)) return;
  if (!BIRTHDAY_REGEX.test(msg.body)) return; // cheap pre-filter, avoids an API call for obviously unrelated messages

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system: BIRTHDAY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: msg.body }],
    });

    const { result } = parseBirthdayResponse(response.content[0].text);

    if (result.toUpperCase() === 'NOT_BIRTHDAY') return; // Claude confirmed it's not actually a birthday wish

    const name = result;

    // Fixed template -- no AI-generated wording, exactly "Happy Birthday <Name> 🎂"
    const wish = name.toUpperCase() === 'UNKNOWN'
      ? 'Happy Birthday! 🎂'
      : `Happy Birthday ${name}! 🎂`;

    const today = todayStr();
    const dedupeKey = `${msg.from}|${name.toLowerCase()}|${today}`;
    if (wishedTracker.has(dedupeKey)) return; // already wished this person in this group today

    wishedTracker.add(dedupeKey);

    setTimeout(async () => {
      try {
        await client.sendMessage(msg.from, wish);
        console.log(`Sent birthday wish in ${msg.from} for "${name}": ${wish}`);
      } catch (err) {
        console.error('Error sending birthday wish:', err);
      }
    }, 3000 + Math.random() * 4000); // random 3-7s delay, avoids looking instant/robotic

  } catch (error) {
    console.error('Error generating birthday wish:', error);
  }
}

// ============================================================
// PER-CONTACT DRAFT-AND-APPROVE FEATURE (1:1 chats)
// ============================================================

// key: contactId -> array of { role: 'user'|'assistant', content: string }
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
  return { urgent: false, draftText: rawText.trim() };
}

client.on('message_create', async (msg) => {

  // --- Case 1: a command typed in your self-chat -> acts on the oldest pending draft, or a utility command ---
  if (msg.fromMe && msg.from === selfChatId) {
    const body = msg.body.trim();

    // Utility commands -- test features on demand instead of waiting for their schedule
    if (body.toLowerCase() === 'news') {
      await sendDailyNews();
      return;
    }
    if (body.toLowerCase() === 'cleanup') {
      await cleanupSelfChat();
      return;
    }

    const isYes = body.toLowerCase() === 'y';
    const isNo = body.toLowerCase() === 'n';
    const sendMatch = body.match(/^send:\s*(.+)$/is);

    if (!isYes && !isNo && !sendMatch) return;

    if (pendingQueue.length === 0) {
      await client.sendMessage(selfChatId, 'ℹ️ No pending drafts to act on.');
      return;
    }

    const pending = pendingQueue.shift();
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
      pushMemory(pending.contactId, 'assistant', finalText);
    }

    if (pendingQueue.length > 0) {
      await client.sendMessage(selfChatId, `(${pendingQueue.length} more draft(s) still pending — next up: ${pendingQueue[0].contactLabel})`);
    }

    return;
  }

  // --- Case 2: group message -> check for birthday wishes ---
  if (msg.from.endsWith('@g.us')) {
    if (!msg.fromMe) {
      await handleBirthdayMessage(msg);
    }
    return;
  }

  // --- Case 3: incoming message from ANY individual (not a group, not yourself) -> draft a reply ---
  const isIndividualChat = msg.from.endsWith('@c.us') || msg.from.endsWith('@lid');
  const isFromSomeoneElse = !msg.fromMe;
  const isNotSelfChat = msg.from !== selfChatId;

  if (isIndividualChat && isFromSomeoneElse && isNotSelfChat) {
    let chat = null;
    try {
      chat = await msg.getChat();
    } catch (err) {
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
        messages: history,
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
