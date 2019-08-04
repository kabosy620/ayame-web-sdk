/* @flow */
/* @private */
import { traceLog, getVideoCodecsFromString, removeCodec, browser } from '../utils';

/**
 * オーディオ、ビデオの送受信方向に関するオプションです。
 * - sendrecv
 * - recvonly
 * - sendonly
 * @typedef {string} ConnectionDirection
 */
export type ConnectionDirection = 'sendrecv' | 'recvonly' | 'sendonly';

/*
 * オーディオ接続に関するオプションです。
 * @typedef {Object} ConnectionAudioOption
 */
export type ConnectionAudioOption = {
  direction: ConnectionDirection,
  enabled: boolean
};

/*
 * ビデオ接続のコーデックに関するオプションです。
 * - VP8
 * - VP9
 * - H264
 * @typedef {string} ConnectionDirection
 * @typedef {string} VideoCodecOption
 */
export type VideoCodecOption = 'VP8' | 'VP9' | 'H264';

/*
 * ビデオ接続に関するオプションです。
 * @typedef {Object} ConnectionVideoOption
 */
export type ConnectionVideoOption = {
  codec: ?VideoCodecOption,
  direction: ConnectionDirection,
  enabled: boolean
};

/*
  接続時に指定するオプションです。
 * @typedef {Object} ConnectionOptions
 */
export type ConnectionOptions = {
  audio: ConnectionAudioOption,
  video: ConnectionVideoOption,
  clientId: string,
  iceServers: Array<Object>
};

/*
 * Peer Connection 接続を管理するクラスです。
 */
class Connection {
  debug: boolean;
  roomId: string;
  signalingUrl: string;
  options: ConnectionOptions;
  stream: ?window.MediaStream;
  remoteStreamId: ?string;
  authnMetadata: ?Object;
  _isNegotiating: boolean;
  _isChannelOpen: boolean;
  _ws: ?WebSocket;
  _pc: window.RTCPeerConnection;
  _callbacks: Object;
  _removeCodec: boolean;
  _dataChannels: Array<window.RTCDataChannel>;
  _callbacks: Object;

  /**
   * オブジェクトを生成し、リモートのピアまたはサーバーに接続します。
   * @param {string} signalingUrl シグナリングに利用する URL
   * @param {string} roomId Ayame のルームID
   * @param {ConnectionOptions} options Ayame の接続オプション
   * @param {boolean} [debug=false] デバッグログの出力可否
   * @listens {connect} PeerConnection が接続されると送信されます。
   * @listens {disconnect} PeerConnection が切断されると送信されます。
   * @listens {addstream} リモートのストリームが追加されると送信されます。
   * @listens {removestream} リモートのストリームが削除されると送信されます。
   */
  constructor(signalingUrl: string, roomId: string, options: ConnectionOptions, debug: boolean = false) {
    this.debug = debug;
    this.roomId = roomId;
    this.signalingUrl = signalingUrl;
    this.options = options;
    this._isNegotiating = false;
    this._removeCodec = false;
    this.stream = null;
    this._pc = null;
    this.authnMetadata = null;
    this._dataChannels = [];
    this._callbacks = {
      connect: () => {},
      disconnect: () => {},
      addstream: () => {},
      removestream: () => {},
      data: () => {}
    };
  }
  /*
   * @private
   */
  on(kind: string, callback: Function) {
    if (kind in this._callbacks) {
      this._callbacks[kind] = callback;
    }
  }

  /**
   * PeerConnection  接続を開始します。
   * @param {RTCMediaStream|null} stream ローカルのストリーム
   * @param {Object|null} authnMetadtta 送信するメタデータ
   * @return {Promise<RTCMediaStream|null>} stream ローカルのストリーム
   */
  async connect(stream: ?window.RTCMediaStream, authnMetadata: ?Object = null) {
    if (this._ws || this._pc) {
      this._traceLog('connection already exists');
      throw new Error('Connection Already Exists!');
    }
    this.stream = stream;
    this.authnMetadata = authnMetadata;
    await this._signaling();
    return stream;
  }

