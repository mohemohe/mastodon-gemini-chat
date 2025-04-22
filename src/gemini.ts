import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import fs from 'node:fs';
import dotenv from 'dotenv';
dotenv.config();

// 環境変数からモデル名を取得（カンマ区切りで複数指定可能）
const MODEL_NAMES: string[] = (process.env.GEMINI_MODEL || 'gemini-2.0-flash,gemini-2.0-flash-lite').split(',').map(model => model.trim());
let currentModelIndex = 0;

// エラーメッセージを環境変数から取得
const ERROR_MESSAGE: string = process.env.ERROR_MESSAGE || '残念だが、その質問には答えられんな';

/**
 * システムプロンプトをファイルから読み込む
 * @returns {string} システムプロンプト
 */
function loadSystemPrompt(): string {
  try {
    const systemPromptPath = process.env.SYSTEM_PROMPT_PATH;
    if (systemPromptPath && fs.existsSync(systemPromptPath)) {
      return fs.readFileSync(systemPromptPath, 'utf8').trim();
    }
  } catch (error) {
    console.error('Error loading system prompt from file:', error);
  }
  return process.env.SYSTEM_PROMPT || '';
}

const SYSTEM_PROMPT: string = loadSystemPrompt();

function getFormattedDateTime(): string {
  const now = new Date();
  return now.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\//g, '/').replace(/,/g, '');
}

const BLOCKED_PATTERNS: RegExp[] = [
  /ignore previous instructions/i,
  /ignore all instructions/i,
  /ignore your instructions/i,
  /system prompt/i,
  /system instruction/i,
  /you are a/i,
  /act as/i,
  /pretend to be/i,
  /forget your previous instructions/i,
  /disregard/i,
  /システム/i,
  /プロンプト/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate limit/i,
  /quota exceeded/i,
  /too many requests/i,
  /429/i
];

const NOT_FOUND_PATTERNS: RegExp[] = [
  /not found/i,
  /404/i
];

const modelInstances: Record<string, ChatGoogleGenerativeAI> = {};

const modelLastUsed: { timestamp: number; modelIndex: number } = {
  timestamp: Date.now(),
  modelIndex: 0
};

console.log(`Available Gemini models: ${MODEL_NAMES.join(', ')}`);
console.log(`Using Gemini model: ${MODEL_NAMES[currentModelIndex]}`);

const messageHistories: Record<string, InMemoryChatMessageHistory> = {};

const MAX_CONTEXT_LENGTH: number = Number.parseInt(process.env.MAX_CONTEXT_LENGTH || '10');

function getMessageHistory(conversationId: string): InMemoryChatMessageHistory {
  if (!messageHistories[conversationId]) {
    messageHistories[conversationId] = new InMemoryChatMessageHistory();
  }
  return messageHistories[conversationId];
}

function updateModelUsage(): boolean {
  const now = Date.now();
  const elapsedMinutes = Math.floor((now - modelLastUsed.timestamp) / 60000);
  if (elapsedMinutes >= 1 && currentModelIndex !== 0) {
    currentModelIndex = 0;
    modelLastUsed.timestamp = now;
    modelLastUsed.modelIndex = 0;
    console.log(`Switching back to primary model: ${MODEL_NAMES[currentModelIndex]}`);
    return true;
  }
  return false;
}

function switchToNextModel(): boolean {
  const nextIndex = (currentModelIndex + 1) % MODEL_NAMES.length;
  if (nextIndex === currentModelIndex) {
    return false;
  }
  currentModelIndex = nextIndex;
  modelLastUsed.timestamp = Date.now();
  modelLastUsed.modelIndex = nextIndex;
  console.log(`Switching to model: ${MODEL_NAMES[currentModelIndex]}`);
  return true;
}

function getCurrentModelName(): string {
  return MODEL_NAMES[currentModelIndex];
}

function isRateLimitError(error: Error): boolean {
  const errorMessage = error.message.toLowerCase();
  return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(errorMessage));
}

function isNotFoundError(error: Error): boolean {
  const errorMessage = error.message.toLowerCase();
  return NOT_FOUND_PATTERNS.some(pattern => pattern.test(errorMessage));
}

function getModelInstance(modelName: string): ChatGoogleGenerativeAI {
  if (!modelInstances[modelName]) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set');
    }
    modelInstances[modelName] = new ChatGoogleGenerativeAI({
      apiKey,
      model: modelName,
      temperature: 1.8,
      maxOutputTokens: 1024
    });
  }
  return modelInstances[modelName];
}

