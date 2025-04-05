const megalodon = require('megalodon');
const { sendMessage } = require('./gemini');
require('dotenv').config();

// 環境変数から設定を読み込む
const MASTODON_SERVER = process.env.MASTODON_SERVER;
const MASTODON_ACCESS_TOKEN = process.env.MASTODON_ACCESS_TOKEN;

// Megalodonクライアントの初期化
const client = megalodon.default(
  'mastodon',
  MASTODON_SERVER,
  MASTODON_ACCESS_TOKEN
);

// WebSocketストリーム
let stream = null;

// 会話コンテキストを管理するためのマップ
// key: 会話相手のアカウントID, value: {id: 会話ID, timestamp: 最終更新時間}
const conversationContexts = new Map();

// 会話コンテキストの設定
const CONTEXT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24時間
const MAX_CONTEXTS = 1000; // 最大保持数

/**
 * 古い会話コンテキストをクリーンアップする
 */
function cleanupConversationContexts() {
  const now = Date.now();
  
  // 有効期限切れのコンテキストを削除
  for (const [accountId, context] of conversationContexts.entries()) {
    if (now - context.timestamp > CONTEXT_EXPIRY_MS) {
      conversationContexts.delete(accountId);
    }
  }
  
  // 最大数を超えた場合、最も古いものから削除
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

// 定期的にクリーンアップを実行（1時間ごと）
setInterval(cleanupConversationContexts, 60 * 60 * 1000);

/**
 * ストリーミングに接続する
 */
function connect() {
  console.log('Connecting to Mastodon streaming API...');
  
  try {
    // ユーザーストリームに接続
    stream = client.userStream();
    
    // 通知イベントのリスナー
    stream.on('notification', async (notification) => {
      try {
        // メンション通知かどうか確認
        if (notification.type === 'mention') {
          await handleMention(notification);
        }
      } catch (error) {
        console.error('Error processing notification:', error);
      }
    });
    
    // エラーイベントのリスナー
    stream.on('error', (err) => {
      console.error('Stream error:', err);
      reconnect();
    });
    
    // 接続終了イベントのリスナー
    stream.on('close', () => {
      console.log('Stream connection closed');
      reconnect();
    });
    
    // 接続イベントのリスナー
    stream.on('connect', () => {
      console.log('Connected to Mastodon streaming API');
    });
    
    // メッセージ受信イベントのリスナー
    stream.on('update', (status) => {
      console.log('Received status update');
    });
    
  } catch (error) {
    console.error('Failed to connect to Mastodon:', error);
    reconnect();
  }
}

/**
 * 再接続処理
 */
function reconnect() {
  // 既存のストリームをクリーンアップ
  if (stream) {
    try {
      stream.stop();
    } catch (error) {
      console.error('Error stopping stream:', error);
    }
    stream = null;
  }
  
  // 5秒後に再接続
  setTimeout(() => {
    console.log('Reconnecting to Mastodon...');
    connect();
  }, 5000);
}

/**
 * メンション通知を処理する
 * @param {Object} notification - 通知オブジェクト
 */
async function handleMention(notification) {
  const status = notification.status;
  const content = stripHtml(status.content);
  const accountId = status.account.id;
  
  // "!"で始まるメンションはスキップ
  if (content.includes(`@${status.account.acct} !`)) {
    console.log('Skipping mention with ! mark');
    return;
  }
  
  // 会話コンテキストを取得または作成
  let conversationContext = conversationContexts.get(accountId);
  let conversationId;
  
  if (!conversationContext) {
    conversationId = `${accountId}-${Date.now()}`;
    conversationContexts.set(accountId, {
      id: conversationId,
      timestamp: Date.now()
    });
  } else {
    conversationId = conversationContext.id;
    // タイムスタンプを更新
    conversationContexts.set(accountId, {
      id: conversationId,
      timestamp: Date.now()
    });
  }
  
  // Geminiにメッセージを送信
  const response = await sendMessage(conversationId, content);
  
  // Mastodonに返信を投稿（元の投稿のvisibilityを引き継ぐ）
  await postReply(status.id, response, status.visibility);
}

/**
 * HTMLタグを除去してテキストを抽出する
 * @param {string} html - HTMLテキスト
 * @returns {string} プレーンテキスト
 */
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Mastodonに返信を投稿する
 * @param {string} statusId - 返信先の投稿ID
 * @param {string} content - 返信内容
 * @param {string} visibility - 投稿の公開範囲（'public', 'unlisted', 'private', 'direct'）
 */
async function postReply(statusId, content, visibility = 'unlisted') {
  try {
    // megalodonクライアントを使用して返信を投稿
    const response = await client.postStatus(content, {
      in_reply_to_id: statusId,
      visibility: visibility // 元の投稿のvisibilityを引き継ぐ
    });
    
    console.log(`Reply posted successfully with visibility '${visibility}':`, response.data.id);
  } catch (error) {
    console.error('Error posting reply:', error);
  }
}

/**
 * ストリーミング接続を停止する
 */
function disconnect() {
  if (stream) {
    try {
      stream.stop();
      console.log('Disconnected from Mastodon streaming API');
    } catch (error) {
      console.error('Error disconnecting from stream:', error);
    }
    stream = null;
  }
}

module.exports = {
  connect,
  disconnect
}; 