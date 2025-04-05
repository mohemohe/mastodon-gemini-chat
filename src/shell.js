#!/usr/bin/env node

const readline = require('readline');
const { sendMessage, clearConversation } = require('./gemini');

// 会話ID (シンプルな実装のため固定値を使用)
const CONVERSATION_ID = 'shell-session';

// インタラクティブなCLIインターフェースを作成
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
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