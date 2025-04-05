const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Gemini API初期化
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 環境変数からモデル名を取得（デフォルトはgemini-2.0-flash）
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// エラーメッセージを環境変数から取得
const ERROR_MESSAGE = process.env.ERROR_MESSAGE || '残念だが、その質問には答えられんな';

// システムプロンプトを環境変数から取得
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '';

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

// 使用するモデルを初期化
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

console.log(`Using Gemini model: ${MODEL_NAME}`);

// 会話履歴を保存するオブジェクト
const conversations = {};

// 会話履歴の最大長
const MAX_CONTEXT_LENGTH = parseInt(process.env.MAX_CONTEXT_LENGTH || '10');

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
      chatOptions.history.push({ role: 'model', parts: SYSTEM_PROMPT });
    }

    conversations[conversationId] = model.startChat(chatOptions);
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
 * @returns {Promise<string>} Geminiからの応答
 */
async function sendMessage(conversationId, message) {
  try {
    // プロンプトインジェクション検出
    if (!isMessageSafe(message)) {
      return ERROR_MESSAGE;
    }
    
    console.log("conversationId:", conversationId);
    initConversation(conversationId);
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