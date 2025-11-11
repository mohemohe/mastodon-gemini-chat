import 'dotenv/config';
import { connect, disconnect } from './src/mastodon';
import { initializeMcp, cleanupMcp } from './src/mcp';

console.log('Starting Mastodon Gemini Chat Bot...');

// 基本的な必須環境変数
const requiredEnvVars = [
  'MASTODON_SERVER',
  'MASTODON_ACCESS_TOKEN'
];

// プロバイダーに応じた必須環境変数を追加
const llmProvider = process.env.LLM_PROVIDER || 'gemini';
if (llmProvider === 'gemini') {
  requiredEnvVars.push('GEMINI_API_KEY');
}
// OpenAI互換APIの場合、API Keyは任意（ローカルLLMの場合は不要）

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:');
  for (const varName of missingEnvVars) {
    console.error(`- ${varName}`);
  }
  console.error('Please set these variables in the .env file');
  process.exit(1);
}

// MCP初期化を非同期で実行
async function initializeApp() {
  try {
    // MCP初期化（オプション）
    await initializeMcp();
    console.log('MCP initialization completed');
  } catch (error) {
    console.warn('MCP initialization failed, continuing without MCP:', error);
  }

  // Mastodon接続
  connect();
}

initializeApp();

console.log('Bot is running. Press Ctrl+C to stop.');

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  disconnect();
  console.log('Disconnected from Mastodon streaming API');

  // MCPクリーンアップ
  try {
    await cleanupMcp();
    console.log('MCP connections cleaned up');
  } catch (error) {
    console.error('Error during MCP cleanup:', error);
  }

  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  disconnect();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
}); 