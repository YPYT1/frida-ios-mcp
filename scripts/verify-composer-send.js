/**
 * End-to-end: open chat, list real message text, send via composer, re-read exact text.
 */
import {
  imSendText,
  imListMessages,
  imConversationIdForPeer,
  imOpenChatByPeerUid,
} from '../agent/tiktok_im.js';
import ObjC from 'frida-objc-bridge';

function safeStr(v) {
  try {
    return v == null ? '' : String(v);
  } catch (_e) {
    return '';
  }
}

rpc.exports = {
  run(options) {
    const opts = options || {};
    const peerUid = String(opts.peerUid || '7631865245183525889');
    const text = String(opts.text || ('mcp composer ' + Date.now()));
    const dryOnly = opts.dryOnly === true;

    for (let i = 0; i < 40; i++) {
      try {
        const u = ObjC.classes.AWEUserService.sharedService().currentLoginUser();
        if (u && safeStr(u.userID())) break;
      } catch (_e) {}
      Thread.sleep(0.3);
    }

    const built = imConversationIdForPeer(peerUid);
    const open = imOpenChatByPeerUid({ peerUid, nickname: 'wyatthsiun' });
    Thread.sleep(3.5);

    const before = imListMessages({
      conversationId: built.ok ? built.conversationId : '',
      limit: 10,
    });

    const dry = imSendText({
      peerUid,
      conversationId: built.ok ? built.conversationId : '',
      text,
      dryRun: true,
    });

    if (dryOnly) {
      return { peerUid, built, open, before, dry, sentText: text, dryOnly: true };
    }

    const send = imSendText({
      peerUid,
      conversationId: built.ok ? built.conversationId : '',
      text,
      dryRun: false,
      transport: 'network',
      confirmTimeoutMs: 20000,
    });

    Thread.sleep(2.0);
    const after = imListMessages({
      conversationId: built.ok ? built.conversationId : '',
      limit: 12,
    });

    const live = [];
    try {
      const msgs = ObjC.chooseSync(ObjC.classes.AWEIMTextMessage) || [];
      for (let i = 0; i < Math.min(msgs.length, 40); i++) {
        const m = msgs[i];
        let t = '';
        let cid = '';
        try { t = safeStr(m.text()); } catch (_e) {}
        try { cid = safeStr(m.conversationID()); } catch (_e) {}
        if (t === text || (cid && built.ok && cid === built.conversationId && t)) {
          live.push({
            text: t.slice(0, 160),
            conversationID: cid,
            serverMessageID: safeStr(m.serverMessageID ? m.serverMessageID() : ''),
            messageID: safeStr(m.messageID ? m.messageID() : ''),
          });
        }
      }
    } catch (e) {
      live.push({ err: String(e) });
    }

    const exactMatch =
      !!(send && send.ok && send.verifiedText === text) ||
      live.some((x) => x.text === text) ||
      ((after.messages || []).some((m) => m.content === text));

    return {
      peerUid,
      built,
      open,
      before,
      dry,
      send,
      after,
      sentText: text,
      liveExact: live.filter((x) => x.text === text).slice(0, 5),
      exactMatch,
    };
  },
};

send({ type: 'ready' });

