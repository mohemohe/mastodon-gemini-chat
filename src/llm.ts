import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { createAgent, tool } from 'langchain';
import { InMemoryStore, type Runtime } from '@langchain/langgraph';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { initializeMcp, isMcpAvailable } from './mcp';
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';
dotenv.config();

// LLMプロバイダーの設定（デフォルト: gemini）
const LLM_PROVIDER: string = process.env.LLM_PROVIDER || 'gemini';

// 環境変数からモデル名を取得（カンマ区切りで複数指定可能）
const MODEL_NAMES: string[] = LLM_PROVIDER === 'gemini'
  ? (process.env.GEMINI_MODEL || 'gemini-2.0-flash,gemini-2.0-flash-lite').split(',').map(model => model.trim())
  : [(process.env.OPENAI_MODEL || 'gpt-4o-mini')];
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

const modelInstances: Record<string, ChatGoogleGenerativeAI | ChatOpenAI> = {};

const modelLastUsed: { timestamp: number; modelIndex: number } = {
  timestamp: Date.now(),
  modelIndex: 0
};

console.log(`LLM Provider: ${LLM_PROVIDER}`);
console.log(`Available models: ${MODEL_NAMES.join(', ')}`);
console.log(`Using model: ${MODEL_NAMES[currentModelIndex]}`);

// v1でInMemoryChatMessageHistoryがなくなったため、シンプルな配列で管理
const messageHistories: Record<string, BaseMessage[]> = {};

const MAX_CONTEXT_LENGTH: number = Number.parseInt(process.env.MAX_CONTEXT_LENGTH || '10');

// MCP関連の変数
let mcpClient: MultiServerMCPClient | null = null;
let agentWithTools: any = null;

// ストアの初期化
const store = new InMemoryStore();