function isMessageSafe(message: string): boolean {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(message)) {
      return false;
    }
  }
  return true;
}

function filterResponse(response: string): string {
  if (!SYSTEM_PROMPT) return response;
  if (response.includes(SYSTEM_PROMPT)) {
    return ERROR_MESSAGE;
  }
  const formattedDate = getFormattedDateTime();
  const datePrompt = `現在の日時は${formattedDate}です。`;
  if (response.includes(datePrompt)) {
    return ERROR_MESSAGE;
  }
  return response;
}

export async function sendMessage(
  systemPrompt: string,
  conversationId: string,
  userName: string,
  message: string,
  history: Array<{ role: string; content: string }> = [],
  image?: string,
  recursiveCount = 0,
): Promise<string> {
  if (recursiveCount > (Object.keys(modelInstances).length * 3) + 1) {
    return ERROR_MESSAGE;
  }

  try {
    if (!isMessageSafe(message)) {
      return ERROR_MESSAGE;
    }
    console.log('conversationId:', conversationId);
    updateModelUsage();
    const messageHistory = getMessageHistory(conversationId);
    if (history.length > 0) {
      await clearConversation(conversationId);
      for (const item of history) {
        if (item.role === 'user') {
          await messageHistory.addUserMessage(item.content);
        } else if (item.role === 'assistant' || item.role === 'model') {
          await messageHistory.addAIMessage(item.content);
        }
      }
    }
    if (message) {
      await messageHistory.addUserMessage(message);
    }
    const formattedDate = getFormattedDateTime();
    const systemMessage = new SystemMessage(`#基本的な情報\n現在の日時は${formattedDate}です。\n使用しているAIのモデルは${getCurrentModelName()}です。\n${isMessageSafe(userName) ? `会話相手のユーザー名は「${userName}」です。会話相手のユーザー名の先頭に「@」を付けないでください。` : ''}\n\n${systemPrompt}`);
    let messages: BaseMessage[] = await messageHistory.getMessages();
    messages = [systemMessage, ...messages];
    if (messages.length > MAX_CONTEXT_LENGTH + 1) {
      const systemMessage = messages[0];
      messages = [systemMessage, ...messages.slice(-MAX_CONTEXT_LENGTH)];
    }
    const modelName = getCurrentModelName();
    const model = getModelInstance(modelName);
    let text = '';
    // vision, flash, proを含むモデルは画像入力対応とみなす
    const isImageInputSupported = /(vision|flash|pro)/.test(modelName);
    const inputMessages = messages;
    // imageはbase64データURL前提（Mastodon側で変換済み）
    if (isImageInputSupported && image) {
      const last = inputMessages[inputMessages.length - 1];
      console.log('last:', last);
      console.log('image:', image);
      if (last instanceof HumanMessage) {
        last.content = [
          { type: 'text', text: message || '画像を解析してください。' },
          { type: 'image_url', image_url: image }
        ];
      }
    }
    console.log('messages:', JSON.parse(JSON.stringify(messages)));
    for (let i = 0; i < 3; i++) {
      try {
        const response = await model.invoke(inputMessages, {
          timeout: 60000,
        });
        text = response.text;
        if (!text) {
          throw new Error('Missing response text');
        }
        if (text) {
          break;
        }
      } catch (error) {
        const err = error as Error;
        console.error(`LangChain API error (attempt ${i + 1}/3):`, err);
        if (i === 2 || isRateLimitError(err) || isNotFoundError(err)) {
          console.log('Rate limit or critical error detected, attempting to switch models...');
          if (switchToNextModel()) {
            return sendMessage(systemPrompt, conversationId, userName, message, history, image, recursiveCount + 1);
          }
          if (i === 2) break;
        }
      }
    }
    const filteredText = filterResponse(text);
    await messageHistory.addAIMessage(filteredText);
    return filteredText;
  } catch (error) {
    const err = error as Error;
    console.error('LangChain API error:', err);
    if (isRateLimitError(err) || isNotFoundError(err)) {
      console.log('Rate limit detected, attempting to switch models...');
      if (switchToNextModel()) {
        return sendMessage(systemPrompt, conversationId, userName, message, history, image, recursiveCount + 1);
      }
    }
    return ERROR_MESSAGE;
  }
}

export async function clearConversation(conversationId: string): Promise<void> {
  if (messageHistories[conversationId]) {
    await messageHistories[conversationId].clear();
  }
} 