require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Anthropic } = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---- CONFIG ----

// The group chat IDs you want this to run in. Format: '<numbers>@g.us'
// Leave empty and run once to discover IDs (see the DEBUG log below), then fill this in.
const ALLOWED_GROUPS = [
  // '120363012345678901@g.us',
  // '120363019876543210@g.us',
];

// Keywords that suggest a birthday wish is happening in the chat
const BIRTHDAY_REGEX = /\b(happy\s*birthday|hbd|happiest\s*birthday)\b/i;

// Only send one auto-wish per group per calendar day, so we don't spam
// every time someone else also says "happy birthday" in the same thread.
const lastWishedDate = new Map(); // chatId -> 'YYYY-MM-DD'

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---- CLIENT SETUP ----

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log("Scan this QR code with your phone's WhatsApp to log in:");
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('Birthday-wish bot ready and watching groups.');
});

client.on('message_create', async (msg) => {
  if (msg.fromMe) return; // don't react to our own messages (avoids loops)
  if (!msg.from.endsWith('@g.us')) return; // groups only

  // DEBUG: uncomment this line to discover group IDs, then comment it back out
  // console.log('Group message from:', msg.from, '| body:', msg.body);

  if (ALLOWED_GROUPS.length && !ALLOWED_GROUPS.includes(msg.from)) return;

  if (!BIRTHDAY_REGEX.test(msg.body)) return;

  const today = todayStr();
  if (lastWishedDate.get(msg.from) === today) return; // already wished in this group today

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      system: "Write ONE short, warm, casual birthday wish for a WhatsApp group chat. 1 sentence, no name (you don't know who it's for), can include an emoji, sound natural and not templated. Output ONLY the message text, nothing else.",
      messages: [{ role: 'user', content: 'Write a birthday wish.' }],
    });

    const wish = response.content[0].text.trim();

    lastWishedDate.set(msg.from, today); // mark before sending, avoids race on rapid messages

    setTimeout(async () => {
      await client.sendMessage(msg.from, wish);
      console.log(`Sent birthday wish to ${msg.from}: ${wish}`);
    }, 3000 + Math.random() * 4000); // small random delay so it doesn't look instant/robotic

  } catch (error) {
    console.error('Error generating/sending birthday wish:', error);
  }
});

client.initialize();