function getMessageHistory(conversationId: string): BaseMessage[] {
  if (!messageHistories[conversationId]) {
    messageHistories[conversationId] = [];
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

function getModelInstance(modelName: string): ChatGoogleGenerativeAI | ChatOpenAI {
  if (!modelInstances[modelName]) {
    if (LLM_PROVIDER === 'gemini') {
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
    } else if (LLM_PROVIDER === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      const baseURL = process.env.OPENAI_BASE_URL;

      const config: any = {
        model: modelName,
        temperature: 1.8,
        maxTokens: 1024
      };

      // API Keyが設定されている場合のみ使用
      if (apiKey) {
        config.apiKey = apiKey;
      }

      // Base URLが設定されている場合のみ使用
      if (baseURL) {
        config.configuration = {
          baseURL: baseURL
        };
      }

      modelInstances[modelName] = new ChatOpenAI(config);
    } else {
      throw new Error(`Unsupported LLM_PROVIDER: ${LLM_PROVIDER}`);
    }
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

/**
 * MCPクライアントとエージェントを初期化する
 */
async function initializeMcpAgent(): Promise<void> {
  if (mcpClient !== null || agentWithTools !== null) {
    return; // すでに初期化済み
  }

  try {
    const mcpAdapter = await initializeMcp();
    if (!mcpAdapter || !isMcpAvailable()) {
      console.log('MCP is not available - using basic model');
      return;
    }

    console.log('Initializing MCP client with tools...');

    // 基本ツールを定義
    const basicTools = [
      tool(
        async () => {
          const now = new Date();
          return now.toLocaleString('ja-JP', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          });
        },
        {
          name: 'get_current_time',
          description: 'Get the current date and time in Japanese format',
        }
      ),
    ];

    const modelName = getCurrentModelName();
    const model = getModelInstance(modelName);

    // 基本エージェントを作成
    agentWithTools = createAgent({
      model,
      tools: basicTools,
      store,
    });

    console.log('MCP agent initialized successfully');
  } catch (error) {
    console.error('Failed to initialize MCP agent:', error);
    // MCPが利用できなくても基本機能は利用できるようにする
    agentWithTools = null;
  }
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

    // MCPエージェントを初期化（まだ初期化されていない場合）
    if (agentWithTools === null) {
      await initializeMcpAgent();
    }

    updateModelUsage();

    // MCPエージェントが利用可能な場合はエージェントを使用
    if (agentWithTools !== null) {
      try {
        const formattedDate = getFormattedDateTime();
        const fullSystemPrompt = `## 基本的な情報
現在の日時は${formattedDate}です。
タイムゾーンは${process.env.TZ || "JST"}です。
日付を扱う場合はユーザーの言語を考慮してください（例: 日本語 -> JST, UTC+9, Asia/Tokyo）。
使用しているAIのモデルは${getCurrentModelName()}です。
${isMessageSafe(userName) ? `会話相手のユーザー名は「${userName}」です。会話相手のユーザー名の先頭に「@」を付けないでください。` : ''}

${systemPrompt}`;

        // 履歴をメッセージ形式に変換
        const messages: any[] = [];

        // システムプロンプトを追加
        messages.push({ role: 'user', content: fullSystemPrompt });
        messages.push({ role: 'assistant', content: '了解しました。' });

        // 履歴を追加
        for (const item of history) {
          if (item.role === 'user') {
            messages.push({ role: 'user', content: item.content });
          } else if (item.role === 'assistant' || item.role === 'model') {
            messages.push({ role: 'assistant', content: item.content });
          }
        }

        // 現在のメッセージを追加
        if (message) {
          messages.push({ role: 'user', content: message });
        }

        // エージェントを呼び出し
        const result = await agentWithTools.invoke({
          messages,
        }, {
          // userIdをコンテキストとして提供（将来的な個人化用）
          context: { userId: conversationId },
        });

        const responseText = result.messages[result.messages.length - 1]?.content || '';
        const filteredText = filterResponse(responseText);

        // メッセージ履歴を更新
        const messageHistory = getMessageHistory(conversationId);
        if (message) {
          messageHistory.push(new HumanMessage(message));
        }
        messageHistory.push(new AIMessage(filteredText));

        return filteredText;

      } catch (agentError) {
        console.error('Agent execution failed, falling back to basic model:', agentError);
        // エージェントが失敗した場合は基本モデルにフォールバック
        agentWithTools = null;
      }
    }

    // 基本モデルを使用（フォールバックまたはMCP未使用時）
    const messageHistory = getMessageHistory(conversationId);
    if (history.length > 0) {
      await clearConversation(conversationId);
      for (const item of history) {
        if (item.role === 'user') {
          messageHistory.push(new HumanMessage(item.content));
        } else if (item.role === 'assistant' || item.role === 'model') {
          messageHistory.push(new AIMessage(item.content));
        }
      }
    }
    if (message) {
      messageHistory.push(new HumanMessage(message));
    }
    const formattedDate = getFormattedDateTime();
    const systemMessage = new SystemMessage(`## 基本的な情報
現在の日時は${formattedDate}です。
タイムゾーンは${process.env.TZ || "JST"}です。
日付を扱う場合はユーザーの言語を考慮してください（例: 日本語 -> JST, UTC+9, Asia/Tokyo）。
使用しているAIのモデルは${getCurrentModelName()}です。
${isMessageSafe(userName) ? `会話相手のユーザー名は「${userName}」です。会話相手のユーザー名の先頭に「@」を付けないでください。` : ''}

${systemPrompt}`);
    let messages: BaseMessage[] = messageHistory;
    messages = [systemMessage, ...messages];
    if (messages.length > MAX_CONTEXT_LENGTH + 1) {
      const systemMessage = messages[0];
      messages = [systemMessage, ...messages.slice(-MAX_CONTEXT_LENGTH)];
    }
    const modelName = getCurrentModelName();
    const model = getModelInstance(modelName);
    let text = '';
    // 画像入力対応モデルの判定
    let isImageInputSupported = false;
    if (LLM_PROVIDER === 'gemini') {
      // vision, flash, proを含むモデルは画像入力対応とみなす
      isImageInputSupported = /(vision|flash|pro)/.test(modelName);
    } else if (LLM_PROVIDER === 'openai') {
      // OpenAI: vision, gpt-4o, gpt-4-turboなどは画像対応
      isImageInputSupported = /(vision|gpt-4o|gpt-4-turbo)/.test(modelName);
    }
    const inputMessages = messages;
    // imageはbase64データURL前提（Mastodon側で変換済み）
    if (isImageInputSupported && image) {
      const last = inputMessages[inputMessages.length - 1];
      if (last instanceof HumanMessage) {
        last.content = [
          { type: 'text', text: message || '画像を解析してください。' },
          { type: 'image_url', image_url: image }
        ];
      }
    }
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
    messageHistory.push(new AIMessage(filteredText));
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
    messageHistories[conversationId] = [];
  }
} 