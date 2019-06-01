/* @flow */
import {
  Account,
  Connection,
  SystemProgram,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as BufferLayout from 'buffer-layout';
import fetch from 'node-fetch';
import type {TransactionSignature} from '@solana/web3.js';

import {publicKeyToName} from './util/publickey-to-name';
import {newSystemAccountWithAirdrop} from './util/new-system-account-with-airdrop';
import {sleep} from './util/sleep';

export type Message = {
  publicKey: PublicKey,
  from: PublicKey,
  name: string,
  text: string,
};

type MessageData = {
  nextMessage: PublicKey,
  from: PublicKey,
  programId: PublicKey,
  text: string,
};

/**
 * Read the contents of a message
 */
async function readMessage(
  connection: Connection,
  message: PublicKey,
): Promise<MessageData> {
  const accountInfo = await connection.getAccountInfo(message);

  const publicKeyLayout = (property: string = 'publicKey'): Object => {
    return BufferLayout.blob(32, property);
  };

  const messageAccountDataLayout = BufferLayout.struct([
    publicKeyLayout('nextMessage'),
    publicKeyLayout('from'),
    BufferLayout.cstr('text'),
  ]);
  const messageAccountData = messageAccountDataLayout.decode(accountInfo.data);
  return {
    nextMessage: new PublicKey(messageAccountData.nextMessage),
    from: new PublicKey(messageAccountData.from),
    programId: accountInfo.owner,
    text: messageAccountData.text,
  };
}

/**
 * Checks a message feed for new messages and loads them into the provided
 * messages array.
 */
export async function refreshMessageFeed(
  connection: Connection,
  messages: Array<Message>,
  onNewMessage: Function | null,
  message: PublicKey | null = null,
): Promise<void> {
  const emptyMessage = new PublicKey(0);
  for (;;) {
    if (message === null) {
      const lastMessage = messages[messages.length - 1].publicKey;
      const lastMessageData = await readMessage(connection, lastMessage);
      message = lastMessageData.nextMessage;
    }

    if (message.equals(emptyMessage)) {
      return;
    }

    console.log(`Loading message ${message}`);
    const messageData = await readMessage(connection, message);
    messages.push({
      publicKey: message,
      from: messageData.from,
      name: publicKeyToName(messageData.from),
      text: messageData.text,
    });
    onNewMessage && onNewMessage();
    message = messageData.nextMessage;
  }
}

/**
 * Posts a new message
 */
export async function postMessage(
  connection: Connection,
  text: string,
  previousMessage: PublicKey,
): Promise<TransactionSignature> {
  const messageData = await readMessage(connection, previousMessage);
  const messageAccount = new Account();
  return postMessageWithProgramId(
    connection,
    messageData.programId,
    messageAccount,
    text,
    previousMessage,
  );
}

export async function postMessageWithProgramId(
  connection,
  programId: PublicKey,
  messageAccount: Account,
  text: string,
  previousMessagePublicKey: PublicKey | null,
): Promise<TransactionSignature> {
  const fee = 10; // TODO: Use the FeeCalculator to determine the current cluster transaction fee
  const payerAccount = await newSystemAccountWithAirdrop(connection, 1 + fee);
  const transaction = new Transaction();
  const textBuffer = Buffer.from(text);

  // The first instruction of the transaction allocates an account for the
  // message
  transaction.add(
    SystemProgram.createAccount(
      payerAccount.publicKey,
      messageAccount.publicKey,
      1,
      32 + 32 + textBuffer.length, // 32 = size of a public key
      programId,
    ),
  );

  // The second instruction in the transaction posts the message and optionally
  // links it to the previous message
  const keys = [
    {pubkey: payerAccount.publicKey, isSigner: true},
    {pubkey: messageAccount.publicKey, isSigner: true},
  ];
  if (previousMessagePublicKey) {
    keys.push({pubkey: previousMessagePublicKey, isSigner: false});
  }
  transaction.add({
    keys,
    programId,
    data: textBuffer,
  });
  return sendAndConfirmTransaction(
    connection,
    transaction,
    payerAccount,
    messageAccount,
  );
}

export async function getFirstMessage(configUrl: string): Promise<Object> {
  for (;;) {
    try {
      const response = await fetch(configUrl);
      const config = await response.json();

      if (!config.loading) {
        return {
          url: config.url,
          firstMessage: new PublicKey(config.firstMessage),
          programId: config.programId,
        };
      }
      console.log(`Waiting for message feed program to finish loading...`);
    } catch (err) {
      console.error(`${err}`);
    }
    await sleep(1000);
  }
}
