/// Application settings
import os from 'os';
import process from 'process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, rmdirSync, readFileSync } from 'fs';
import { v4 as uuidgen } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const cakeyfile = `${__dirname}/../assets/do_not_trust.key.pem`;
export const cacertfile = `${__dirname}/../assets/do_not_trust.crt.pem`;
export const cakey = readFileSync(cakeyfile, 'utf8');
export const cacert = readFileSync(cacertfile, 'utf8');
export const procId = uuidgen();
export const procTime = new Date();
export const procTimeStr = procTime.toISOString().replace(/:/g, "-");

let created = false;
export const tmpdir = () => {
  const dir = `${os.tmpdir()}/harmonicabsorber-${procTimeStr}-${procId}`
  if (!created) {
    created = true;
    mkdirSync(dir, { recursive: true });
    process.on('exit', () => rmdirSync(dir, { recursive: true }));
  }
  return dir;
};

