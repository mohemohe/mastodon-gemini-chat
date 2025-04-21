import megalodon from 'megalodon';
import type { MegalodonInterface, WebSocketInterface } from 'megalodon';
import type { Entity } from 'megalodon/lib/src/entity';
import { sendMessage } from './gemini';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
dotenv.config();

// 環境変数から設定を読み込む
const MASTODON_SERVER: string = process.env.MASTODON_SERVER || '';
const MASTODON_ACCESS_TOKEN: string = process.env.MASTODON_ACCESS_TOKEN || '';

const domain: string = MASTODON_SERVER.split('://')[1] || '';

// Megalodonクライアントの初期化
const client: MegalodonInterface = megalodon(
  'mastodon',
  MASTODON_SERVER,
  MASTODON_ACCESS_TOKEN
);

// WebSocketストリーム
let stream: WebSocketInterface | null = null;

// 会話コンテキストを管理するためのマップ
// key: 会話相手のアカウントID, value: {id: 会話ID, timestamp: 最終更新時間}
type ConversationContext = {
  id: string;
  timestamp: number;
  rootStatusId: string;
  history: Array<{ role: string; content: string }>;
};
const conversationContexts: Map<string, ConversationContext> = new Map();

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

let me_acct = '';

function connect(): void {
  console.log('Connecting to Mastodon streaming API...');
  client.verifyAccountCredentials().then(response => {
    me_acct = response.data.acct;
  });
  try {
    stream = client.userSocket();
    stream.on('notification', async (notification: Entity.Notification) => {
      try {
        if (notification.type === 'mention') {
          await handleMention(notification);
        }
      } catch (error) {
        console.error('Error processing notification:', error);
      }
    });
    stream.on('error', (err: Error) => {
      console.error('Stream error:', err);
      reconnect();
    });
    stream.on('close', () => {
      console.log('Stream connection closed');
      reconnect();
    });
    stream.on('connect', () => {
      console.log('Connected to Mastodon streaming API');
    });
    stream.on('update', (status: Entity.Status) => {
      console.log('Received status update');
    });
  } catch (error) {
    console.error('Failed to connect to Mastodon:', error);
    reconnect();
  }
}

function reconnect(): void {
  if (stream) {
    try {
      stream.stop();
    } catch (error) {
      console.error('Error stopping stream:', error);
    }
    stream = null;
  }
  setTimeout(() => {
    console.log('Reconnecting to Mastodon...');
    connect();
  }, 5000);
}

async function buildConversationHistory(statusId: string): Promise<Array<{ role: string; content: string }>> {
  const history: Array<{ role: string; content: string }> = [];
  const currentStatusId = statusId;
  try {
    const thread = await client.getStatusContext(statusId);
    const context = thread.data as Entity.Context;
    if (context.ancestors) {
      const sortedAncestors = [...context.ancestors].sort((a, b) => {
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
      for (const ancestor of sortedAncestors) {
        const content = stripHtml(ancestor.content);
        const isBot = ancestor.account.acct === me_acct;
        history.push({
          role: isBot ? 'model' : 'user',
          content: content
        });
      }
    }
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

async function handleMention(notification: Entity.Notification): Promise<void> {
  const status = notification.status as Entity.Status;
  const content = stripHtml(status.content);
  const accountId = status.account.id;
  if (content.includes(`@${me_acct} !`) || content.includes(`@${me_acct}@${domain} !`)) {
    console.log('Skipping mention with ! mark');
    return;
  }
  let rootStatusId = status.id;
  if (status.in_reply_to_id) {
    try {
      const thread = await client.getStatusContext(status.id);
      const context = thread.data as Entity.Context;
      if (context.ancestors && context.ancestors.length > 0) {
        const sortedAncestors = [...context.ancestors].sort((a, b) => {
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
        rootStatusId = sortedAncestors[0].id;
      }
    } catch (error) {
      console.error('Error fetching status context:', error);
    }
  }
  const conversationContext = conversationContexts.get(accountId);
  let conversationId: string;
  let isNewConversation = false;
  if (!conversationContext || conversationContext.rootStatusId !== rootStatusId) {
    isNewConversation = true;
    conversationId = `${accountId}-${rootStatusId}`;
    const history = await buildConversationHistory(status.id);
    conversationContexts.set(accountId, {
      id: conversationId,
      timestamp: Date.now(),
      rootStatusId: rootStatusId,
      history: history
    });
  } else {
    conversationId = conversationContext.id;
    conversationContexts.set(accountId, {
      ...conversationContext,
      timestamp: Date.now()
    });
  }
  const ctx = conversationContexts.get(accountId);
  const historyArg = isNewConversation ? (ctx ? ctx.history : []) : [];
  const response = await sendMessage(conversationId, status.account.display_name || status.account.username || status.account.acct, isNewConversation ? '' : content, historyArg);
  const replyContent = response.startsWith(`@${status.account.acct}`) ? response : `@${status.account.acct} ${response}`;
  await postReply(status.id, replyContent, status.visibility);
}

function stripHtml(html: string): string {
  const replaced = html.replace(/<br\s*\/?>(?![\s\S]*<br\s*\/?\s*>)/gi, '###BR###');
  const $ = cheerio.load(replaced);
  const strippedHtml = $('body')
    .text()
    .replace(/\s+/g, ' ')
    .replace(/###BR###/gi, '\n')
    .trim();
  return strippedHtml;
}

async function postReply(statusId: string, content: string, visibility: Entity.StatusVisibility = 'unlisted'): Promise<void> {
  try {
    const response = await client.postStatus(content, {
      in_reply_to_id: statusId,
      visibility: visibility
    });
    console.log(`Reply posted successfully with visibility '${visibility}':`, response.data.id);
  } catch (error) {
    console.error('Error posting reply:', error);
  }
}

function disconnect(): void {
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

export { connect, disconnect }; 