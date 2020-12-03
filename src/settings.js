/// Application settings

import { mkdirSync, rmdirSync } from 'fs';

export const cakey = `../${__dirname}/assets/do_not_trust.key.pem`;
export const cacert = `../${__dirname}/assets/do_not_trust.crt.pem`;
export const procId = uuidgen();
export const procTime = new Date();
export const procTimeStr = procTime.toISOString().replace(/:/g, "-")
export const tmpdir = () => {
  const dir = `${os.tmpdir()}/harmonicabsorber-${procTimeStr}-${procId}`
  mkdirSync(dir, { recursive: true });
  process.on('exit', () => rmdirSync(tmpdir, { recursive: true }));
  return dir;
};

