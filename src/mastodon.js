const megalodon = require('megalodon');
const { sendMessage } = require('./gemini');
const cheerio = require('cheerio');
require('dotenv').config();

// 環境変数から設定を読み込む
const MASTODON_SERVER = process.env.MASTODON_SERVER;
const MASTODON_ACCESS_TOKEN = process.env.MASTODON_ACCESS_TOKEN;

const domain = MASTODON_SERVER.split('://')[1];

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

let me_acct = "";

/**
 * ストリーミングに接続する
 */
function connect() {
  console.log('Connecting to Mastodon streaming API...');

  client.verifyAccountCredentials().then(response => {
    me_acct = response.data.acct;
  });
  
  try {
    // ユーザーストリームに接続
    stream = client.userSocket();
    
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
 * リプライツリーから会話履歴を構築する
 * @param {string} statusId - 現在の投稿ID
 * @returns {Promise<Array<{role: string, content: string}>>} 会話履歴の配列
 */
async function buildConversationHistory(statusId) {
  const history = [];
  let currentStatusId = statusId;
  
  try {
    // リプライツリーのコンテキストを取得
    const thread = await client.getStatusContext(statusId);

    // 先祖の投稿を時系列順に処理
    if (thread.data.ancestors) {
      // 作成日時順にソート
      const sortedAncestors = [...thread.data.ancestors].sort((a, b) => {
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      for (const ancestor of sortedAncestors) {
        const content = stripHtml(ancestor.content);
        // 自分自身の投稿かどうかを判定
        const isBot = ancestor.account.acct === me_acct;
        
        history.push({
          role: isBot ? 'model' : 'user',
          content: content
        });
      }
    }
    
    // 現在の投稿を追加
    const currentStatus = await client.getStatus(currentStatusId);
    const currentContent = stripHtml(currentStatus.data.content);
    const isCurrentBot = currentStatus.data.account.acct === me_acct;
    
    history.push({
      role: isCurrentBot ? 'model' : 'user',
      content: currentContent
    });
    
    return history;
  } catch (error) {
    console.error('Error building conversation history:', error);
    return [];
  }
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
  if (content.includes(`@${me_acct} !`) || content.includes(`@${me_acct}@${domain} !`)) {
    console.log('Skipping mention with ! mark');
    return;
  }

  // リプライツリーのルートIDを取得
  let rootStatusId = status.id;
  if (status.in_reply_to_id) {
    try {
      // リプライツリーの最初の投稿を取得
      const thread = await client.getStatusContext(status.id);
      if (thread.data.ancestors && thread.data.ancestors.length > 0) {
        // 作成日時順にソート
        const sortedAncestors = [...thread.data.ancestors].sort((a, b) => {
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
        // 最も古い投稿（先頭）をルートとして使用
        rootStatusId = sortedAncestors[0].id;
      }
    } catch (error) {
      console.error('Error fetching status context:', error);
    }
  }

  // 会話コンテキストを取得または作成
  let conversationContext = conversationContexts.get(accountId);
  let conversationId;

  console.log("conversationContext:", conversationContext);
  console.log("conversationContext.rootStatusId !== rootStatusId:", conversationContext?.rootStatusId !== rootStatusId);

  let isNewConversation = false;
  if (!conversationContext || conversationContext.rootStatusId !== rootStatusId) {
    isNewConversation = true;
    
    // 新規会話またはルートIDが変更された場合
    conversationId = `${accountId}-${rootStatusId}`;
    
    // リプライツリーから会話履歴を構築
    const history = await buildConversationHistory(status.id);
    
    conversationContexts.set(accountId, {
      id: conversationId,
      timestamp: Date.now(),
      rootStatusId: rootStatusId,
      history: history
    });
  } else {
    conversationId = conversationContext.id;
    // タイムスタンプを更新
    conversationContexts.set(accountId, {
      ...conversationContext,
      timestamp: Date.now()
    });
  }
  console.log("status.account:", status.account);
  // Geminiにメッセージを送信
  const response = await sendMessage(conversationId, status.account.display_name || status.account.username || status.account.acct, isNewConversation ? "" : content, isNewConversation ? conversationContexts.get(accountId).history : []);
  
  // 返信内容がメンションで始まっている場合はそのまま返信
  const replyContent = response.startsWith(`@${status.account.acct}`) ? response : `@${status.account.acct} ${response}`;

  // Mastodonに返信を投稿（元の投稿のvisibilityを引き継ぐ）
  await postReply(status.id, replyContent, status.visibility);
}

/**
 * HTMLタグを除去してテキストを抽出する
 * @param {string} html - HTMLテキスト
 * @returns {string} プレーンテキスト
 */
function stripHtml(html) {
  console.log("html:", html);
  html = html.replace(/<br\s*\/?>/gi, '###BR###');
  const $ = cheerio.load(html);
  const strippedHtml = $('body')
    .text()
    .replace(/\s+/g, ' ')
    .replace(/###BR###/gi, '\n')
    .trim();
  console.log("strippedHtml:", strippedHtml);
  return strippedHtml;
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