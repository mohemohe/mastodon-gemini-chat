import fs from 'node:fs';
import path from 'node:path';
import { clearConversation } from './gemini';

const DATA_DIR = path.resolve(__dirname, '../data');
const USERS_JSON_PATH = path.join(DATA_DIR, 'users.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function readUsersJson(): Record<string, { systemprompt: string }> {
  try {
    ensureDataDir();
    if (!fs.existsSync(USERS_JSON_PATH)) return {};
    const data = fs.readFileSync(USERS_JSON_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading users.json:', error);
    return {};
  }
}

export function writeUsersJson(users: Record<string, { systemprompt: string }>): void {
  try {
    ensureDataDir();
    fs.writeFileSync(USERS_JSON_PATH, JSON.stringify(users, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error writing users.json:', error);
  }
}

export function getSystemPromptFilePath(value?: string): string {
  ensureDataDir();
  if (!value || value.length === 0) {
    return path.join(DATA_DIR, '.systemprompt');
  }
  return path.join(DATA_DIR, `.systemprompt_${value}`);
}

export function isSystemPromptFile(value: string): boolean {
  return fs.existsSync(getSystemPromptFilePath(value));
}

export function listSystemPrompts(): string[] {
  ensureDataDir();
  const files =  fs.readdirSync(DATA_DIR);
  files.sort();
  console.log(files);
  return files.filter((file) => file.startsWith('.systemprompt')).map((file) => file.replace('.systemprompt_', '')).map((file) => {
    if (file === '.systemprompt') {
      return "''";
    }
    return file;
  });
}

export function setUserSystemPrompt(acct: string, value: string) {
  const users = readUsersJson();
  users[acct] = { systemprompt: value };
  writeUsersJson(users);
}

export function getUserSystemPrompt(acct: string): string | undefined {
  const users = readUsersJson();
  return users[acct]?.systemprompt;
}

export async function readSystemPrompt(value?: string, pastPosts?: string): Promise<string> {
  const filePath = getSystemPromptFilePath(value);
  let basePrompt = '';
  if (fs.existsSync(filePath)) {
    basePrompt = fs.readFileSync(filePath, 'utf-8');
  }
  
  if (pastPosts && pastPosts.trim().length > 0) {
    return basePrompt + '\n\n' + pastPosts;
  }
  
  return basePrompt;
}

export function isCommand(input: string): boolean {
  return input.trim().startsWith('!');
}

export function isChatCommand(input: string): boolean {
  return input.trim().startsWith('!chat');
}

const HELP_MESSAGE = `
!chat systemprompt [value] システムプロンプトを設定します。
!chat help ヘルプを表示します。`;

export function handleChatCommand(input: string, acct: string): string {
  const match = input.match(/^!chat (systemprompt|help)/);
  if (match) {
    const command = match[1];
    switch (command) {
      case 'systemprompt':
        // biome-ignore lint/correctness/noSwitchDeclarations: <explanation>
        const value = input.replace(/^!chat systemprompt/, '').trim();
        if (value.length === 0) {
          return `システムプロンプトは ${getUserSystemPrompt(acct) || "初期状態"} です。
!chat systemprompt [value]

values:
${listSystemPrompts().map((prompt) => `- ${prompt}`).join('\n')}`;
        }
        if (value === "''" || value === '""') {
          setUserSystemPrompt(acct, '');
          clearConversationContext(acct);
          return 'システムプロンプトを初期化しました。';
        }
        if (isSystemPromptFile(value)) {
          setUserSystemPrompt(acct, value);
          clearConversationContext(acct);
          return `システムプロンプトを ${value} に設定しました。`;
        }
        return '指定されたシステムプロンプトが見つかりません。';
      case 'help':
      default:
        return HELP_MESSAGE;
    }
  }
  return HELP_MESSAGE;
}

// 会話コンテキストを管理するためのマップ
// key: 会話相手のアカウントID, value: {id: 会話ID, timestamp: 最終更新時間}
type ConversationContext = {
  id: string;
  timestamp: number;
  rootStatusId: string;
  history: Array<{ role: string; content: string }>;
};

export const conversationContexts: Map<string, ConversationContext> = new Map();

const CONTEXT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24時間
const MAX_CONTEXTS = 1000; // 最大保持数

function cleanupConversationContexts(): void {
  const now = Date.now();
  for (const [accountId, context] of conversationContexts.entries()) {
    if (now - context.timestamp > CONTEXT_EXPIRY_MS) {
      conversationContexts.delete(accountId);
    }
  }
  if (conversationContexts.size > MAX_CONTEXTS) {
    const sortedContexts = [...conversationContexts.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const numberOfContextsToRemove = conversationContexts.size - MAX_CONTEXTS;
    for (let i = 0; i < numberOfContextsToRemove; i++) {
      conversationContexts.delete(sortedContexts[i][0]);
    }
  }
  console.log(`Cleaned up conversation contexts. Current count: ${conversationContexts.size}`);
}

setInterval(cleanupConversationContexts, 60 * 60 * 1000);

export function clearConversationContext(accountId: string): void {
  conversationContexts.delete(accountId);
}
