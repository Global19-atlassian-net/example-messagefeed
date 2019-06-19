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

const publicKeyLayout = (property: string = 'publicKey'): Object => {
  return BufferLayout.blob(32, property);
};

export async function createUser(
  connection: Connection,
  programId: PublicKey,
  firstMessageAccount: Account,
): Promise<Account> {
  const fee = 100; // TODO: Use the FeeCalculator to determine the current cluster transaction fee
  const payerAccount = await newSystemAccountWithAirdrop(connection, 10 + fee);
  const transaction = new Transaction();

  const userAccount = new Account();
  // Allocate the user account
  transaction.add(
    SystemProgram.createAccount(
      payerAccount.publicKey,
      userAccount.publicKey,
      1,
      1 + 32, // 32 = size of a public key
      programId,
    ),
  );

  // Initialize the user account
  const keys = [
    {pubkey: userAccount.publicKey, isSigner: true},
    {pubkey: firstMessageAccount.publicKey, isSigner: true},
  ];
  transaction.add({
    keys,
    programId,
  });

  await sendAndConfirmTransaction(
    connection,
    transaction,
    payerAccount,
    userAccount,
    firstMessageAccount,
  );

  return userAccount;
}

export async function userLogin(
  connection: Connection,
  programId: PublicKey,
  loginUrl: string,
  credentials: Object,
): Promise<Account> {
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(credentials),
  });
  const json = await response.json();
  return new Account(Uint8Array.from(Buffer.from(json.userAccount, 'hex')));
}

/**
 * Checks if a user has been banned
 */
export async function userBanned(
  connection: Connection,
  user: PublicKey,
): Promise<boolean> {
  const accountInfo = await connection.getAccountInfo(user);

  const userAccountDataLayout = BufferLayout.struct([
    BufferLayout.u8('banned'),
    publicKeyLayout('creator'),
  ]);
  const userAccountData = userAccountDataLayout.decode(accountInfo.data);

  return userAccountData.banned !== 0;
}

/**
 * Read the contents of a message
 */
async function readMessage(
  connection: Connection,
  message: PublicKey,
): Promise<MessageData> {
  const accountInfo = await connection.getAccountInfo(message);

  const messageAccountDataLayout = BufferLayout.struct([
    publicKeyLayout('nextMessage'),
    publicKeyLayout('from'),
    publicKeyLayout('creator'),
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
      if (messages.length === 0) {
        return;
      }
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
  userAccount: Account,
  text: string,
  previousMessage: PublicKey,
  userToBan: PublicKey | null = null,
): Promise<TransactionSignature> {
  const messageData = await readMessage(connection, previousMessage);
  const messageAccount = new Account();
  return postMessageWithProgramId(
    connection,
    messageData.programId,
    userAccount,
    messageAccount,
    text,
    previousMessage,
    userToBan,
  );
}

export async function postMessageWithProgramId(
  connection,
  programId: PublicKey,
  userAccount: Account | null,
  messageAccount: Account,
  text: string,
  previousMessagePublicKey: PublicKey,
  userToBan: PublicKey | null = null,
): Promise<TransactionSignature> {
  const fee = 100; // TODO: Use the FeeCalculator to determine the current cluster transaction fee
  const payerAccount = await newSystemAccountWithAirdrop(connection, 100 + fee);
  const transaction = new Transaction();
  const textBuffer = Buffer.from(text);

  // Allocate the message account
  transaction.add(
    SystemProgram.createAccount(
      payerAccount.publicKey,
      messageAccount.publicKey,
      1,
      32 + 32 + 32 + textBuffer.length, // 32 = size of a public key
      programId,
    ),
  );

  if (userAccount === null) {
    userAccount = new Account();
    // Allocate the user account
    transaction.add(
      SystemProgram.createAccount(
        payerAccount.publicKey,
        userAccount.publicKey,
        1,
        1 + 32, // 32 = size of a public key
        programId,
      ),
    );

    // Initialize the user account
    const keys = [
      {pubkey: userAccount.publicKey, isSigner: true},
      {pubkey: messageAccount.publicKey, isSigner: true},
    ];
    transaction.add({
      keys,
      programId,
    });
  }

  // The second instruction in the transaction posts the message, optionally
  // links it to the previous message and optionally bans another user
  const keys = [
    {pubkey: userAccount.publicKey, isSigner: true},
    {pubkey: messageAccount.publicKey, isSigner: true},
  ];
  if (previousMessagePublicKey) {
    keys.push({pubkey: previousMessagePublicKey, isSigner: false});

    if (userToBan) {
      keys.push({pubkey: userToBan, isSigner: false});
    }
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
    userAccount,
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
          firstMessage: new PublicKey(config.firstMessage),
          loginMethod: config.loginMethod,
          programId: new PublicKey(config.programId),
          url: config.url,
        };
      }
      console.log(`Waiting for message feed program to finish loading...`);
    } catch (err) {
      console.error(`${err}`);
    }
    await sleep(1000);
  }
}
