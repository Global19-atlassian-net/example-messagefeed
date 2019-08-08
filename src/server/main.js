import express from 'express';
import cors from 'cors';
import path from 'path';

import {url, walletUrl} from '../../urls';
import {newSystemAccountWithAirdrop} from '../util/new-system-account-with-airdrop';
import {createUser, postMessageWithProgramId} from '../message-feed';
import {MessageFeedController} from './message-feed';
import {Connection} from '@solana/web3.js';

const port = process.env.PORT || 8081;

const messageFeedController = new MessageFeedController();
const loginMethod = process.env.LOGIN_METHOD || 'local';
switch (loginMethod) {
  case 'local':
  case 'google':
    break;
  default:
    throw new Error(`Unknown LOGIN_METHOD: ${loginMethod}`);
}
console.log(`Login method: ${loginMethod}`);

const app = express();
app.use(cors());
app.use(express.json()); // for parsing application/json
app.get('/config.json', async (req, res) => {
  const meta = await messageFeedController.checkMessageFeed();
  const response = {
    loading: !meta,
    firstMessage: meta ? meta.firstMessage.publicKey.toString() : null,
    programId: meta ? meta.programId.toString() : null,
    loginMethod,
    url,
    walletUrl,
  };

  res.send(JSON.stringify(response)).end();
});

const users = {};
app.post('/login', async (req, res) => {
  const meta = await messageFeedController.checkMessageFeed();
  if (!meta) {
    res.status(500).send('Loading');
    return;
  }

  const credentials = req.body;
  console.log('login credentials:', credentials);
  let id;
  switch (loginMethod) {
    case 'google':
      throw new Error(
        `TODO unimplemented login method: ${this.state.loginMethod}`,
      );
    case 'local': {
      id = credentials.id;
      break;
    }
    default:
      throw new Error(`Unsupported login method: ${this.state.loginMethod}`);
  }

  if (id in users) {
    console.log(`Account already exists for user ${id}`);
  } else {
    console.log(`Creating new account for user ${id}`);
    const connection = new Connection(url);
    const fee = 100; // TODO: Use the FeeCalculator to determine the current cluster transaction fee
    const payerAccount = await newSystemAccountWithAirdrop(
      connection,
      1000 + fee,
    );
    const userAccount = await createUser(
      connection,
      meta.programId,
      payerAccount,
      meta.firstMessage,
    );

    if (id in users) {
      res.status(500).send('Duplicate account');
      return;
    }
    users[id] = userAccount.secretKey;
  }
  res
    .send(JSON.stringify({userAccount: Buffer.from(users[id]).toString('hex')}))
    .end();
});

app.use(express.static(path.join(__dirname, '../dist')));
app.listen(port);
console.log('Cluster RPC URL:', url);
console.log('Listening on port', port);

// Load the program immediately so the first client doesn't need to wait as long
messageFeedController.checkMessageFeed().catch(err => console.log(err));
