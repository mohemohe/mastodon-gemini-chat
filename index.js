require('dotenv').config();
const { connect, disconnect } = require('./src/mastodon');

console.log('Starting Mastodon Gemini Chat Bot...');

// 環境変数のチェック
const requiredEnvVars = [
  'MASTODON_SERVER',
  'MASTODON_ACCESS_TOKEN',
  'GEMINI_API_KEY'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:');
  missingEnvVars.forEach(varName => console.error(`- ${varName}`));
  console.error('Please set these variables in the .env file');
  process.exit(1);
}

// Mastodon ストリーミングに接続
connect();

console.log('Bot is running. Press Ctrl+C to stop.');

// プロセス終了時の処理
process.on('SIGINT', () => {
  console.log('Shutting down...');
  disconnect();
  console.log('Disconnected from Mastodon streaming API');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  disconnect();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
}); 