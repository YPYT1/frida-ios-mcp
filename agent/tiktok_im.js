/**
 * TikTok IM helpers (in-process SDK).
 * send_text defaults to dryRun=true — never send unless dryRun:false.
 */
import ObjC from 'frida-objc-bridge';

function safeStr(v) {
  try {
    if (v == null) return '';
    return String(v);
  } catch (_e) {
    return '';
  }
}

function classExists(name) {
  return !!ObjC.classes[name];
}

function tryCall(obj, sel, args) {
  try {
    if (!obj || !obj.handle || obj.handle.isNull()) return null;
    if (!obj.respondsToSelector_(ObjC.selector(sel))) return null;
    return obj[sel].apply(obj, args || []);
  } catch (_e) {
    return null;
  }
}

function tryClassCall(Cls, sel, args) {
  try {
    if (!Cls) return null;
    if (!Cls.respondsToSelector_(ObjC.selector(sel))) return null;
    return Cls[sel].apply(Cls, args || []);
  } catch (_e) {
    return null;
  }
}

export function imStatus() {
  const Sender = ObjC.classes.AWEIMSendMessageController;
  const TextMsg = ObjC.classes.AWEIMTextMessage;
  const Conv = ObjC.classes.TIMOConversation;
  let sharedOk = false;
  let senderClass = null;
  try {
    if (Sender) {
      const s = Sender.sharedInstance();
      sharedOk = !!(s && !s.handle.isNull());
      senderClass = s ? s.$className : null;
    }
  } catch (_e) { /* */ }
  return {
    ok: true,
    hasSendController: !!Sender,
    hasTextMessage: !!TextMsg,
    hasTIMOConversation: !!Conv,
    sharedOk,
    senderClass,
    dryRunDefault: true,
  };
}

function getUserService() {
  const S = ObjC.classes.AWEUserService || ObjC.classes.TTKUserService;
  if (!S) return null;
  return (
    tryClassCall(S, 'sharedService', []) ||
    tryClassCall(S, 'sharedInstance', [])
  );
}

function getCurrentUserModel() {
  const candidates = [
    () => {
      const inst = getUserService();
      if (!inst) return null;
      return tryCall(inst, 'currentLoginUser', []) || tryCall(inst, 'currentUser', []);
    },
    () => {
      const S = ObjC.classes.AWEUserModel;
      if (!S) return null;
      return tryClassCall(S, 'currentUser', []) || tryClassCall(S, 'currentLoginUser', []);
    },
  ];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const u = candidates[i]();
      if (u && u.handle && !u.handle.isNull()) return u;
    } catch (_e) { /* */ }
  }
  return null;
}

export function userPhoneBindStatus() {
  const svc = getUserService();
  const user = getCurrentUserModel();
  const out = {
    ok: false,
    serviceClass: svc ? svc.$className : null,
    isLogin: null,
    canShowThirdPartyPhoneBindingPopup: null,
    is3pBindPopupRequestShow: null,
    className: null,
    havePhoneNumber: null,
    isPhoneBinded: null,
    bindPhone: null,
    phoneNumber: null,
    hint:
      'Compare with net_dump({ query: "phone|bind|mobile|passport|verify", redact:false, dedupe:false }) after Add Phone popup',
  };
  if (svc) {
    try {
      if (svc.respondsToSelector_(ObjC.selector('isLogin'))) out.isLogin = !!svc.isLogin();
    } catch (_e) { /* */ }
    try {
      if (svc.respondsToSelector_(ObjC.selector('canShowThirdPartyPhoneBindingPopup'))) {
        out.canShowThirdPartyPhoneBindingPopup = !!svc.canShowThirdPartyPhoneBindingPopup();
      }
    } catch (_e) { /* */ }
    try {
      if (svc.respondsToSelector_(ObjC.selector('is3pBindPopupRequestShow'))) {
        out.is3pBindPopupRequestShow = !!svc.is3pBindPopupRequestShow();
      }
    } catch (_e) { /* */ }
  }
  if (!user) {
    out.error = 'current user model not found';
    return out;
  }
  out.ok = true;
  out.className = user.$className;
  try {
    if (user.respondsToSelector_(ObjC.selector('havePhoneNumber'))) {
      out.havePhoneNumber = !!user.havePhoneNumber();
    }
  } catch (_e) { /* */ }
  try {
    if (user.respondsToSelector_(ObjC.selector('isPhoneBinded'))) {
      out.isPhoneBinded = !!user.isPhoneBinded();
    }
  } catch (_e) { /* */ }
  try {
    if (user.respondsToSelector_(ObjC.selector('bindPhone'))) {
      out.bindPhone = safeStr(user.bindPhone());
    }
  } catch (_e) { /* */ }
  try {
    if (user.respondsToSelector_(ObjC.selector('phoneNumber'))) {
      out.phoneNumber = safeStr(user.phoneNumber());
    }
  } catch (_e) { /* */ }
  return out;
}

function getIMSDKInstance() {
  const paths = [
    () => {
      const Sender = ObjC.classes.AWEIMSendMessageController;
      if (!Sender) return null;
      const s = Sender.sharedInstance();
      const prop = tryCall(s, 'sender', []);
      if (prop && prop.handle && !prop.handle.isNull()) {
        return (
          tryCall(prop, 'sdkInstance', []) ||
          tryCall(prop, 'imSDK', []) ||
          tryCall(prop, 'timoSDK', []) ||
          tryCall(prop, 'instance', []) ||
          prop
        );
      }
      return (
        tryCall(s, 'sdkInstance', []) ||
        tryCall(s, 'imSDKInstance', []) ||
        tryCall(s, 'timoInstance', [])
      );
    },
    () => {
      const Mod = ObjC.classes.AWEIMModuleService;
      if (!Mod) return null;
      const smc =
        tryClassCall(Mod, 'sendMessageController', []) ||
        tryCall(tryClassCall(Mod, 'sharedInstance', []), 'sendMessageController', []);
      if (smc) {
        const prop = tryCall(smc, 'sender', []);
        if (prop && prop.handle && !prop.handle.isNull()) {
          return (
            tryCall(prop, 'sdkInstance', []) ||
            tryCall(prop, 'imSDK', []) ||
            prop
          );
        }
      }
      return null;
    },
    () => {
      const S = ObjC.classes.TIMOClient || ObjC.classes.TIMOSDK;
      if (!S) return null;
      return tryClassCall(S, 'sharedInstance', []);
    },
  ];
  for (let i = 0; i < paths.length; i++) {
    try {
      const x = paths[i]();
      if (x && x.handle && !x.handle.isNull()) return x;
    } catch (_e) { /* */ }
  }
  return null;
}

/** AWEIMModuleService: prefer live instance for - methods; class for + methods. */
function getIMModuleService() {
  const Mod = ObjC.classes.AWEIMModuleService;
  if (!Mod) return null;
  let target = tryClassCall(Mod, 'sharedInstance', []);
  if (target && target.handle && !target.handle.isNull()) return target;
  try {
    const found = ObjC.chooseSync(Mod);
    if (found && found.length) return found[0];
  } catch (_e) { /* */ }
  return null;
}

/**
 * getConversation* are CLASS methods (+) on this build.
 * Frida: call as Mod.getConversationWithPeerUid_completion_(...) on the class object.
 * Fallback: ObjC.chooseSync(TIMOConversation) matching peer/conversation id.
 */
