import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createChatGPT } from '@siwc/local';

const alias = 'mcc-chatgpt-oauth-v1';
const keyContext = Buffer.from('MCC ChatGPT OAuth credential encryption v1');
let cachedKey;

function keystore(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('termux-keystore', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve(Buffer.concat(stdout))
      : reject(new Error(Buffer.concat(stderr).toString().trim() || 'Android Keystore operation failed.')));
    child.stdin.end(input);
  });
}

async function encryptionKey() {
  if (cachedKey) return cachedKey;
  const entries = (await keystore(['list'])).toString('utf8');
  if (!entries.split(/\s+/).includes(alias)) await keystore(['generate', alias, '-a', 'RSA', '-s', '2048']);
  const signature = await keystore(['sign', alias, 'SHA256withRSA'], keyContext);
  if (signature.length < 128) throw new Error('Could not derive the protected MCC credential key from Android Keystore.');
  cachedKey = Buffer.from(hkdfSync('sha256', signature, keyContext, Buffer.from('aes-256-gcm'), 32));
  return cachedKey;
}

const credentialEncryption = {
  id: 'mcc-android-keystore-aes-gcm-v1',
  async isAvailable() {
    try { await keystore(['list']); return true; } catch { return false; }
  },
  async encrypt(plaintext) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await encryptionKey(), iv);
    return Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  },
  async decrypt(ciphertext) {
    const bytes = Buffer.from(ciphertext);
    if (bytes.length < 29) throw new Error('The saved MCC ChatGPT credentials are incomplete.');
    const iv = bytes.subarray(0, 12), tag = bytes.subarray(-16), body = bytes.subarray(12, -16);
    const decipher = createDecipheriv('aes-256-gcm', await encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  },
};

export const chatgpt = createChatGPT({
  appName: 'MCC',
  appId: 'mcc',
  redirectPort: 0,
  callbackReturnUrl: `http://127.0.0.1:${process.env.PORT || 4173}/`,
  storageDir: join(homedir(), '.config', 'mcc', 'chatgpt'),
  credentialEncryption,
  sendHostId: true,
  openBrowser: async value => {
    const url = new URL(value);
    if (url.origin !== 'https://auth.openai.com') throw new Error('Unexpected ChatGPT sign-in destination.');
    await keystore(['list']);
    await new Promise((resolve, reject) => {
      const child = spawn('termux-open-url', [url.href], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('Could not open the ChatGPT sign-in page.')));
    });
  },
});
