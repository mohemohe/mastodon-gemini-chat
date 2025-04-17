const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Gemini API初期化
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// 環境変数からモデル名を取得（カンマ区切りで複数指定可能）
const MODEL_NAMES = (process.env.GEMINI_MODEL || 'gemini-2.0-flash,gemini-2.0-flash-lite').split(',').map(model => model.trim());
let currentModelIndex = 0;

// エラーメッセージを環境変数から取得
const ERROR_MESSAGE = process.env.ERROR_MESSAGE || '残念だが、その質問には答えられんな';

/**
 * システムプロンプトをファイルから読み込む
 * @returns {string} システムプロンプト
 */
function loadSystemPrompt() {
  try {
    // システムプロンプトのパスを環境変数から取得
    const systemPromptPath = process.env.SYSTEM_PROMPT_PATH;
    if (systemPromptPath && fs.existsSync(systemPromptPath)) {
      return fs.readFileSync(systemPromptPath, 'utf8').trim();
    }
  } catch (error) {
    console.error('Error loading system prompt from file:', error);
  }
  
  // ファイルが存在しない、または読み込みに失敗した場合は環境変数から取得
  return process.env.SYSTEM_PROMPT || '';
}

// システムプロンプトを読み込む
const SYSTEM_PROMPT = loadSystemPrompt();

// 現在時刻をフォーマットして取得
const now = new Date();
const formattedDate = now.toLocaleString('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
}).replace(/\//g, '/').replace(/,/g, '');

// システムプロンプトに時刻情報を追加
const SYSTEM_PROMPT_WITH_TIME = `現在の日時は${formattedDate}です。\n${SYSTEM_PROMPT}`;

// プロンプトインジェクション防止のためのブロックワード
const BLOCKED_PATTERNS = [
  /ignore previous instructions/i,
  /ignore all instructions/i,
  /ignore your instructions/i,
  /system prompt/i,
  /system instruction/i,
  /you are a/i,
  /act as/i,
  /pretend to be/i,
  /forget your previous instructions/i,
  /disregard/i
];

// レート制限エラーを検出するためのパターン
const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /quota exceeded/i,
  /too many requests/i,
  /429/i
];

// 使用するモデルを初期化
const models = MODEL_NAMES.map(modelName => genAI.getGenerativeModel({ model: modelName }));

// モデルの最終使用時刻を記録するオブジェクト
const modelLastUsed = {
  timestamp: Date.now(),
  modelIndex: 0
};

console.log(`Available Gemini models: ${MODEL_NAMES.join(', ')}`);
console.log(`Using Gemini model: ${MODEL_NAMES[currentModelIndex]}`);

// 会話履歴を保存するオブジェクト
const conversations = {};

// 会話履歴の最大長
const MAX_CONTEXT_LENGTH = parseInt(process.env.MAX_CONTEXT_LENGTH || '10');

/**
 * モデルの使用時刻を更新し、必要に応じてモデルを切り替える
 * @returns {boolean} モデルが切り替わったかどうか
 */
function updateModelUsage() {
  const now = Date.now();
  const elapsedMinutes = Math.floor((now - modelLastUsed.timestamp) / 60000);
  
  // 1分以上経過している場合、優先モデルに戻す
  if (elapsedMinutes >= 1 && currentModelIndex !== 0) {
    currentModelIndex = 0;
    modelLastUsed.timestamp = now;
    modelLastUsed.modelIndex = 0;
    console.log(`Switching back to primary model: ${MODEL_NAMES[currentModelIndex]}`);
    return true;
  }
  
  return false;
}

/**
 * 次のモデルに切り替える
 * @returns {boolean} 切り替えが成功したかどうか
 */
function switchToNextModel() {
  const nextIndex = (currentModelIndex + 1) % MODEL_NAMES.length;
  if (nextIndex === currentModelIndex) {
    return false; // 利用可能なモデルが1つしかない場合
  }
  currentModelIndex = nextIndex;
  modelLastUsed.timestamp = Date.now();
  modelLastUsed.modelIndex = nextIndex;
  console.log(`Switching to model: ${MODEL_NAMES[currentModelIndex]}`);
  return true;
}

