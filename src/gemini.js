const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { InMemoryChatMessageHistory } = require('@langchain/core/chat_history');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

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

// 現在時刻をフォーマットして取得する関数
function getFormattedDateTime() {
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
  /disregard/i,
  /システム/i,
  /プロンプト/i,
];

// レート制限エラーを検出するためのパターン
const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /quota exceeded/i,
  /too many requests/i,
  /429/i
];

// レート制限エラーを検出するためのパターン
const NOT_FOUND_PATTERNS = [
  /not found/i,
  /404/i
];

// モデルインスタンスを保持するオブジェクト
const modelInstances = {};

// モデルの最終使用時刻を記録するオブジェクト
const modelLastUsed = {
  timestamp: Date.now(),
  modelIndex: 0
};

console.log(`Available Gemini models: ${MODEL_NAMES.join(', ')}`);
console.log(`Using Gemini model: ${MODEL_NAMES[currentModelIndex]}`);

// 会話履歴を保存するためのInMemoryChatMessageHistoryインスタンスを保持するオブジェクト
const messageHistories = {};

// 会話履歴の最大長
const MAX_CONTEXT_LENGTH = parseInt(process.env.MAX_CONTEXT_LENGTH || '10');

/**
 * 会話IDに対応するMessageHistoryを取得または作成する
 * @param {string} conversationId - 会話ID
 * @returns {InMemoryChatMessageHistory} MessageHistoryインスタンス
 */
function getMessageHistory(conversationId) {
  if (!messageHistories[conversationId]) {
    messageHistories[conversationId] = new InMemoryChatMessageHistory();
  }
  return messageHistories[conversationId];
}

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
 * 現在のモデル名を取得する
 * @returns {string} 現在のモデル名
 */
function getCurrentModelName() {
  return MODEL_NAMES[currentModelIndex];
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
 * エラーが404に関連するものかどうかを判定
 * @param {Error} error - エラーオブジェクト
 * @returns {boolean} 404エラーならtrue
 */
function isNotFoundError(error) {
  const errorMessage = error.message.toLowerCase();
  return NOT_FOUND_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * 指定されたモデル名のLangChainチャットモデルを取得または作成
 * @param {string} modelName - モデル名
 * @returns {ChatGoogleGenerativeAI} チャットモデルインスタンス
 */
function getModelInstance(modelName) {
  if (!modelInstances[modelName]) {
    modelInstances[modelName] = new ChatGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY,
      model: modelName,
      temperature: 1.8,
      maxOutputTokens: 1024
    });
  }
  return modelInstances[modelName];
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
  
  // システムプロンプトの内容が応答に含まれていたら置換
  if (response.includes(SYSTEM_PROMPT)) {
    return ERROR_MESSAGE;
  }
  
  // 現在時刻を含むシステムプロンプトも確認（完全一致でなくても部分一致で）
  const formattedDate = getFormattedDateTime();
  const datePrompt = `現在の日時は${formattedDate}です。`;
  if (response.includes(datePrompt)) {
    return ERROR_MESSAGE;
  }
  
  return response;
}

/**
 * メッセージを送信し、応答を取得する
 * @param {string} conversationId - 会話ID
 * @param {string} userName - ユーザー名
 * @param {string} message - ユーザーからのメッセージ
 * @param {Array<{role: string, content: string}>} history - 会話履歴
 * @returns {Promise<string>} Geminiからの応答
 */
async function sendMessage(conversationId, userName, message, history = []) {
  try {
    // プロンプトインジェクション検出
    if (!isMessageSafe(message)) {
      return ERROR_MESSAGE;
    }
    
    console.log("conversationId:", conversationId);
    
    // モデルの使用時刻を更新し、必要に応じてモデルを切り替える
    updateModelUsage();
    
    // 会話履歴を取得または作成
    const messageHistory = getMessageHistory(conversationId);
    
    // 既存の履歴がある場合は、それを使用
    if (history.length > 0) {
      // 履歴をクリアして新しく追加
      await clearConversation(conversationId);
      for (const item of history) {
        if (item.role === 'user') {
          await messageHistory.addUserMessage(item.content);
        } else if (item.role === 'assistant' || item.role === 'model') {
          await messageHistory.addAIMessage(item.content);
        }
      }
    }
    
    // ユーザーメッセージを追加
    if (message) {
      await messageHistory.addUserMessage(message);
    }
    
    // すべてのメッセージを取得
    let messages = await messageHistory.getMessages();
    
    // システムメッセージを追加
    if (SYSTEM_PROMPT) {
      const formattedDate = getFormattedDateTime();
      const systemMessage = new SystemMessage(`#基本的な情報
現在の日時は${formattedDate}です。
使用しているAIのモデルは${getCurrentModelName()}です。
${isMessageSafe(userName) ? `会話相手のユーザー名は「${userName}」です。` : ''}

${SYSTEM_PROMPT}`);
      messages = [systemMessage, ...messages];
    }
    
    // 会話履歴が長すぎる場合は古い会話を削除（システムメッセージを保持）
    if (messages.length > MAX_CONTEXT_LENGTH + 1) { // +1 はシステムメッセージ分
      const systemMessage = messages[0];
      messages = [systemMessage, ...messages.slice(-(MAX_CONTEXT_LENGTH))];
    }
    
    console.log("messages:", JSON.parse(JSON.stringify(messages)));
    
    // 現在のモデルインスタンスを取得
    const modelName = getCurrentModelName();
    const model = getModelInstance(modelName);
    
    // モデルに問い合わせ
    let text = "";
    for (let i = 0; i < 3; i++) {
      try {
        const response = await model.invoke(messages, {
          timeout: 60000,
        });
        text = response.text;
        if (!text) {
          continue;
        }
      } catch (error) {
        console.error('LangChain API error:', error);
        if (isRateLimitError(error) || isNotFoundError(error) || i == 2) {
          console.log('Rate limit detected, attempting to switch models...');
          if (switchToNextModel()) {
            // モデルを切り替えたら再試行
            return sendMessage(conversationId, userName, message, history);
          }
        }
      }
      break;
    }

    
    // レスポンスのフィルタリング
    const filteredText = filterResponse(text);
    
    // AIの応答を履歴に追加
    await messageHistory.addAIMessage(filteredText);
    
    return filteredText;
  } catch (error) {
    console.error('LangChain API error:', error);
    
    // エラーの場合、次のモデルに切り替えて再試行
    if (isRateLimitError(error) || isNotFoundError(error)) {
      console.log('Rate limit detected, attempting to switch models...');
      if (switchToNextModel()) {
        // モデルを切り替えたら再試行
        return sendMessage(conversationId, userName, message, history);
      }
    }
    
    return ERROR_MESSAGE;
  }
}

/**
 * 会話履歴をクリアする
 * @param {string} conversationId - 会話ID
 */
async function clearConversation(conversationId) {
  if (messageHistories[conversationId]) {
    await messageHistories[conversationId].clear();
  }
}

module.exports = {
  sendMessage,
  clearConversation
}; 