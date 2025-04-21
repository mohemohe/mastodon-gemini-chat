import 'dotenv/config';
import { connect, disconnect } from './src/mastodon';

console.log('Starting Mastodon Gemini Chat Bot...');

const requiredEnvVars = [
  'MASTODON_SERVER',
  'MASTODON_ACCESS_TOKEN',
  'GEMINI_API_KEY'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:');
  for (const varName of missingEnvVars) {
    console.error(`- ${varName}`);
  }
  console.error('Please set these variables in the .env file');
  process.exit(1);
}

connect();

console.log('Bot is running. Press Ctrl+C to stop.');

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