/**
 * エラーがレート制限に関連するものかどうかを判定
 * @param {Error} error - エラーオブジェクト
 * @returns {boolean} レート制限エラーならtrue
 */
function isRateLimitError(error) {
  const errorMessage = error.message.toLowerCase();
  return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * 会話履歴を初期化する
 * @param {string} conversationId - 会話ID
 */
function initConversation(conversationId) {
  if (!conversations[conversationId]) {
    const chatOptions = {
      history: [],
      generationConfig: {
        temperature: 1.8,
        maxOutputTokens: 1024,
      },
    };

    // システムプロンプトが設定されている場合は追加
    if (SYSTEM_PROMPT) {
      chatOptions.history.push({ role: 'model', parts: SYSTEM_PROMPT_WITH_TIME });
    }

    conversations[conversationId] = models[currentModelIndex].startChat(chatOptions);
  }
}

/**
 * メッセージにプロンプトインジェクション攻撃が含まれていないか確認
 * @param {string} message - ユーザーからのメッセージ
 * @returns {boolean} 安全なメッセージならtrue、危険ならfalse
 */
function isMessageSafe(message) {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(message)) {
      return false;
    }
  }
  return true;
}

/**
 * レスポンスにシステムプロンプトが漏洩していないか確認する
 * @param {string} response - AIからの応答
 * @returns {string} フィルタリングされた応答
 */
function filterResponse(response) {
  // システムプロンプトが空の場合はフィルタリング不要
  if (!SYSTEM_PROMPT) return response;
  
  // もしシステムプロンプトの内容が応答に含まれていたら置換
  if (response.includes(SYSTEM_PROMPT)) {
    return ERROR_MESSAGE;
  }
  
  return response;
}

/**
 * メッセージを送信し、応答を取得する
 * @param {string} conversationId - 会話ID
 * @param {string} message - ユーザーからのメッセージ
 * @param {Array<{role: string, content: string}>} history - 会話履歴
 * @returns {Promise<string>} Geminiからの応答
 */
async function sendMessage(conversationId, message, history = []) {
  try {
    // プロンプトインジェクション検出
    if (!isMessageSafe(message)) {
      return ERROR_MESSAGE;
    }
    
    console.log("conversationId:", conversationId);
    
    // モデルの使用時刻を更新し、必要に応じてモデルを切り替える
    const modelSwitched = updateModelUsage();
    
    // 会話履歴が存在する場合は、それを使用してチャットを初期化
    if (history.length > 0 || modelSwitched) {
      const chatOptions = {
        history: history,
        generationConfig: {
          temperature: 1.8,
          maxOutputTokens: 1024,
        },
      };

      // システムプロンプトが設定されている場合は追加
      if (SYSTEM_PROMPT) {
        chatOptions.history.unshift({ role: 'model', parts: SYSTEM_PROMPT_WITH_TIME });
      }

      conversations[conversationId] = models[currentModelIndex].startChat(chatOptions);
    } else {
      initConversation(conversationId);
    }
    
    const chat = conversations[conversationId];
    
    const result = await chat.sendMessage(message);
    const response = await result.response;
    const text = response.text();
    
    // レスポンスのフィルタリング
    const filteredText = filterResponse(text);
    
    // 会話履歴が長すぎる場合は古い会話を削除
    if (chat.history?.length > MAX_CONTEXT_LENGTH * 2) {
      chat.history = chat.history.slice(-MAX_CONTEXT_LENGTH * 2);
    }
    
    return filteredText;
  } catch (error) {
    console.error('Gemini API error:', error);
    
    // レート制限エラーの場合、次のモデルに切り替えて再試行
    if (isRateLimitError(error)) {
      console.log('Rate limit detected, attempting to switch models...');
      if (switchToNextModel()) {
        // モデルを切り替えたら、会話を新しいモデルで再初期化して再試行
        delete conversations[conversationId];
        return sendMessage(conversationId, message, history);
      }
    }
    
    return ERROR_MESSAGE;
  }
}

/**
 * 会話履歴をクリアする
 * @param {string} conversationId - 会話ID
 */
function clearConversation(conversationId) {
  if (conversations[conversationId]) {
    delete conversations[conversationId];
  }
}

module.exports = {
  sendMessage,
  clearConversation
}; 