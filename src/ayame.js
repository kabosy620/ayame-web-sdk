/* @flow */
import Connection from './connection';
import type { ConnectionOptions } from './connection';
/* @access private */
import { randomString } from './utils';

export const defaultOptions: ConnectionOptions = {
  audio: { direction: 'sendrecv', enabled: true, codec: null },
  video: { direction: 'sendrecv', enabled: true, codec: null },
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  clientId: randomString(17)
};

/*
 * Ayame Connection を生成します。
 *
 * @param {String} signalingUrl シグナリングに用いる websocket url
 * @param {ConnectionOptions} options 接続時のオプション
 * @param {debug} boolean デバッグログを出力するかどうかのフラグ
 */
export function connection(
  signalingUrl: string,
  roomId: string,
  options: ConnectionOptions = defaultOptions,
  debug: boolean = false
): Connection {
  return new Connection(signalingUrl, roomId, options, debug);
}
export function version(): string {
  return process.version;
}
