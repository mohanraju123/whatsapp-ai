require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Set to false to actually delete. Keep true first to review the list safely.
const DRY_RUN = false;

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

client.on('ready', async () => {
  console.log('Client ready. Scanning chats for business accounts...');

  let contacts;
  try {
    contacts = await client.getContacts();
  } catch (err) {
    console.error('getContacts() failed:', err.message);
    process.exit(1);
  }

  const businessContacts = contacts.filter(c => c.isBusiness && !c.isGroup);
  console.log(`Found ${businessContacts.length} business contact(s). Resolving their chats...`);

  const businessChats = [];

  for (const contact of businessContacts) {
    try {
      const chat = await contact.getChat();
      businessChats.push({ name: contact.pushname || contact.name || contact.number, chat });
    } catch (err) {
      // Skip contacts whose chat can't be resolved (e.g. @lid resolution issues) instead of crashing
      console.error(`Skipping "${contact.pushname || contact.number}" — could not resolve chat:`, err.message);
    }
  }

  console.log(`\nFound ${businessChats.length} business chat(s):`);
  businessChats.forEach(({ name }) => console.log(` - ${name}`));

  if (DRY_RUN) {
    console.log('\nDRY_RUN is true — nothing deleted. Review the list above, then set DRY_RUN = false to actually delete.');
    process.exit(0);
  }

  for (const { name, chat } of businessChats) {
    try {
      await chat.delete();
      console.log(`Deleted chat: ${name}`);
    } catch (err) {
      console.error(`Failed to delete chat ${name}:`, err.message);
    }
  }

  console.log('\nDone.');
  process.exit(0);
});

client.initialize();
