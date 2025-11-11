import megalodon from 'megalodon';
import type { MegalodonInterface, WebSocketInterface } from 'megalodon';
import type { Entity } from 'megalodon/lib/src/entity';
import { sendMessage } from './llm';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'node:fs';
import path from 'node:path';
import { setUserSystemPrompt, getUserSystemPrompt, getSystemPromptFilePath, isCommand, handleChatCommand, isChatCommand, conversationContexts, readSystemPrompt } from './chat';
dotenv.config();

/**
 * 画像URLをbase64データURLに変換する（Gemini API用）
 * @param imageUrl 画像のURL
 * @returns base64データURL
 */
async function imageUrlToBase64DataUrl(imageUrl: string): Promise<string> {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error('Failed to fetch image');
  const contentType = response.headers.get('content-type') || 'image/png';
  const buffer = await response.buffer();
  const base64 = buffer.toString('base64');
  return `data:${contentType};base64,${base64}`;
}

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
  const acct = status.account.acct;
  if (content.includes(`@${me_acct} !`) || content.includes(`@${me_acct}@${domain} !`)) {
    const message = content.replace(`@${me_acct}@${domain}`, '').replace(`@${me_acct}`, '').trim();
    if (isCommand(message) && isChatCommand(message)) {
      const replyContent = handleChatCommand(message, acct);
      await postReply(status, replyContent, status.visibility);
    }
    return;
  }
  // 画像URL配列を抽出
  const images = (status.media_attachments || [])
    .filter(att => att.type === 'image' && att.url)
    .map(att => att.url);
  let imageDataUrl: string | undefined = undefined;
  if (images.length > 0) {
    try {
      imageDataUrl = await imageUrlToBase64DataUrl(images[0]);
    } catch (error) {
      console.error('Error converting image to base64:', error);
    }
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
  console.log("conversationContext:", conversationContext);
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
  const userSystemPrompt = getUserSystemPrompt(acct);
  const pastPosts = await fetchMyPastPosts(20);
  const systemPrompt = await readSystemPrompt(userSystemPrompt, pastPosts);
  // imagesをsendMessageに渡す
  const response = await sendMessage(
    systemPrompt,
    conversationId,
    status.account.display_name || status.account.username || status.account.acct,
    isNewConversation ? '' : content,
    historyArg,
    imageDataUrl,
  );
  await postReply(status, response, status.visibility);
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

async function postReply(status: Entity.Status, content: string, visibility: Entity.StatusVisibility = 'unlisted'): Promise<void> {
  // 自分自身へのメンションを削除して無限ループを防ぐ
  let cleanedContent = content.replace(new RegExp(`@${me_acct}@${domain}`, 'g'), me_acct);
  cleanedContent = cleanedContent.replace(new RegExp(`@${me_acct}(?!@)`, 'g'), me_acct);

  const replyContent = cleanedContent.startsWith(`@${status.account.acct}`) ? cleanedContent : `@${status.account.acct} ${cleanedContent}`;
  try {
    const response = await client.postStatus(replyContent, {
      in_reply_to_id: status.id,
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

async function fetchMyPastPosts(limit: number = 20): Promise<string> {
  try {
    const myAccount = await client.verifyAccountCredentials();
    const response = await client.getAccountStatuses(myAccount.data.id, { limit });
    const posts = response.data
      .map(status => stripHtml(status.content))
      .filter(content => content.trim().length > 0)
      .slice(0, limit);
    
    if (posts.length === 0) {
      return '';
    }
    
    return `## 過去の投稿\n\n${posts.map(post => `- ${post}`).join('\n')}`;
  } catch (error) {
    console.error('Error fetching past posts:', error);
    return '';
  }
}

export { connect, disconnect, fetchMyPastPosts };