  async addDataChannel(channelId: string, options: Object = undefined) {
    return new Promise((resolve, reject) => {
      if (!this._pc) return reject('PeerConnection Does Not Ready');
      let dataChannel = this._findDataChannel(channelId);
      if (dataChannel) {
        return reject('DataChannel Already Exists!');
      }
      dataChannel = this._pc.createDataChannel(channelId, options);
      dataChannel.onclose = async (event: Object) => {
        this._traceLog('datachannel onclosed=>', event);
        this._dataChannels = this._dataChannels.filter(dataChannel => dataChannel.label != channelId);
      };
      dataChannel.onerror = async (event: Object) => {
        this._traceLog('datachannel onerror=>', event);
        this._dataChannels = this._dataChannels.filter(dataChannel => dataChannel.label != channelId);
      };
      dataChannel.onmessage = (event: Object) => {
        this._traceLog('datachannel onmessage=>', event.data);
        event.channelId = channelId;
        this._callbacks.data(event);
      };
      dataChannel.onopen = async (event: Object) => {
        this._traceLog('datachannel onopen=>', event);
        this._dataChannels.push(dataChannel);
      };
      return resolve();
    });
  }

  /*
   * Datachannel でデータを送信します。
   */
  async sendData(params: any, channelId: string = 'dataChannel') {
    return new Promise((resolve, reject) => {
      this._traceLog('datachannel sendData=>', params);
      const dataChannel = this._findDataChannel(channelId);
      if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(params);
        return resolve();
      } else {
        return reject('datachannel is not open');
      }
    });
  }

  /**
   * PeerConnection  接続を切断します。
   * @return {Promise<void>}
   */
  async disconnect() {
    this._dataChannels.forEach(dataChannel => {
      dataChannel.close();
    });
    const closePeerConnection = new Promise((resolve, reject) => {
      if (browser() === 'safari' && this._pc) {
        this._pc.oniceconnectionstatechange = () => {};
        this._pc.close();
        this._pc = null;
        return resolve();
      }
      if (!this._pc) return resolve();
      if (this._pc && this._pc.signalingState == 'closed') {
        return resolve();
      }
      this._pc.oniceconnectionstatechange = () => {};
      const timerId = setInterval(() => {
        if (!this._pc) {
          clearInterval(timerId);
          return reject('PeerConnection Closing Error');
        }
        if (this._pc && this._pc.signalingState == 'closed') {
          clearInterval(timerId);
          return resolve();
        }
      }, 800);
      this._pc.close();
    });
    const closeWebSocketConnection = new Promise((resolve, reject) => {
      if (!this._ws) return resolve();
      if (this._ws && this._ws.readyState === 3) return resolve();
      this._ws.onclose = () => {};
      const timerId = setInterval(() => {
        if (!this._ws) {
          clearInterval(timerId);
          return reject('WebSocket Closing Error');
        }
        if (this._ws.readyState === 3) {
          clearInterval(timerId);
          return resolve();
        }
      }, 800);
      this._ws && this._ws.close();
    });
    if (this.stream) {
      this.stream.getTracks().forEach(t => {
        t.stop();
      });
    }
    this.remoteStreamId = null;
    this.stream = null;
    this.authnMetadata = null;
    this._isNegotiating = false;
    await Promise.all([closeWebSocketConnection, closePeerConnection]);
    this._ws = null;
    this._pc = null;
    this._removeCodec = false;
    this._dataChannels = [];
  }

  async _signaling() {
    return new Promise((resolve, reject) => {
      if (this._ws) {
        return reject('WebSocket Connnection Already Exists!');
      }
      this._ws = new WebSocket(this.signalingUrl);
      this._ws.onclose = () => {
        return reject('WS-CLOSED');
      };
      this._ws.onerror = async () => {
        await this.disconnect();
        return reject('WS-CLOSED');
      };
      this._ws.onopen = () => {
        const registerMessage = {
          type: 'register',
          roomId: this.roomId,
          clientId: this.options.clientId,
          authnMetadata: undefined
        };
        if (this.authnMetadata !== null) {
          registerMessage.authnMetadata = this.authnMetadata;
        }
        this._sendWs(registerMessage);
        if (this._ws) {
          this._ws.onmessage = async (event: MessageEvent) => {
            try {
              if (typeof event.data !== 'string') {
                return;
              }
              const message = JSON.parse(event.data);
              if (message.type === 'ping') {
                this._sendWs({ type: 'pong' });
              } else if (message.type === 'close') {
                this._callbacks.close(event);
              } else if (message.type === 'accept') {
                if (!this._pc) this._pc = this._createPeerConnection();
                await this.addDataChannel('dataChannel');
                await this._sendOffer();
                this._callbacks.connect({ authzMetadata: message.authzMetadata });
                if (this._ws) {
                  this._ws.onclose = async closeEvent => {
                    await this.disconnect();
                    this._callbacks.disconnect({ reason: 'WS-CLOSED', event: closeEvent });
                  };
                }
                return resolve();
              } else if (message.type === 'reject') {
                await this.disconnect();
                this._callbacks.disconnect({ reason: 'REJECTED' });
                return reject('REJECTED');
              } else if (message.type === 'offer') {
                this._setOffer(new window.RTCSessionDescription(message));
              } else if (message.type === 'answer') {
                await this._setAnswer(new window.RTCSessionDescription(message));
              } else if (message.type === 'candidate') {
                if (message.ice) {
                  this._traceLog('Received ICE candidate ...', message.ice);
                  const candidate = new window.RTCIceCandidate(message.ice);
                  this._addIceCandidate(candidate);
                }
              }
            } catch (error) {
              await this.disconnect();
              this._callbacks.disconnect({ reason: 'SIGNALING-ERROR', error: error });
            }
          };
        }
      };
      if (this._ws) {
        this._ws.onclose = async event => {
          await this.disconnect();
          this._callbacks.disconnect(event);
        };
      }
    });
  }

  _createPeerConnection() {
    const pcConfig = {
      iceServers: this.options.iceServers
    };
    const pc = new window.RTCPeerConnection(pcConfig);
    // Add local stream to pc.
    const audioTrack = this.stream && this.stream.getAudioTracks()[0];
    if (audioTrack && this.options.audio.direction !== 'recvonly') {
      pc.addTrack(audioTrack, this.stream);
    } else if (this.options.audio.enabled) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    const videoTrack = this.stream && this.stream.getVideoTracks()[0];
    if (videoTrack && this.options.video.direction !== 'recvonly') {
      const videoSender = pc.addTrack(videoTrack, this.stream);
      const videoTransceiver = this._getTransceiver(pc, videoSender);
      if (this._isVideoCodecSpecified()) {
        if (typeof videoTransceiver.setCodecPreferences !== 'undefined') {
          const videoCapabilities = window.RTCRtpSender.getCapabilities('video');
          const videoCodecs = getVideoCodecsFromString(this.options.video.codec || 'VP9', videoCapabilities.codecs);
          this._traceLog('video codecs=', videoCodecs);
          videoTransceiver.setCodecPreferences(videoCodecs);
        } else {
          this._removeCodec = true;
        }
      }
    } else if (this.options.video.enabled) {
      const videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
      if (this._isVideoCodecSpecified()) {
        if (typeof videoTransceiver.setCodecPreferences !== 'undefined') {
          const videoCapabilities = window.RTCRtpSender.getCapabilities('video');
          const videoCodecs = getVideoCodecsFromString(this.options.video.codec || 'VP9', videoCapabilities.codecs);
          this._traceLog('video codecs=', videoCodecs);
          videoTransceiver.setCodecPreferences(videoCodecs);
        } else {
          this._removeCodec = true;
        }
      }
    }

    let tracks = [];
    pc.ontrack = (event: window.RTCTrackEvent) => {
      this._traceLog('peer.ontrack()', event);
      tracks.push(event.track);
      let mediaStream = new window.MediaStream(tracks);
      this.remoteStreamId = mediaStream.id;
      event.stream = mediaStream;
      this._callbacks.addstream(event);
    };
    pc.onicecandidate = event => {
      this._traceLog('peer.onicecandidate()', event);
      if (event.candidate) {
        this._sendIceCandidate(event.candidate);
      } else {
        this._traceLog('empty ice event', '');
      }
    };
    pc.oniceconnectionstatechange = async () => {
      this._traceLog('ICE connection Status has changed to ', pc.iceConnectionState);
      switch (pc.iceConnectionState) {
        case 'connected':
          this._isNegotiating = false;
          break;
        case 'failed':
          await this.disconnect();
          this._callbacks.disconnect({ reason: 'ICE-CONNECTION-STATE-FAILED' });
          break;
      }
    };
    pc.onsignalingstatechange = _ => {
      this._traceLog('signaling state changes:', pc.signalingState);
    };
    pc.ondatachannel = this._onDataChannel.bind(this);
    return pc;
  }

  _onDataChannel(event: Object) {
    this._traceLog('on data channel', event);
    if (!this._pc) return;
    let dataChannel = event.channel;
    let channelId = event.channel.label;
    if (!event.channel) return;
    if (!channelId || channelId.length < 1) return;
    dataChannel.onopen = async (event: Object) => {
      this._traceLog('datachannel onopen=>', event);
    };
    dataChannel.onclose = async (event: Object) => {
      this._traceLog('datachannel onclosed=>', event);
    };
    dataChannel.onerror = async (event: Object) => {
      this._traceLog('datachannel onerror=>', event);
    };
    dataChannel.onmessage = (event: Object) => {
      this._traceLog('datachannel onmessage=>', event.data);
      event.channelId = channelId;
      this._callbacks.data(event);
    };
    if (!this._findDataChannel(channelId)) {
      this._dataChannels.push(event.channel);
    } else {
      this._dataChannels = this._dataChannels.map(channel => {
        if (channel.label == channelId) {
          return dataChannel;
        } else {
          return channel;
        }
      });
    }
  }

  async _sendOffer() {
    if (!this._pc) {
      return;
    }
    if (browser() === 'safari') {
      if (this.options.video.enabled && this.options.video.direction === 'sendrecv') {
        this._pc.addTransceiver('video', { direction: 'recvonly' });
      }
      if (this.options.audio.enabled && this.options.audio.direction === 'sendrecv') {
        this._pc.addTransceiver('audio', { direction: 'recvonly' });
      }
    }
    let offer = await this._pc.createOffer({
      offerToReceiveAudio: this.options.audio.enabled && this.options.audio.direction !== 'sendonly',
      offerToReceiveVideo: this.options.video.enabled && this.options.video.direction !== 'sendonly'
    });
    if (this._removeCodec && this.options.video.codec) {
      const codecs = ['VP8', 'VP9', 'H264'];
      codecs.forEach(codec => {
        if (this.options.video.codec !== codec) {
          offer.sdp = removeCodec(offer.sdp, codec);
        }
      });
    }
    this._traceLog('create offer sdp, sdp=', offer.sdp);
    await this._pc.setLocalDescription(offer);
    this._sendSdp(this._pc.localDescription);
  }

  _isVideoCodecSpecified() {
    return this.options.video.enabled && this.options.video.codec !== null;
  }

  async _createAnswer() {
    if (!this._pc) {
      return;
    }
    try {
      let answer = await this._pc.createAnswer();
      this._traceLog('create answer sdp, sdp=', answer.sdp);
      await this._pc.setLocalDescription(answer);
      this._sendSdp(this._pc.localDescription);
    } catch (error) {
      await this.disconnect();
      this._callbacks.disconnect({ reason: 'CREATE-ANSWER-ERROR', error: error });
    }
  }

  async _setAnswer(sessionDescription: window.RTCSessionDescription) {
    await this._pc.setRemoteDescription(sessionDescription);
    this._traceLog('set answer sdp=', sessionDescription.sdp);
  }

  async _setOffer(sessionDescription: window.RTCSessionDescription) {
    this._pc = this._createPeerConnection();
    try {
      await this._pc.setRemoteDescription(sessionDescription);
      this._traceLog('set offer sdp=', sessionDescription.sdp);
      await this._createAnswer();
    } catch (error) {
      await this.disconnect();
      this._callbacks.disconnect({ reason: 'SET-OFFER-ERROR', error: error });
    }
  }

  async _addIceCandidate(candidate: window.RTCIceCandidate) {
    try {
      if (this._pc) {
        await this._pc.addIceCandidate(candidate);
      }
    } catch (_error) {
      this._traceLog('invalid ice candidate', candidate);
    }
  }

  _sendIceCandidate(candidate: window.RTCIceCandidate) {
    const message = { type: 'candidate', ice: candidate };
    this._sendWs(message);
  }

  _sendSdp(sessionDescription: Object) {
    this._sendWs(sessionDescription);
  }

  _sendWs(message: Object) {
    if (this._ws) {
      this._ws.send(JSON.stringify(message));
    }
  }

  _traceLog(title: string, message: Object | string) {
    if (!this.debug) return;
    traceLog(title, message);
  }

  _getTransceiver(pc: window.RTCPeerConnection, track: any) {
    let transceiver = null;
    pc.getTransceivers().forEach(t => {
      if (t.sender == track || t.receiver == track) transceiver = t;
    });
    if (!transceiver) {
      throw new Error('invalid transceiver');
    }
    return transceiver;
  }

  _findDataChannel(channelId: string) {
    return this._dataChannels.find(channel => channel.label == channelId);
  }
}

export default Connection;
