#!/usr/bin/env node

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { sendMessage, clearConversation } from './gemini';

const CONVERSATION_ID = 'shell-session';
const HISTORY_FILE = path.join(process.cwd(), '.shell_history');

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
    if (["exit", "quit"].includes(input.toLowerCase())) {
      console.log('さようなら！');
      rl.close();
      process.exit(0);
    }
    if (input.toLowerCase() === 'clear') {
      await clearConversation(CONVERSATION_ID);
      console.log('会話履歴をクリアしました');
      prompt();
      return;
    }
    try {
      const response = await sendMessage(CONVERSATION_ID, 'user', input);
      console.log(`\n${response}\n`);
    } catch (error) {
      console.error('エラーが発生しました:', error);
    }
    prompt();
  });
}

prompt(); 