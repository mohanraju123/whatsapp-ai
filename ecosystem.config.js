module.exports = {
  apps: [
    {
      name: 'whatsapp-bot',
      script: './index.js',
      autorestart: true,       // restart automatically whenever the process exits
      max_restarts: 1000,      // effectively unlimited for a long-running bot
      restart_delay: 3000,     // wait 3s between restarts, avoids hammering on repeated crashes
      min_uptime: '10s',       // only counts as a "successful" run if it stays up this long
    }
  ]
};