function conversationFromPeerUid(peerUid, timeoutMs) {
  const Mod = ObjC.classes.AWEIMModuleService;
  if (!Mod) return { ok: false, error: 'AWEIMModuleService missing' };
  let done = false;
  let conv = null;
  let err = null;
  const block = new ObjC.Block({
    retType: 'void',
    argTypes: ['object', 'object'],
    implementation(c, e) {
      try {
        if (e && !e.isNull()) err = safeStr(new ObjC.Object(e).localizedDescription());
        if (c && !c.isNull()) conv = new ObjC.Object(c);
      } catch (ex) {
        err = String(ex);
      }
      done = true;
    },
  });

  let invoked = false;
  try {
    ObjC.schedule(ObjC.mainQueue, () => {
      try {
        if (typeof Mod.getConversationWithPeerUid_completion_ === 'function') {
          Mod.getConversationWithPeerUid_completion_(String(peerUid), block);
          invoked = true;
        } else if (Mod['+ getConversationWithPeerUid:completion:']) {
          Mod['+ getConversationWithPeerUid:completion:'].call(Mod, String(peerUid), block);
          invoked = true;
        } else {
          err = 'getConversationWithPeerUid:completion: not callable on class';
          done = true;
        }
      } catch (e) {
        err = String(e);
        done = true;
      }
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  const start = Date.now();
  const limit = Math.max(500, Math.min(15000, timeoutMs || 8000));
  while (!done && Date.now() - start < limit) {
    Thread.sleep(0.05);
  }
  if (conv && conv.handle && !conv.handle.isNull()) {
    return { ok: true, conversation: conv, source: 'peerUid', invoked };
  }

  // Fallback: live TIMO objects whose identifier contains peerUid
  const viaChoose = conversationFromChoose(null, peerUid);
  if (viaChoose.ok) return viaChoose;

  if (!done && invoked) {
    return { ok: false, error: 'getConversationWithPeerUid timeout', invoked };
  }
  return { ok: false, error: err || 'conversation null from peerUid', invoked };
}

function conversationFromModule(conversationId, timeoutMs) {
  const Mod = ObjC.classes.AWEIMModuleService;
  if (!Mod) return { ok: false, error: 'AWEIMModuleService missing' };
  let done = false;
  let conv = null;
  let err = null;
  const block = new ObjC.Block({
    retType: 'void',
    argTypes: ['object', 'object'],
    implementation(c, e) {
      try {
        if (e && !e.isNull()) err = safeStr(new ObjC.Object(e).localizedDescription());
        if (c && !c.isNull()) conv = new ObjC.Object(c);
      } catch (ex) {
        err = String(ex);
      }
      done = true;
    },
  });

  let invoked = false;
  try {
    ObjC.schedule(ObjC.mainQueue, () => {
      try {
        if (typeof Mod.getConversationWithConID_completion_ === 'function') {
          Mod.getConversationWithConID_completion_(String(conversationId), block);
          invoked = true;
        } else if (Mod['+ getConversationWithConID:completion:']) {
          Mod['+ getConversationWithConID:completion:'].call(Mod, String(conversationId), block);
          invoked = true;
        } else {
          err = 'getConversationWithConID:completion: not callable on class';
          done = true;
        }
      } catch (e) {
        err = String(e);
        done = true;
      }
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  const start = Date.now();
  const limit = Math.max(500, Math.min(15000, timeoutMs || 8000));
  while (!done && Date.now() - start < limit) {
    Thread.sleep(0.05);
  }
  if (conv && conv.handle && !conv.handle.isNull()) {
    return { ok: true, conversation: conv, source: 'module', invoked };
  }

  const viaChoose = conversationFromChoose(conversationId, null);
  if (viaChoose.ok) return viaChoose;

  if (!done && invoked) {
    return { ok: false, error: 'getConversationWithConID timeout', invoked };
  }
  return { ok: false, error: err || 'conversation null from module', invoked };
}

/** Match live TIMOConversation by conversationId and/or peerUid substring. */
function conversationFromChoose(conversationId, peerUid) {
  const Conv = ObjC.classes.TIMOConversation;
  if (!Conv) return { ok: false, error: 'TIMOConversation missing' };
  let found = [];
  try {
    found = ObjC.chooseSync(Conv) || [];
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const wantCid = conversationId ? String(conversationId) : '';
  const wantPeer = peerUid ? String(peerUid) : '';
  let best = null;
  let bestId = '';
  for (let i = 0; i < found.length; i++) {
    const c = found[i];
    let id = '';
    try {
      id = safeStr(c.identifier ? c.identifier() : '');
    } catch (_e) {}
    if (!id) continue;
    if (wantCid && id === wantCid) {
      return { ok: true, conversation: c, source: 'chooseExact', identifier: id };
    }
    if (wantPeer && id.indexOf(wantPeer) >= 0) {
      best = c;
      bestId = id;
    }
  }
  if (best) {
    return { ok: true, conversation: best, source: 'choosePeer', identifier: bestId };
  }
  return { ok: false, error: 'no matching TIMOConversation in chooseSync', n: found.length };
}

function conversationFromId(conversationId, peerUid) {
  const errors = [];
  if (peerUid) {
    const viaPeer = conversationFromPeerUid(String(peerUid), 8000);
    if (viaPeer && viaPeer.ok) return viaPeer;
    if (viaPeer && viaPeer.error) errors.push('peer:' + viaPeer.error);
  }

  if (conversationId) {
    const viaMod = conversationFromModule(conversationId, 8000);
    if (viaMod && viaMod.ok) return viaMod;
    if (viaMod && viaMod.error) errors.push('module:' + viaMod.error);
  }

  const Conv = ObjC.classes.TIMOConversation;
  if (!Conv) {
    return {
      ok: false,
      error: errors.join('; ') || 'TIMOConversation missing',
      hint: 'Pass peerUid; open_chat once may warm IM SDK',
    };
  }
  const sdk = getIMSDKInstance();
  if (sdk && sdk.$className && /Sender/i.test(sdk.$className)) {
    return {
      ok: false,
      error: errors.join('; ') || 'TIMO conversation resolve failed (no valid SDK)',
      hint: 'Use peerUid + open_chat first, then retry send_text',
    };
  }
  if (!sdk) {
    return {
      ok: false,
      error: errors.join('; ') || 'IM SDK instance not found',
      hint: 'open_chat then retry, or provide conversationId from inbox',
    };
  }
  try {
    if (
      Conv.respondsToSelector_(
        ObjC.selector('instanceWithSDKInstance:conversationIdentifier:'),
      )
    ) {
      const c = Conv.instanceWithSDKInstance_conversationIdentifier_(sdk, conversationId);
      if (c && !c.handle.isNull()) return { ok: true, conversation: c, sdk, source: 'timo' };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  return {
    ok: false,
    error: errors.join('; ') || 'instanceWithSDKInstance:conversationIdentifier: failed',
  };
}

function buildTextMessage(text) {
  const TextMsg = ObjC.classes.AWEIMTextMessage;
  if (!TextMsg) return { ok: false, error: 'AWEIMTextMessage missing' };
  const body = String(text || '');
  try {
    // Real inbox texts look like: messageType=7, fullContentDict={ aweType:0, text:"..." }
    // Missing aweType → peer shows "unsupported / update app" placeholder.
    const dict = ObjC.classes.NSMutableDictionary.alloc().init();
    dict.setObject_forKey_(ObjC.classes.NSString.stringWithString_(body), 'text');
    dict.setObject_forKey_(ObjC.classes.NSNumber.numberWithLongLong_(0), 'aweType');

    let msg = null;
    if (TextMsg.instancesRespondToSelector_(ObjC.selector('initWithContentDict:'))) {
      msg = TextMsg.alloc().initWithContentDict_(dict);
    }
    if ((!msg || msg.handle.isNull()) && ObjC.classes.AWEIMTextMessageContent) {
      const Content = ObjC.classes.AWEIMTextMessageContent;
      let content = null;
      if (Content.instancesRespondToSelector_(ObjC.selector('initWithText:'))) {
        content = Content.alloc().initWithText_(body);
      }
      if (content && !content.handle.isNull()) {
        try {
          if (content.respondsToSelector_(ObjC.selector('setAweType:'))) {
            content.setAweType_(0);
          }
        } catch (_e) { /* */ }
        msg = TextMsg.alloc().init();
        if (msg.respondsToSelector_(ObjC.selector('setContent:'))) {
          msg.setContent_(content);
        }
        // init-only path often leaves messageType=0 (unsupported). Force type 7 like real texts.
        try {
          if (msg.respondsToSelector_(ObjC.selector('setMessageType:'))) {
            msg.setMessageType_(7);
          }
        } catch (_e) { /* */ }
      }
    }

    if (!msg || msg.handle.isNull()) {
      return { ok: false, error: 'could not construct AWEIMTextMessage' };
    }

    try {
      if (msg.respondsToSelector_(ObjC.selector('setMessageType:'))) {
        const mt = msg.respondsToSelector_(ObjC.selector('messageType'))
          ? Number(msg.messageType())
          : -1;
        if (mt !== 7) msg.setMessageType_(7);
      }
    } catch (_e) { /* */ }

    try {
      if (msg.respondsToSelector_(ObjC.selector('calculateAttributedContent'))) {
        msg.calculateAttributedContent();
      }
    } catch (_e) { /* */ }

    let check = '';
    let aweType = null;
    let messageType = null;
    try {
      check = safeStr(msg.text ? msg.text() : '');
    } catch (_e) {}
    try {
      messageType = msg.messageType ? Number(msg.messageType()) : null;
    } catch (_e) {}
    try {
      const fc = msg.fullContentDict ? msg.fullContentDict() : null;
      if (fc && fc.objectForKey_) {
        const at = fc.objectForKey_('aweType');
        if (at) aweType = Number(at);
      }
    } catch (_e) {}

    return {
      ok: true,
      message: msg,
      via: 'initWithContentDict:{text,aweType:0}',
      textCheck: check.slice(0, 80),
      messageType,
      aweType,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Build through TikTok's own text-send factory.  AWEIMTextMessage is only a
 * presentation model on this build: passing one directly to the controller
 * can create a TIMO message with an empty protocol body.  The native factory
 * returns the send model that TikTok's compose box uses instead.
 */
function buildNativeTextSendModel(text) {
  const body = String(text || '');
  const Mod = ObjC.classes.AWEIMModuleService;
  if (!Mod) return { ok: false, error: 'AWEIMModuleService missing' };
  try {
    const Factory = tryClassCall(Mod, 'sendModelFactory', []);
    if (!Factory || !Factory.handle || Factory.handle.isNull()) {
      return { ok: false, error: 'TikTok sendModelFactory unavailable' };
    }
    if (!Factory.respondsToSelector_(ObjC.selector('generateTextSendModelWithText:'))) {
      return { ok: false, error: 'TikTok native text send-model factory unavailable' };
    }
    const model = Factory.generateTextSendModelWithText_(body);
    if (!model || !model.handle || model.handle.isNull()) {
      return { ok: false, error: 'TikTok native text factory returned null' };
    }
    const messageType = Number(tryCall(model, 'messageType', []));
    const contentDict = tryCall(model, 'getContentDict', []);
    const nativeText = safeStr(tryCall(contentDict, 'objectForKey:', ['text']));
    const aweType = Number(tryCall(contentDict, 'objectForKey:', ['aweType']));
    if (messageType !== 7 || nativeText !== body || aweType !== 0) {
      return {
        ok: false,
        error: 'TikTok native text send model failed validation',
        messageType,
        textCheck: nativeText,
        aweType,
      };
    }
    return {
      ok: true,
      model,
      via: 'AWEIMShareMessageCreater.generateTextSendModelWithText:',
      textCheck: nativeText,
      messageType,
      aweType,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * The private AWEIMSendMessageController dispatcher hangs on this TikTok build.
 * Sending must go through the real chat composer UI so TikTok itself builds and
 * serializes the TIMO protocol body.
 */
function walkViews(root, visit, depth, maxDepth, maxNodes, state) {
  if (!root || !root.handle || root.handle.isNull()) return;
  if (depth > maxDepth || state.count >= maxNodes) return;
  state.count += 1;
  try {
    visit(root, depth);
  } catch (_e) { /* */ }
  try {
    const subs = root.subviews();
    if (!subs || !subs.handle || subs.handle.isNull()) return;
    const n = Math.min(Number(subs.count()), 80);
    for (let i = 0; i < n; i++) {
      walkViews(subs.objectAtIndex_(i), visit, depth + 1, maxDepth, maxNodes, state);
      if (state.count >= maxNodes) return;
    }
  } catch (_e) { /* */ }
}

function eachVisibleWindow(visit) {
  try {
    const app = ObjC.classes.UIApplication.sharedApplication();
    const windows = app.windows();
    const n = Math.min(Number(windows.count()), 12);
    for (let i = 0; i < n; i++) visit(windows.objectAtIndex_(i));
  } catch (_e) { /* */ }
}

function findChatComposerControls() {
  const out = { textView: null, sendButton: null, stage: null, source: null };

  // Fast path: choose known Swift chat-input classes directly.
  try {
    const stages = ObjC.chooseSync(ObjC.classes['TikTokIMImplSwift.ChatInputStageView']) || [];
    if (stages.length) out.stage = stages[0];
  } catch (_e) { /* */ }
  try {
    const candidates = [];
    const loaded = ObjC.enumerateLoadedClassesSync() || {};
    const modules = Object.keys(loaded);
    for (let mi = 0; mi < modules.length; mi++) {
      const names = loaded[modules[mi]] || [];
      for (let ni = 0; ni < names.length; ni++) {
        const name = names[ni];
        if (/ChatInputTextView|ChatInputGradientButton|ChatInputStageView/i.test(name)) {
          candidates.push(name);
        }
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      const clsName = candidates[i];
      const Cls = ObjC.classes[clsName];
      if (!Cls) continue;
      let objs = [];
      try {
        objs = ObjC.chooseSync(Cls) || [];
      } catch (_e) {
        continue;
      }
      for (let j = 0; j < objs.length; j++) {
        const view = objs[j];
        const cls = String(view.$className || clsName);
        if (!out.stage && /ChatInputStageView/i.test(cls)) {
          out.stage = view;
          out.source = out.source || 'chooseStage';
        }
        if (!out.textView && /ChatInputTextView/i.test(cls)) {
          out.textView = view;
          out.source = out.source || 'chooseTextView';
        }
        if (!out.sendButton && /ChatInputGradientButton/i.test(cls)) {
          let label = '';
          try {
            label = safeStr(view.accessibilityLabel());
          } catch (_e) { /* */ }
          if (!label || /傳送|发送|Send/i.test(label)) {
            out.sendButton = view;
            out.source = out.source || 'chooseSend';
          }
        }
      }
    }
  } catch (_e) { /* */ }

  eachVisibleWindow((win) => {
    walkViews(
      win,
      (view) => {
        let cls = '';
        try {
          cls = String(view.$className || '');
        } catch (_e) {
          return;
        }
        if (!out.stage && /ChatInputStageView/i.test(cls)) out.stage = view;
        if (!out.textView && (/ChatInputTextView/i.test(cls) || cls === 'UITextView' || /UITextView/i.test(cls))) {
          let a11y = '';
          try {
            a11y = safeStr(view.accessibilityLabel());
          } catch (_e) { /* */ }
          // Prefer the chat placeholder "訊息..." / "消息..." / "Message..."
          const looksComposer =
            /ChatInputTextView/i.test(cls) ||
            /訊息|消息|Message|訊息\.\.\.|消息\.\.\./i.test(a11y);
          if (looksComposer || /ChatInput/i.test(cls)) {
            try {
              if (view.respondsToSelector_(ObjC.selector('setText:'))) {
                out.textView = view;
                out.source = out.source || 'walkTextView';
              }
            } catch (_e) { /* */ }
          }
        }
        if (!out.sendButton && /ChatInputGradientButton|UIButton/i.test(cls)) {
          let label = '';
          try {
            label = safeStr(view.accessibilityLabel());
          } catch (_e) { /* */ }
          let title = '';
          try {
            title = safeStr(view.currentTitle());
          } catch (_e) { /* */ }
          if (/傳送|发送|Send|傳送訊息|发送消息/i.test(label + ' ' + title)) {
            out.sendButton = view;
            out.source = out.source || 'walkSend';
          }
        }
      },
      0,
      16,
      800,
      { count: 0 },
    );
  });

  // If we found stage but not text/send, walk only the stage subtree more carefully.
  if (out.stage && (!out.textView || !out.sendButton)) {
    walkViews(
      out.stage,
      (view) => {
        let cls = '';
        try {
          cls = String(view.$className || '');
        } catch (_e) {
          return;
        }
        if (!out.textView && (/ChatInputTextView|UITextView/i.test(cls))) {
          try {
            if (view.respondsToSelector_(ObjC.selector('setText:'))) {
              out.textView = view;
              out.source = out.source || 'stageTextView';
            }
          } catch (_e) { /* */ }
        }
        if (!out.sendButton && /Button/i.test(cls)) {
          let label = '';
          try {
            label = safeStr(view.accessibilityLabel());
          } catch (_e) { /* */ }
          if (/傳送|发送|Send/i.test(label) || /ChatInputGradientButton/i.test(cls)) {
            out.sendButton = view;
            out.source = out.source || 'stageSend';
          }
        }
      },
      0,
      12,
      300,
      { count: 0 },
    );
  }
  return out;
}

function setComposerText(textView, text) {
  if (!textView || !textView.handle || textView.handle.isNull()) {
    return { ok: false, error: 'composer text view missing' };
  }
  const body = String(text || '');
  let err = null;
  let written = '';
  ObjC.schedule(ObjC.mainQueue, () => {
    try {
      try {
        if (textView.respondsToSelector_(ObjC.selector('becomeFirstResponder'))) {
          textView.becomeFirstResponder();
        }
      } catch (_e) { /* */ }
      if (textView.respondsToSelector_(ObjC.selector('setText:'))) {
        textView.setText_(body);
      } else if (textView.respondsToSelector_(ObjC.selector('insertText:'))) {
        try {
          if (textView.respondsToSelector_(ObjC.selector('setText:'))) textView.setText_('');
        } catch (_e) { /* */ }
        textView.insertText_(body);
      } else {
        err = 'composer text view is not editable';
        return;
      }
      try {
        const center = ObjC.classes.NSNotificationCenter.defaultCenter();
        center.postNotificationName_object_(
          'UITextViewTextDidChangeNotification',
          textView,
        );
      } catch (_e) { /* */ }
      try {
        if (textView.respondsToSelector_(ObjC.selector('delegate'))) {
          const d = textView.delegate();
          if (d && d.respondsToSelector_(ObjC.selector('textViewDidChange:'))) {
            d.textViewDidChange_(textView);
          }
        }
      } catch (_e) { /* */ }
      try {
        written = safeStr(textView.text());
      } catch (_e) {
        written = body;
      }
    } catch (e) {
      err = String(e);
    }
  });
  Thread.sleep(0.35);
  if (err) return { ok: false, error: err };
  if (written !== body) {
    return {
      ok: false,
      error: 'composer text view did not accept the full message body',
      written: written.slice(0, 80),
    };
  }
  return { ok: true, written };
}

function tapComposerSend(sendButton) {
  if (!sendButton || !sendButton.handle || sendButton.handle.isNull()) {
    return { ok: false, error: 'composer send button missing' };
  }
  let err = null;
  ObjC.schedule(ObjC.mainQueue, () => {
    try {
      // UIControlEventTouchUpInside = 1 << 6 = 64
      if (sendButton.respondsToSelector_(ObjC.selector('sendActionsForControlEvents:'))) {
        sendButton.sendActionsForControlEvents_(64);
        return;
      }
      err = 'sendActionsForControlEvents: missing on send button';
    } catch (e) {
      err = String(e);
    }
  });
  Thread.sleep(0.4);
  if (err) return { ok: false, error: err };
  return { ok: true, path: 'ChatInputGradientButton.TouchUpInside' };
}

function ensureChatComposerOpen(conversationId, peerUid) {
  let opened = null;
  if (peerUid) {
    opened = imOpenChatByPeerUid({ peerUid });
  } else if (conversationId) {
    opened = imOpenChat({ conversationId });
  } else {
    return { ok: false, error: 'conversationId or peerUid required to open composer' };
  }

  // Chat VC + Swift composer mount asynchronously after transferToMessageVC.
  let controls = { textView: null, sendButton: null, stage: null };
  const attempts = [3.0, 2.0, 2.0, 2.5, 3.0];
  for (let i = 0; i < attempts.length; i++) {
    Thread.sleep(attempts[i]);
    controls = findChatComposerControls();
    if (controls.textView && controls.sendButton) break;
    // Re-issue open once if first open apparently did not present composer.
    if (i === 1) {
      try {
        if (peerUid) imOpenChatByPeerUid({ peerUid });
        else if (conversationId) imOpenChat({ conversationId });
      } catch (_e) { /* */ }
    }
  }
  if (!controls.textView) {
    return {
      ok: false,
      error: 'TikTok chat composer text view not found after open_chat',
      opened,
      hasStage: !!controls.stage,
      findSource: controls.source || null,
    };
  }
  if (!controls.sendButton) {
    return {
      ok: false,
      error: 'TikTok chat send button (傳送) not found after open_chat',
      opened,
      hasTextView: true,
      hasStage: !!controls.stage,
      findSource: controls.source || null,
    };
  }
  return { ok: true, opened, controls, findSource: controls.source || null };
}

function findLiveTextMatch(conversationId, text, startedAt) {
  const wanted = String(text || '');
  const cid = String(conversationId || '');
  const hits = [];
  try {
    const msgs = ObjC.chooseSync(ObjC.classes.AWEIMTextMessage) || [];
    for (let i = 0; i < Math.min(msgs.length, 80); i++) {
      const m = msgs[i];
      const body = extractMessageText(m);
      if (body !== wanted) continue;
      const mcid =
        safeStr(tryCall(m, 'conversationID', [])) ||
        safeStr(tryCall(m, 'conversationId', []));
      if (cid && mcid && mcid !== cid) continue;
      hits.push({
        content: body,
        conversationId: mcid || null,
        messageId:
          safeStr(tryCall(m, 'serverMessageID', [])) ||
          safeStr(tryCall(m, 'messageID', [])) ||
          safeStr(tryCall(m, 'messageId', [])) ||
          null,
        className: m.$className,
        source: 'AWEIMTextMessage',
      });
    }
  } catch (_e) { /* */ }
  if (hits.length) return hits[0];
  try {
    const listed = imListMessages({ conversationId: cid, limit: 12 });
    const rows = (listed && listed.messages) || [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i] && rows[i].content === wanted) {
        return {
          content: rows[i].content,
          conversationId: cid || null,
          messageId: rows[i].messageId || null,
          className: rows[i].className || null,
          source: listed.source || 'imListMessages',
          createdAt: rows[i].createdAt || null,
        };
      }
    }
  } catch (_e) { /* */ }
  // Avoid unused-arg warnings when startedAt is only for future filtering.
  void startedAt;
  return null;
}

function waitForVisibleText(conversationId, text, startedAt, timeoutMs) {
  const deadline = Date.now() + Math.max(1500, Math.min(30000, Number(timeoutMs) || 15000));
  while (Date.now() < deadline) {
    const hit = findLiveTextMatch(conversationId, text, startedAt);
    if (hit) return hit;
    Thread.sleep(0.25);
  }
  return null;
}

function sendTextViaComposer(options) {
  const opts = options || {};
  const conversationId = String(opts.conversationId || '').trim();
  const peerUid = opts.peerUid != null ? String(opts.peerUid).trim() : '';
  const text = String(opts.text || '');
  const confirmTimeoutMs = Number(opts.confirmTimeoutMs) || 15000;

  const opened = ensureChatComposerOpen(conversationId, peerUid);
  if (!opened.ok) return opened;

  const typed = setComposerText(opened.controls.textView, text);
  if (!typed.ok) return typed;

  const startedAt = Date.now();
  const tapped = tapComposerSend(opened.controls.sendButton);
  if (!tapped.ok) return tapped;

  // Composer should clear after a real send; empty field is a weak signal only.
  Thread.sleep(0.8);
  let composerCleared = null;
  try {
    composerCleared = safeStr(opened.controls.textView.text()) === '';
  } catch (_e) {
    composerCleared = null;
  }

  const visible = waitForVisibleText(conversationId, text, startedAt, confirmTimeoutMs);
  if (!visible) {
    return {
      ok: false,
      sent: false,
      dryRun: false,
      transport: 'composer',
      networkAck: false,
      error:
        'Composer send was invoked but the exact text was not re-read from the live chat models',
      conversationId: conversationId || null,
      peerUid: peerUid || null,
      textPreview: text.slice(0, 80),
      composerCleared,
      path: tapped.path,
    };
  }
  return {
    ok: true,
    dryRun: false,
    sent: true,
    transport: 'composer',
    networkAck: true,
    conversationId: conversationId || visible.conversationId || null,
    peerUid: peerUid || null,
    textPreview: text.slice(0, 80),
    verifiedText: visible.content,
    messageId: visible.messageId,
    verifySource: visible.source,
    composerCleared,
    path: tapped.path,
    receiptAt: Date.now(),
  };
}

function arrayItems(value, limit) {
  if (!value || !value.handle || value.handle.isNull()) return [];
  try {
    if (!value.isKindOfClass_(ObjC.classes.NSArray)) return [];
    const n = Math.min(Number(value.count()), limit);
    const out = [];
    for (let i = 0; i < n; i++) out.push(value.objectAtIndex_(i));
    return out;
  } catch (_e) {
    return [];
  }
}

function pushChatItem(out, m, source) {
  if (!m || !m.handle || m.handle.isNull()) return;
  const peer = tryCall(m, 'peerUser', []) || tryCall(m, 'requestUserInfo', []);
  const latest = tryCall(m, 'latestMessage', []) || tryCall(m, 'lastMessage', []);
  const latestMessage = extractMessageFields(latest);
  const requestManager = tryCall(m, 'messageRequestManager', []);
  const item = {
    conversationId:
      safeStr(tryCall(m, 'conversationID', [])) ||
      safeStr(tryCall(m, 'conversationId', [])) ||
      safeStr(tryCall(m, 'identifier', [])) ||
      safeStr(tryCall(m, 'conID', [])),
    name:
      safeStr(tryCall(m, 'name', [])) ||
      safeStr(tryCall(m, 'nickname', [])) ||
      safeStr(tryCall(m, 'displayName', [])) ||
      safeStr(tryCall(m, 'title', [])),
    peerUid:
      safeStr(tryCall(peer, 'userID', [])) ||
      safeStr(tryCall(peer, 'uid', [])),
    uniqueId:
      safeStr(tryCall(peer, 'uniqueID', [])) ||
      safeStr(tryCall(peer, 'unique_id', [])),
    latestMessage,
    latestMessageSendFromMe: !!tryCall(m, 'latestMessageSendFromMe', []),
    latestMessageIsSeen: !!tryCall(m, 'latestMessageIsSeen', []),
    isMessageRequest:
      !!tryCall(m, 'isMessageRequestSpamChat', []) ||
      !!(requestManager && requestManager.handle && !requestManager.handle.isNull()),
    source: source || null,
    className: m.$className,
  };
  if (!item.name && peer) {
    item.name =
      safeStr(tryCall(peer, 'nickname', [])) ||
      safeStr(tryCall(peer, 'displayName', [])) ||
      item.uniqueId;
  }
  if (item.conversationId || item.peerUid || (item.latestMessage && item.latestMessage.content)) {
    const exists = out.conversations.some((x) =>
      (item.conversationId && x.conversationId === item.conversationId) ||
      (!item.conversationId && item.peerUid && x.peerUid === item.peerUid),
    );
    if (!exists) out.conversations.push(item);
  }
}

export function imListConversations(options) {
  const limit = Math.max(1, Math.min(100, Number((options || {}).limit) || 20));
  const sdk = getIMSDKInstance();
  const out = {
    ok: false,
    source: null,
    conversations: [],
    hint:
      'If empty: net_dump({ query: "imapi|inbox|conversation", redact:false }) then send_text with conversationId',
  };

  // Inbox controller triggers TikTok's own IM network sync. Multiple page/data-manager
  // variants are required because new-contact messages live in Message Requests rather
  // than the normal chatArray on recent builds.
  try {
    const Mod = ObjC.classes.AWEIMModuleService;
    const ctrl = tryClassCall(Mod, 'inboxDataController', []);
    if (ctrl && ctrl.handle && !ctrl.handle.isNull()) {
      try {
        if (ctrl.respondsToSelector_(ObjC.selector('fetchChatList'))) {
          ctrl.fetchChatList();
        }
      } catch (_e) { /* */ }
      // Give the app-owned request a bounded chance to refill its cache.
      const deadline = Date.now() + Math.max(500, Math.min(5000, Number((options || {}).timeoutMs) || 1800));
      while (Date.now() < deadline) {
        const chatArray = tryCall(ctrl, 'chatArray', []);
        if (arrayItems(chatArray, 1).length) break;
        Thread.sleep(0.1);
      }

      const lists = [
        ['chatArray', tryCall(ctrl, 'chatArray', [])],
        ['viewModelArray', tryCall(ctrl, 'viewModelArray', [])],
        ['chatModels', tryCall(ctrl, 'chatModels', [])],
        ['allChatModels', tryCall(ctrl, 'allChatModels', [])],
        ['conversationList', tryCall(ctrl, 'conversationList', [])],
        ['currentChatList', tryCall(ctrl, 'currentChatList', [])],
        ['dataSource', tryCall(ctrl, 'dataSource', [])],
      ];
      // Inbox page types/data-manager types vary between TikTok builds. Page 0 is the
      // normal inbox; later pages commonly include Message Requests / notifications.
      for (let page = 0; page <= 6; page++) {
        lists.push(['inboxPage:' + page, tryCall(ctrl, 'viewModelArrayWithInboxPageType:', [page])]);
        lists.push(['dataManager:' + page, tryCall(ctrl, 'chatArrayWithDataManagerType:', [page])]);
      }
      for (let li = 0; li < lists.length; li++) {
        const pair = lists[li];
        const chats = arrayItems(pair[1], limit);
        for (let i = 0; i < chats.length; i++) pushChatItem(out, chats[i], pair[0]);
      }
      out.inboxCtrlClass = ctrl.$className;
      if (out.conversations.length) {
        out.ok = true;
        out.source = 'inboxDataController';
        return out;
      }
    }
  } catch (_e) { /* */ }

  try {
    const S = ObjC.classes.AWEIMModuleService;
    if (S) {
      const inst = tryClassCall(S, 'sharedInstance', []);
      const chats =
        tryCall(inst, 'allChatModels', []) ||
        tryCall(inst, 'chatModels', []) ||
        tryCall(inst, 'conversationList', []);
      if (chats && chats.isKindOfClass_(ObjC.classes.NSArray)) {
        const n = Math.min(Number(chats.count()), limit);
        for (let i = 0; i < n; i++) pushChatItem(out, chats.objectAtIndex_(i));
        if (out.conversations.length) {
          out.ok = true;
          out.source = 'sdk';
          return out;
        }
      }
    }
  } catch (_e) { /* */ }

  try {
    const Conv = ObjC.classes.TIMOConversation;
    if (Conv && sdk) {
      const list =
        tryCall(Conv, 'conversationsWithSDKInstance:', [sdk]) ||
        tryClassCall(Conv, 'conversationsWithSDKInstance:', [sdk]);
      if (list && list.isKindOfClass_(ObjC.classes.NSArray)) {
        const n = Math.min(Number(list.count()), limit);
        for (let i = 0; i < n; i++) pushChatItem(out, list.objectAtIndex_(i), 'cache');
        if (out.conversations.length) {
          out.ok = true;
          out.source = 'cache';
          return out;
        }
      }
    }
  } catch (_e) { /* */ }

  // Recent chat users (may work even when chatArray empty)
  try {
    const Mod = ObjC.classes.AWEIMModuleService;
    const ctrl = tryClassCall(Mod, 'inboxDataController', []);
    if (ctrl && ctrl.respondsToSelector_(ObjC.selector('getRecentChatUserListWithLimitCount:'))) {
      const recent = ctrl.getRecentChatUserListWithLimitCount_(limit);
      if (recent && recent.isKindOfClass_(ObjC.classes.NSArray) && Number(recent.count()) > 0) {
        const selfUid = (() => {
          try {
            const svc = getUserService();
            const u = tryCall(svc, 'currentLoginUser', []);
            return safeStr(tryCall(u, 'userID', []) || tryCall(u, 'uid', []));
          } catch (_e) {
            return '';
          }
        })();
        const Chat = ObjC.classes.AWEIMChatModel;
        const n = Math.min(Number(recent.count()), limit);
        for (let i = 0; i < n; i++) {
          const u = recent.objectAtIndex_(i);
          const peerUid =
            safeStr(tryCall(u, 'userID', [])) || safeStr(tryCall(u, 'uid', []));
          let conversationId = '';
          try {
            if (
              Chat &&
              selfUid &&
              peerUid &&
              Chat.respondsToSelector_(
                ObjC.selector('oneToOneSessionIDOfPeerID:currentUserID:'),
              )
            ) {
              conversationId = safeStr(
                Chat.oneToOneSessionIDOfPeerID_currentUserID_(peerUid, selfUid),
              );
            }
          } catch (_e) { /* */ }
          if (!conversationId && Mod.respondsToSelector_(ObjC.selector('getSingleChatConversationIDFromUserID:'))) {
            try {
              conversationId = safeStr(Mod.getSingleChatConversationIDFromUserID_(peerUid));
            } catch (_e) { /* */ }
          }
          out.conversations.push({
            conversationId,
            peerUid,
            name:
              safeStr(tryCall(u, 'nickname', [])) ||
              safeStr(tryCall(u, 'displayName', [])) ||
              safeStr(tryCall(u, 'uniqueID', [])),
            uniqueId:
              safeStr(tryCall(u, 'uniqueID', [])) ||
              safeStr(tryCall(u, 'unique_id', [])),
            className: u.$className,
          });
        }
        if (out.conversations.length) {
          out.ok = true;
          out.source = 'recentChatUsers';
          return out;
        }
      }
    }
  } catch (_e) { /* */ }

  out.error = 'conversation list path not available on this build';
  out.sdkFound = !!sdk;
  out.sdkClass = sdk ? sdk.$className : null;
  out.hasModuleService = classExists('AWEIMModuleService');
  out.hasTIMOConversation = classExists('TIMOConversation');
  return out;
}

/**
 * Network-backed inbox snapshot. This does not navigate UIKit: it asks TikTok's
 * inbox controller to refresh, then surfaces normal chats and Message Requests.
 */
export function imInboxMessages(options) {
  const opts = options || {};
  const onlyUnread = opts.onlyUnread === true;
  const hooks = installIncomingMessageHooks();
  const snapshot = imListConversations(opts);
  const messages = [];
  const conversations = snapshot.conversations || [];
  for (let i = 0; i < conversations.length; i++) {
    const c = conversations[i];
    const latest = c.latestMessage;
    if (!latest || !latest.content) continue;
    if (onlyUnread && (c.latestMessageSendFromMe || c.latestMessageIsSeen)) continue;
    messages.push({
      conversationId: c.conversationId || null,
      peerUid: c.peerUid || null,
      username: c.name || c.uniqueId || null,
      uniqueId: c.uniqueId || null,
      content: latest.content,
      createdAt: latest.createdAt || null,
      senderId: latest.senderId || c.peerUid || null,
      isMessageRequest: !!c.isMessageRequest,
      source: c.source || snapshot.source || null,
      networkIncoming: false,
    });
  }
  // New followers can be placed in TikTok's Message Requests notification area
  // rather than chatArray. Once the app receives the push/pull, these events are
  // available even when no visible inbox row has been created yet.
  const seen = {};
  for (let i = 0; i < messages.length; i++) {
    const x = messages[i];
    seen[(x.conversationId || '') + '|' + (x.senderId || '') + '|' + x.content + '|' + (x.createdAt || '')] = true;
  }
  for (let i = 0; i < incomingMessages.length; i++) {
    const x = incomingMessages[i];
    if (onlyUnread && x.sentByMe) continue;
    const key = (x.conversationId || '') + '|' + (x.senderId || '') + '|' + x.content + '|' + (x.createdAt || '');
    if (!seen[key]) {
      seen[key] = true;
      messages.push(x);
    }
  }
  return {
    ok: snapshot.ok || messages.length > 0,
    source: snapshot.source || (messages.some((x) => x.networkIncoming) ? 'incomingObserver' : null),
    networkRefresh: true,
    incomingHook: hooks.ok === true,
    messages,
    conversations: conversations.length,
    error: snapshot.ok || messages.length > 0 ? null : snapshot.error || null,
    hint: snapshot.ok || messages.length > 0
      ? 'Use send_text with conversationId or peerUid and transport:"network" to reply.'
      : 'TikTok returned no loaded Inbox/Message Request models. Keep TikTok open and retry inbox after a few seconds.',
  };
}

function isPlaceholderContent(value) {
  const s = String(value || '').trim();
  if (!s) return true;
  if (s === '{}' || s === '{\n}' || s === '{\r\n}') return true;
  if (/^</.test(s) && /MessageContent|NSObject|0x[0-9a-fA-F]+/.test(s)) return true;
  return false;
}

/** Pull text= from NSDictionary description blobs returned by TIMOMessage.content. */
function textFromDescriptionBlob(raw) {
  const s = String(raw || '');
  const m =
    s.match(/text\s*=\s*"((?:\\.|[^"\\])*)"/) ||
    s.match(/text\s*=\s*([^;\n}]+)/);
  if (!m) return '';
  let body = String(m[1] || '').trim();
  if (body.startsWith('"') && body.endsWith('"')) body = body.slice(1, -1);
  body = body.replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
  return isPlaceholderContent(body) ? '' : body;
}

function textFromDictLike(dict) {
  if (!dict || !dict.handle || dict.handle.isNull()) return '';
  try {
    if (dict.respondsToSelector_(ObjC.selector('objectForKey:'))) {
      for (const key of ['text', 'content', 'tips', 'msg_content']) {
        const v = dict.objectForKey_(key);
        const s = safeStr(v).trim();
        if (s && !isPlaceholderContent(s)) return s;
      }
    }
  } catch (_e) { /* */ }
  return '';
}

function textFromContentObject(content) {
  if (!content || !content.handle || content.handle.isNull()) return '';
  try {
    if (content.respondsToSelector_(ObjC.selector('text'))) {
      const s = safeStr(content.text()).trim();
      if (s && !isPlaceholderContent(s)) return s;
    }
  } catch (_e) { /* */ }
  try {
    if (content.respondsToSelector_(ObjC.selector('contentDictionary'))) {
      const s = textFromDictLike(content.contentDictionary());
      if (s) return s;
    }
  } catch (_e) { /* */ }
  const raw = safeStr(content).trim();
  return isPlaceholderContent(raw) ? '' : raw;
}

/**
 * Extract displayable message body. On this TikTok build TIMOMessage.content is
 * often just "{}" while AWEIMTextMessage.text / fullContentDict.text hold the real UI text.
 */
function extractMessageText(msg) {
  if (!msg || !msg.handle || msg.handle.isNull()) return '';
  const candidates = [];
  try {
    if (msg.respondsToSelector_(ObjC.selector('text'))) {
      candidates.push(safeStr(msg.text()));
    }
  } catch (_e) { /* */ }
  try {
    if (msg.respondsToSelector_(ObjC.selector('fullContentDict'))) {
      candidates.push(textFromDictLike(msg.fullContentDict()));
    }
  } catch (_e) { /* */ }
  try {
    if (msg.respondsToSelector_(ObjC.selector('forwardContentDict'))) {
      candidates.push(textFromDictLike(msg.forwardContentDict()));
    }
  } catch (_e) { /* */ }
  try {
    if (msg.respondsToSelector_(ObjC.selector('getContent'))) {
      candidates.push(textFromContentObject(msg.getContent()));
    }
  } catch (_e) { /* */ }
  try {
    if (msg.respondsToSelector_(ObjC.selector('content'))) {
      const c = msg.content();
      if (c && c.handle && !c.handle.isNull() && !c.isKindOfClass_(ObjC.classes.NSString)) {
        candidates.push(textFromContentObject(c));
      } else {
        candidates.push(safeStr(c));
      }
    }
  } catch (_e) { /* */ }
  try {
    if (msg.respondsToSelector_(ObjC.selector('attributedContent'))) {
      candidates.push(safeStr(msg.attributedContent()));
    }
  } catch (_e) { /* */ }
  for (let i = 0; i < candidates.length; i++) {
    const s = String(candidates[i] || '').trim();
    if (s && !isPlaceholderContent(s)) {
      // TIMO often stringifies the full content dict; prefer the inner text field.
      if (/aweType\s*=/.test(s) && /text\s*=/.test(s)) {
        const inner = textFromDescriptionBlob(s);
        if (inner) return inner.slice(0, 500);
      }
      return s.slice(0, 500);
    }
  }
  return '';
}

function extractMessageFields(msg) {
  if (!msg || !msg.handle || msg.handle.isNull()) return null;
  const item = {
    content: extractMessageText(msg),
    createdAt: null,
    senderId: null,
    senderName: null,
    messageId:
      safeStr(tryCall(msg, 'messageID', [])) ||
      safeStr(tryCall(msg, 'messageId', [])) ||
      safeStr(tryCall(msg, 'identifier', [])) ||
      safeStr(tryCall(msg, 'localMessageID', [])) ||
      '',
    conversationId:
      safeStr(tryCall(msg, 'conversationID', [])) ||
      safeStr(tryCall(msg, 'conversationId', [])) ||
      '',
    className: msg.$className,
  };
  try {
    if (msg.respondsToSelector_(ObjC.selector('createdAt'))) {
      item.createdAt = safeStr(msg.createdAt());
    } else if (msg.respondsToSelector_(ObjC.selector('localCreatedAt'))) {
      item.createdAt = safeStr(msg.localCreatedAt());
    }
  } catch (_e) { /* */ }
  try {
    if (msg.respondsToSelector_(ObjC.selector('sender'))) {
      item.senderId = safeStr(msg.sender());
    }
  } catch (_e) { /* */ }
  try {
    if (msg.respondsToSelector_(ObjC.selector('senderProfile'))) {
      const p = msg.senderProfile();
      if (p && !p.handle.isNull()) {
        item.senderName =
          safeStr(tryCall(p, 'nickname', [])) ||
          safeStr(tryCall(p, 'displayName', [])) ||
          safeStr(tryCall(p, 'uniqueID', []));
        if (!item.senderId) {
          item.senderId =
            safeStr(tryCall(p, 'userID', [])) || safeStr(tryCall(p, 'uid', []));
        }
      }
    }
  } catch (_e) { /* */ }
  return item;
}

const incomingMessages = [];
let incomingHooksInstalled = false;

function pushIncomingMessage(msg, conversationId, source) {
  const item = extractMessageFields(msg);
  if (!item || !item.content) return;
  const cid =
    conversationId ||
    safeStr(tryCall(msg, 'conversationID', [])) ||
    safeStr(tryCall(msg, 'conversationId', []));
  const key = (cid || '') + '|' + (item.senderId || '') + '|' + item.content + '|' + (item.createdAt || '');
  for (let i = incomingMessages.length - 1; i >= 0; i--) {
    const x = incomingMessages[i];
    if (((x.conversationId || '') + '|' + (x.senderId || '') + '|' + x.content + '|' + (x.createdAt || '')) === key) return;
  }
  incomingMessages.push({
    conversationId: cid || null,
    peerUid: item.senderId || null,
    username: item.senderName || null,
    uniqueId: null,
    content: item.content,
    createdAt: item.createdAt || null,
    senderId: item.senderId || null,
    isMessageRequest: !cid,
    source,
    networkIncoming: true,
    sentByMe: false,
  });
  while (incomingMessages.length > 100) incomingMessages.shift();
}

function installIncomingMessageHooks() {
  if (incomingHooksInstalled) return { ok: true, already: true };
  let installed = 0;
  try {
    const Conv = ObjC.classes.TIMOConversation;
    const method = Conv && Conv['- onMessagesCreated:belongingConversationMap:reason:isPullMessage:'];
    if (method && method.implementation) {
      Interceptor.attach(method.implementation, {
        onEnter(args) {
          try {
            const conv = new ObjC.Object(args[0]);
            const cid = conversationIdentity(conv);
            const list = args[2] && !args[2].isNull() ? new ObjC.Object(args[2]) : null;
            const rows = arrayItems(list, 50);
            for (let i = 0; i < rows.length; i++) pushIncomingMessage(rows[i], cid, 'TIMOConversation.onMessagesCreated');
          } catch (_e) { /* Keep TikTok's IM callback untouched. */ }
        },
      });
      installed++;
    }
  } catch (_e) { /* */ }
  try {
    const Data = ObjC.classes.AWEIMMessageDataController;
    const method = Data && Data['- p_notifyDidReceiveNewMessage:'];
    if (method && method.implementation) {
      Interceptor.attach(method.implementation, {
        onEnter(args) {
          try {
            const msg = args[2] && !args[2].isNull() ? new ObjC.Object(args[2]) : null;
            pushIncomingMessage(msg, '', 'AWEIMMessageDataController.p_notifyDidReceiveNewMessage');
          } catch (_e) { /* */ }
        },
      });
      installed++;
    }
  } catch (_e) { /* */ }
  incomingHooksInstalled = installed > 0;
  return incomingHooksInstalled
    ? { ok: true, installed }
    : { ok: false, error: 'TikTok incoming IM observer selectors missing' };
}

/**
 * List recent messages in a conversation (best-effort via lastMessage / data controller).
 */
export function imListMessages(options) {
  const opts = options || {};
  const conversationId = String(opts.conversationId || '').trim();
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 20));
  if (!conversationId) {
    return {
      ok: false,
      error: 'conversationId required',
      hint: 'Use conversations or oneToOneSessionIDOfPeerID to obtain id',
    };
  }

  const out = {
    ok: false,
    conversationId,
    peerName: null,
    messages: [],
    source: null,
  };

  const convRes = conversationFromId(conversationId);
  if (convRes.ok && convRes.conversation) {
    const c = convRes.conversation;
    try {
      const last =
        tryCall(c, 'lastMessage', []) ||
        tryCall(c, 'lastMessageIncludeSoftDelete:', [0]) ||
        tryCall(c, 'lastMessageIncludeSoftDelete:', [false]);
      const one = extractMessageFields(last);
      if (one) out.messages.push(one);
    } catch (_e) { /* */ }
    try {
      out.peerName =
        safeStr(tryCall(c, 'name', [])) ||
        safeStr(tryCall(c, 'displayName', []));
    } catch (_e) { /* */ }
  }

  // chat model peer info
  try {
    const Mod = ObjC.classes.AWEIMModuleService;
    const ctrl = tryClassCall(Mod, 'inboxDataController', []);
    if (ctrl && ctrl.respondsToSelector_(ObjC.selector('chatModelWithConversationId:'))) {
      const cm = ctrl.chatModelWithConversationId_(conversationId);
      if (cm && !cm.handle.isNull()) {
        const peer = tryCall(cm, 'peerUser', []) || tryCall(cm, 'requestUserInfo', []);
        if (peer && peer.handle && !peer.handle.isNull()) {
          out.peerName =
            out.peerName ||
            safeStr(tryCall(peer, 'nickname', [])) ||
            safeStr(tryCall(peer, 'displayName', [])) ||
            safeStr(tryCall(peer, 'uniqueID', []));
          out.peerUid =
            safeStr(tryCall(peer, 'userID', [])) || safeStr(tryCall(peer, 'uid', []));
        }
        const latest = tryCall(cm, 'latestMessage', []);
        const lm = extractMessageFields(latest);
        if (lm && !out.messages.length) out.messages.push(lm);
        out.source = out.source || 'chatModel';
      }
    }
  } catch (_e) { /* */ }

  // Live presentation models hold real text; TIMOMessage.content is often "{}".
  try {
    const live = ObjC.chooseSync(ObjC.classes.AWEIMTextMessage) || [];
    const seen = {};
    for (let i = 0; i < out.messages.length; i++) {
      const m = out.messages[i];
      seen[(m.messageId || '') + '|' + (m.content || '') + '|' + (m.createdAt || '')] = true;
    }
    for (let i = 0; i < Math.min(live.length, 120); i++) {
      const m = live[i];
      const mcid =
        safeStr(tryCall(m, 'conversationID', [])) ||
        safeStr(tryCall(m, 'conversationId', []));
      if (mcid && mcid !== conversationId) continue;
      const fields = extractMessageFields(m);
      if (!fields || !fields.content) continue;
      const key = (fields.messageId || '') + '|' + fields.content + '|' + (fields.createdAt || '');
      if (seen[key]) continue;
      seen[key] = true;
      out.messages.push(fields);
      out.source = out.source || 'liveAWEIMTextMessage';
    }
  } catch (_e) { /* */ }

  // Prefer newest first when timestamps exist; otherwise keep discovery order.
  try {
    out.messages.sort((a, b) => {
      const ta = Date.parse(String(a.createdAt || '')) || 0;
      const tb = Date.parse(String(b.createdAt || '')) || 0;
      return ta - tb;
    });
  } catch (_e) { /* */ }

  out.ok = out.messages.length > 0 || !!out.peerName;
  out.returned = out.messages.slice(-limit);
  out.messages = out.returned;
  delete out.returned;
  if (!out.ok) {
    out.error = 'no messages found (empty inbox or conversation not loaded)';
    out.hint =
      'Open the chat once in UI, or send_text first. Account with zero chats cannot list history.';
    out.conversationResolved = !!(convRes && convRes.ok);
  } else {
    out.source = out.source || (convRes.ok ? convRes.source : 'partial');
  }
  return out;
}

/**
 * Open chat UI for conversationId (main thread).
 */
export function imOpenChat(options) {
  const opts = options || {};
  const conversationId = String(opts.conversationId || '').trim();
  if (!conversationId) return { ok: false, error: 'conversationId required' };

  try {
    const Mod = ObjC.classes.AWEIMModuleService;
    if (!Mod) return { ok: false, error: 'AWEIMModuleService missing' };

    let fromVC = null;
    try {
      const app = ObjC.classes.UIApplication.sharedApplication();
      const win = app.keyWindow ? app.keyWindow() : null;
      let root = win && win.rootViewController ? win.rootViewController() : null;
      fromVC = root;
      while (
        fromVC &&
        fromVC.presentedViewController &&
        !fromVC.presentedViewController().handle.isNull()
      ) {
        fromVC = fromVC.presentedViewController();
      }
      if (fromVC && fromVC.respondsToSelector_(ObjC.selector('visibleViewController'))) {
        const v = fromVC.visibleViewController();
        if (v && !v.handle.isNull()) fromVC = v;
      } else if (fromVC && fromVC.respondsToSelector_(ObjC.selector('topViewController'))) {
        const v = fromVC.topViewController();
        if (v && !v.handle.isNull()) fromVC = v;
      }
    } catch (_e) { /* */ }

    let target = getIMModuleService();

    const sel =
      'transferToMessageVCWithConversationID:serverMessageId:fromVC:extension:completion:';
    const sel2 =
      'transferToMessageVCWithConversationID:conversationType:fromVC:extension:completion:';

    if (!target || target.handle.isNull()) {
      return {
        ok: false,
        error: 'no AWEIMModuleService instance for open_chat',
        conversationId,
      };
    }

    let called = false;
    let callErr = null;
    const block = new ObjC.Block({
      retType: 'void',
      argTypes: ['object'],
      implementation() {},
    });
    ObjC.schedule(ObjC.mainQueue, () => {
      try {
        if (target.respondsToSelector_(ObjC.selector(sel))) {
          target.transferToMessageVCWithConversationID_serverMessageId_fromVC_extension_completion_(
            conversationId,
            null,
            fromVC,
            null,
            block,
          );
          called = true;
        } else if (target.respondsToSelector_(ObjC.selector(sel2))) {
          target.transferToMessageVCWithConversationID_conversationType_fromVC_extension_completion_(
            conversationId,
            1,
            fromVC,
            null,
            block,
          );
          called = true;
        } else {
          callErr = 'transferToMessageVC* selector missing on instance ' + target.$className;
        }
      } catch (e) {
        callErr = String(e);
      }
    });
    Thread.sleep(0.5);
    if (callErr) return { ok: false, error: callErr, conversationId };
    return {
      ok: true,
      conversationId,
      opened: called,
      targetClass: target.$className,
      note: 'Navigated on main queue; verify with screen_snapshot',
    };
  } catch (e) {
    return { ok: false, error: String(e), conversationId };
  }
}

/**
 * Open 1:1 chat by peer uid (instance method transferToMessageVCWithUid:...).
 */
export function imOpenChatByPeerUid(options) {
  const opts = options || {};
  const peerUid = String(opts.peerUid || opts.uid || '').trim();
  const nickname = String(opts.nickname || '');
  if (!peerUid) return { ok: false, error: 'peerUid required' };

  try {
    const target = getIMModuleService();
    if (!target || target.handle.isNull()) {
      return { ok: false, error: 'no AWEIMModuleService instance', peerUid };
    }

    let fromVC = null;
    try {
      const app = ObjC.classes.UIApplication.sharedApplication();
      const win = app.keyWindow ? app.keyWindow() : null;
      let root = win && win.rootViewController ? win.rootViewController() : null;
      fromVC = root;
      while (
        fromVC &&
        fromVC.presentedViewController &&
        !fromVC.presentedViewController().handle.isNull()
      ) {
        fromVC = fromVC.presentedViewController();
      }
    } catch (_e) { /* */ }

    const sel =
      'transferToMessageVCWithUid:nickname:alias:isCompanyProfile:fromVC:showKeyboard:';
    const sel2 =
      'transferToMessageVCWithUid:nickname:alias:isCompanyProfile:fromVC:showKeyboard:ext:';

    let called = false;
    let callErr = null;
    ObjC.schedule(ObjC.mainQueue, () => {
      try {
        if (target.respondsToSelector_(ObjC.selector(sel))) {
          target.transferToMessageVCWithUid_nickname_alias_isCompanyProfile_fromVC_showKeyboard_(
            peerUid,
            nickname || peerUid,
            null,
            false,
            fromVC,
            false,
          );
          called = true;
        } else if (target.respondsToSelector_(ObjC.selector(sel2))) {
          target.transferToMessageVCWithUid_nickname_alias_isCompanyProfile_fromVC_showKeyboard_ext_(
            peerUid,
            nickname || peerUid,
            null,
            false,
            fromVC,
            false,
            null,
          );
          called = true;
        } else {
          callErr = 'transferToMessageVCWithUid* missing';
        }
      } catch (e) {
        callErr = String(e);
      }
    });
    Thread.sleep(0.6);
    if (callErr) return { ok: false, error: callErr, peerUid };
    return { ok: true, peerUid, opened: called, targetClass: target.$className };
  } catch (e) {
    return { ok: false, error: String(e), peerUid };
  }
}

/**
 * Resolve 1:1 conversationId from peer user id.
 */
export function imConversationIdForPeer(peerUid) {
  const uid = String(peerUid || '').trim();
  if (!uid) return { ok: false, error: 'peerUid required' };
  const svc = getUserService();
  const selfUser = tryCall(svc, 'currentLoginUser', []);
  const selfUid =
    safeStr(tryCall(selfUser, 'userID', [])) || safeStr(tryCall(selfUser, 'uid', []));
  const Chat = ObjC.classes.AWEIMChatModel;
  let conversationId = '';
  try {
    if (
      Chat &&
      selfUid &&
      Chat.respondsToSelector_(ObjC.selector('oneToOneSessionIDOfPeerID:currentUserID:'))
    ) {
      conversationId = safeStr(Chat.oneToOneSessionIDOfPeerID_currentUserID_(uid, selfUid));
    }
  } catch (_e) { /* */ }
  if (!conversationId) {
    const Mod = ObjC.classes.AWEIMModuleService;
    try {
      if (Mod && Mod.respondsToSelector_(ObjC.selector('getSingleChatConversationIDFromUserID:'))) {
        conversationId = safeStr(Mod.getSingleChatConversationIDFromUserID_(uid));
      }
    } catch (_e) { /* */ }
  }
  if (!conversationId) return { ok: false, error: 'could not build conversationId', peerUid: uid, selfUid };
  return { ok: true, peerUid: uid, selfUid, conversationId };
}

// The IM SDK sends through TikTok's Frontier/IM transport, not through UIKit.
// Keep an in-memory ledger of its asynchronous server responses so callers never
// mistake local object construction for a delivered network message.
const networkReceipts = [];
let networkReceiptHooksInstalled = false;

function messageIdentity(msg) {
  return (
    safeStr(tryCall(msg, 'messageID', [])) ||
    safeStr(tryCall(msg, 'messageId', [])) ||
    safeStr(tryCall(msg, 'identifier', [])) ||
    safeStr(tryCall(msg, 'localMessageID', [])) ||
    ''
  );
}

function messagePreview(msg) {
  return extractMessageText(msg);
}

function conversationIdentity(conv) {
  return (
    safeStr(tryCall(conv, 'identifier', [])) ||
    safeStr(tryCall(conv, 'conversationID', [])) ||
    safeStr(tryCall(conv, 'conversationId', [])) ||
    ''
  );
}

function pushNetworkReceipt(receipt) {
  networkReceipts.push(receipt);
  while (networkReceipts.length > 80) networkReceipts.shift();
}

function responseSucceeded(response) {
  if (!response || !response.handle || response.handle.isNull()) return true;
  try {
    const err = tryCall(response, 'error', []) || tryCall(response, 'localizedDescription', []);
    if (err && String(err)) return false;
  } catch (_e) { /* */ }
  const statusCandidates = ['statusCode', 'status', 'code', 'errorCode'];
  for (let i = 0; i < statusCandidates.length; i++) {
    const value = tryCall(response, statusCandidates[i], []);
    if (value == null || value === '') continue;
    const code = Number(value);
    if (!isNaN(code)) return code === 0 || code === 200;
  }
  return true;
}

function attachGenericResponseHook(Sender, selector, callback) {
  try {
    const method = Sender[selector];
    if (!method || !method.implementation) return false;
    Interceptor.attach(method.implementation, {
      onEnter(args) {
        try {
          const response = args[2] && !args[2].isNull() ? new ObjC.Object(args[2]) : null;
          pushNetworkReceipt({
            at: Date.now(),
            success: responseSucceeded(response),
            messageId: '',
            conversationId: '',
            text: '',
            callback,
          });
        } catch (_e) { /* */ }
      },
    });
    return true;
  } catch (_e) {
    return false;
  }
}

function installNetworkReceiptHooks() {
  if (networkReceiptHooksInstalled) return { ok: true, already: true };
  const Sender = ObjC.classes.AWEIMSendMessageController;
  if (!Sender) return { ok: false, error: 'AWEIMSendMessageController missing' };
  try {
    const method = Sender['- p_notifyObserversDidReceiveResponse:forMessage:inConversation:success:'];
    if (!method || !method.implementation) {
      return { ok: false, error: 'IM response observer selector missing' };
    }
    Interceptor.attach(method.implementation, {
      onEnter(args) {
        try {
          const msg = args[3] && !args[3].isNull() ? new ObjC.Object(args[3]) : null;
          const conv = args[4] && !args[4].isNull() ? new ObjC.Object(args[4]) : null;
          pushNetworkReceipt({
            at: Date.now(),
            success: !!args[5].toInt32(),
            messageId:
      safeStr(tryCall(msg, 'messageID', [])) ||
      safeStr(tryCall(msg, 'messageId', [])) ||
      safeStr(tryCall(msg, 'identifier', [])) ||
      safeStr(tryCall(msg, 'localMessageID', [])) ||
      '',
            conversationId: conversationIdentity(conv),
            text: messagePreview(msg),
            callback: 'observerResponse',
          });
        } catch (_e) { /* Never interrupt TikTok's send callback. */ }
      },
    });
    attachGenericResponseHook(Sender, '- iesim_didReceiveSendMessageResponse:', 'sendResponse');
    attachGenericResponseHook(Sender, '- iesim_didReceiveAsyncSendMessageResponse:', 'asyncSendResponse');
    networkReceiptHooksInstalled = true;
    return { ok: true, already: false };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function waitForNetworkReceipt(conversationId, text, startedAt, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, Math.min(30000, Number(timeoutMs) || 12000));
  const wantedConversation = String(conversationId || '');
  const wantedText = String(text || '');
  while (Date.now() < deadline) {
    for (let i = networkReceipts.length - 1; i >= 0; i--) {
      const r = networkReceipts[i];
      if (r.at < startedAt) continue;
      const conversationMatches = !wantedConversation || r.conversationId === wantedConversation;
      const textMatches = !wantedText || r.text === wantedText;
      // A generic SDK callback with no message identity is not evidence that
      // this particular text was sent.  It previously made blank bubbles look
      // successful when an unrelated IM operation completed.
      if (conversationMatches && textMatches) return r;
    }
    Thread.sleep(0.05);
  }
  return null;
}

function warmConversationNetwork(conversation) {
  if (!conversation || !conversation.handle || conversation.handle.isNull()) {
    return { ok: false, error: 'conversation missing' };
  }
  try {
    const sel = 'startMessageReadPollingTimerWithInterval:completion:';
    if (!conversation.respondsToSelector_(ObjC.selector(sel))) {
      return { ok: false, error: 'message polling selector missing' };
    }
    const block = new ObjC.Block({
      retType: 'void',
      argTypes: ['object'],
      implementation() {},
    });
    ObjC.schedule(ObjC.mainQueue, () => {
      try { conversation.startMessageReadPollingTimerWithInterval_completion_(1, block); } catch (_e) { /* */ }
    });
    Thread.sleep(0.25);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function imSendText(options) {
  const opts = options || {};
  const conversationId = String(opts.conversationId || '').trim();
  const text = String(opts.text || '');
  const dryRun = opts.dryRun !== false; // default true
  const peerUid = opts.peerUid != null ? String(opts.peerUid).trim() : '';
  // Default "network" now means: open the real chat composer, send through TikTok
  // UI, then re-read the exact text. Private SDK dispatchers hang / blank-bubble.
  const transport = String(opts.transport || 'network').toLowerCase();
  const confirmTimeoutMs = Number(opts.confirmTimeoutMs) || 15000;

  if (!conversationId && !peerUid) {
    return { ok: false, error: 'conversationId or peerUid required', dryRun };
  }
  if (!text) {
    return { ok: false, error: 'text required', dryRun };
  }

  let resolvedId = conversationId;
  if (!resolvedId && peerUid) {
    const built = imConversationIdForPeer(peerUid);
    if (built.ok) resolvedId = built.conversationId;
  }

  // Prefer native send-model construction for dry-run diagnostics; fall back to
  // the presentation AWEIMTextMessage if the factory is unavailable.
  let built = buildNativeTextSendModel(text);
  if (!built.ok) {
    const legacy = buildTextMessage(text);
    if (legacy.ok) {
      built = {
        ok: true,
        model: legacy.message,
        via: legacy.via,
        textCheck: legacy.textCheck,
        messageType: legacy.messageType,
        aweType: legacy.aweType,
      };
    }
  }

  const convRes = conversationFromId(resolvedId || conversationId, peerUid);

  if (dryRun) {
    const composer = findChatComposerControls();
    return {
      ok: true,
      dryRun: true,
      sent: false,
      conversationId: resolvedId || conversationId || null,
      peerUid: peerUid || null,
      textPreview: text.slice(0, 80),
      messageClass: built.ok && built.model ? built.model.$className : null,
      messageBuilt: !!built.ok,
      buildVia: built.ok ? built.via || null : null,
      textCheck: built.ok ? built.textCheck || null : null,
      messageType: built.ok && built.messageType != null ? built.messageType : null,
      aweType: built.ok && built.aweType != null ? built.aweType : null,
      conversationResolved: !!(convRes && convRes.ok),
      conversationClass:
        convRes && convRes.ok && convRes.conversation ? convRes.conversation.$className : null,
      resolveSource: convRes && convRes.ok ? convRes.source || null : null,
      resolveError: convRes && !convRes.ok ? convRes.error : null,
      composerTextViewFound: !!(composer && composer.textView),
      composerSendButtonFound: !!(composer && composer.sendButton),
      transport: transport === 'sdk' ? 'sdk' : 'composer',
      note:
        'dryRun=true: no message was sent. dryRun:false uses the real ChatInput composer and succeeds only after the exact text is re-read.',
    };
  }

  // Explicit legacy path: never use the hanging private dispatcher. Only the
  // old public sendMessage:conversation: remains, and it is known to blank-bubble
  // unless the caller opts in and accepts no verified text.
  if (transport === 'sdk') {
    return {
      ok: false,
      dryRun: false,
      sent: false,
      transport: 'sdk',
      error:
        'transport:"sdk" is disabled: it previously created empty message bubbles. Use transport:"network" (composer UI + text re-read).',
      conversationId: resolvedId || conversationId || null,
      peerUid: peerUid || null,
      textPreview: text.slice(0, 80),
    };
  }

  try {
    return sendTextViaComposer({
      conversationId: resolvedId || conversationId,
      peerUid,
      text,
      confirmTimeoutMs,
    });
  } catch (e) {
    return {
      ok: false,
      error: String(e),
      dryRun: false,
      transport: 'composer',
      conversationId: resolvedId || conversationId || null,
      peerUid: peerUid || null,
    };
  }
}








