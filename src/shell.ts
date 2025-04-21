#!/usr/bin/env node

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { sendMessage, clearConversation } from './gemini';
import { setUserSystemPrompt, getUserSystemPrompt, isCommand, isChatCommand, handleChatCommand, readSystemPrompt, conversationContexts } from './chat';

const CONVERSATION_ID = 'shell-session';
const HISTORY_FILE = path.join(process.cwd(), 'data', '.shell_history');

function loadHistory(): string[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const history = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      return history;
    }
  } catch (error) {
    console.error('履歴ファイルの読み込みに失敗しました:', error);
  }
  return [];
}

function saveHistory(history: string[]): void {
  try {
    fs.writeFileSync(HISTORY_FILE, `${history.join('\n')}\n`);
  } catch (error) {
    console.error('履歴ファイルの保存に失敗しました:', error);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// 履歴の管理
const history: string[] = loadHistory();
let historyIndex = history.length;

rl.on('line', (input: string) => {
  if (input.trim() !== '') {
    history.push(input);
    historyIndex = history.length;
  }
});

rl.on('close', () => {
  saveHistory(history);
});

console.log('Gemini Chat Shell');
console.log('会話を終了するには "exit" または "quit" と入力してください');
console.log('会話履歴をクリアするには "clear" と入力してください');
console.log('-------------------------------------------');

function prompt(): void {
  rl.question('> ', async (input: string) => {
    if (isCommand(input)) {
      // !chat systemprompt [value] コマンド判定
      if (isChatCommand(input)) {
        console.log(handleChatCommand(input, CONVERSATION_ID));
      } // !chat 以外のコマンドは無視
      prompt();
      return;
    }
    try {
      let ctx = conversationContexts.get(CONVERSATION_ID);
      if (!ctx) {
        conversationContexts.set(CONVERSATION_ID, {
          id: CONVERSATION_ID,
          timestamp: Date.now(),
          rootStatusId: '',
          history: []
        });
        ctx = {
          id: CONVERSATION_ID,
          timestamp: Date.now(),
          rootStatusId: '',
          history: []
        };
      }
      
      const systemPrompt = readSystemPrompt(getUserSystemPrompt('shell') || '');
      const response = await sendMessage(systemPrompt, ctx.timestamp.toString(), 'user', input);
      console.log(`\n${response}\n`);
    } catch (error) {
      console.error('エラーが発生しました:', error);
    }
    prompt();
  });
}

prompt(); 
