#!/usr/bin/env node

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { sendMessage, clearConversation } = require('./gemini');

// 会話ID (シンプルな実装のため固定値を使用)
const CONVERSATION_ID = 'shell-session';

// 履歴ファイルのパス
const HISTORY_FILE = path.join(process.cwd(), '.shell_history');

// 履歴ファイルから履歴を読み込む
function loadHistory() {
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

// 履歴をファイルに保存する
function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, history.join('\n') + '\n');
  } catch (error) {
    console.error('履歴ファイルの保存に失敗しました:', error);
  }
}

// インタラクティブなCLIインターフェースを作成
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  history: loadHistory()
});

// 終了時に履歴を保存
rl.on('close', () => {
  saveHistory(rl.history);
});

console.log('Gemini Chat Shell');
console.log('会話を終了するには "exit" または "quit" と入力してください');
console.log('会話履歴をクリアするには "clear" と入力してください');
console.log('-------------------------------------------');

// プロンプト表示関数
function prompt() {
  rl.question('> ', async (input) => {
    // 終了コマンド
    if (['exit', 'quit'].includes(input.toLowerCase())) {
      console.log('さようなら！');
      rl.close();
      process.exit(0);
    }
    
    // クリアコマンド
    if (input.toLowerCase() === 'clear') {
      clearConversation(CONVERSATION_ID);
      console.log('会話履歴をクリアしました');
      prompt();
      return;
    }
    
    try {
      // Gemini APIにメッセージを送信
      const response = await sendMessage(CONVERSATION_ID, input);
      console.log('\n' + response + '\n');
    } catch (error) {
      console.error('エラーが発生しました:', error);
    }
    
    // 次のプロンプトを表示
    prompt();
  });
}

// シェルを開始
prompt(); 