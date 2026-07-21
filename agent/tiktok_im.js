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

function conversationFromModule(conversationId, timeoutMs) {
  const Mod = ObjC.classes.AWEIMModuleService;
  if (!Mod) return null;
  if (!Mod.respondsToSelector_(ObjC.selector('getConversationWithConID:completion:'))) {
    return null;
  }
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
  try {
    Mod.getConversationWithConID_completion_(conversationId, block);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const start = Date.now();
  const limit = Math.max(500, Math.min(10000, timeoutMs || 3000));
  while (!done && Date.now() - start < limit) {
    Thread.sleep(0.05);
  }
  if (!done) return { ok: false, error: 'getConversationWithConID timeout' };
  if (conv && conv.handle && !conv.handle.isNull()) {
    return { ok: true, conversation: conv, source: 'module' };
  }
  return { ok: false, error: err || 'conversation null from module' };
}

function conversationFromId(conversationId) {
  const viaMod = conversationFromModule(conversationId, 3000);
  if (viaMod && viaMod.ok) return viaMod;

  const Conv = ObjC.classes.TIMOConversation;
  if (!Conv) {
    return {
      ok: false,
      error: viaMod ? viaMod.error : 'TIMOConversation missing',
      hint: 'Provide conversationId from net_dump query:imapi|inbox|conversation',
    };
  }
  const sdk = getIMSDKInstance();
  if (!sdk) {
    return {
      ok: false,
      error: 'IM SDK instance not found',
      hint: 'Provide conversationId from net_dump query:imapi|inbox|conversation',
      moduleError: viaMod ? viaMod.error : null,
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
  return { ok: false, error: 'instanceWithSDKInstance:conversationIdentifier: failed' };
}

function buildTextMessage(text) {
  const TextMsg = ObjC.classes.AWEIMTextMessage;
  if (!TextMsg) return { ok: false, error: 'AWEIMTextMessage missing' };
  try {
    let msg = TextMsg.alloc().init();
    if (msg.respondsToSelector_(ObjC.selector('setContent:'))) {
      msg.setContent_(text);
      return { ok: true, message: msg };
    }
    if (msg.respondsToSelector_(ObjC.selector('initWithContentDict:'))) {
      const dict = ObjC.classes.NSMutableDictionary.alloc().init();
      dict.setObject_forKey_(text, 'text');
      msg = TextMsg.alloc().initWithContentDict_(dict);
      if (msg && !msg.handle.isNull()) return { ok: true, message: msg };
    }
    if (TextMsg.respondsToSelector_(ObjC.selector('messageWithContent:'))) {
      msg = TextMsg.messageWithContent_(text);
      if (msg && !msg.handle.isNull()) return { ok: true, message: msg };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  return { ok: false, error: 'could not construct AWEIMTextMessage' };
}

function pushChatItem(out, m) {
  if (!m || !m.handle || m.handle.isNull()) return;
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
    className: m.$className,
  };
  if (item.conversationId) out.conversations.push(item);
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

  // inboxDataController (class method on AWEIMModuleService)
  try {
    const Mod = ObjC.classes.AWEIMModuleService;
    const ctrl = tryClassCall(Mod, 'inboxDataController', []);
    if (ctrl && ctrl.handle && !ctrl.handle.isNull()) {
      try {
        if (ctrl.respondsToSelector_(ObjC.selector('fetchChatList'))) {
          ctrl.fetchChatList();
        }
      } catch (_e) { /* */ }
      const lists = [
        tryCall(ctrl, 'chatArray', []),
        tryCall(ctrl, 'viewModelArray', []),
        tryCall(ctrl, 'chatModels', []),
        tryCall(ctrl, 'allChatModels', []),
        tryCall(ctrl, 'conversationList', []),
        tryCall(ctrl, 'currentChatList', []),
        tryCall(ctrl, 'dataSource', []),
      ];
      for (let li = 0; li < lists.length; li++) {
        const chats = lists[li];
        if (chats && chats.isKindOfClass && chats.isKindOfClass_(ObjC.classes.NSArray)) {
          const n = Math.min(Number(chats.count()), limit);
          for (let i = 0; i < n; i++) pushChatItem(out, chats.objectAtIndex_(i));
          if (out.conversations.length) {
            out.ok = true;
            out.source = 'inboxDataController';
            return out;
          }
        }
      }
      out.inboxCtrlClass = ctrl.$className;
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
        for (let i = 0; i < n; i++) pushChatItem(out, list.objectAtIndex_(i));
        if (out.conversations.length) {
          out.ok = true;
          out.source = 'cache';
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

export function imSendText(options) {
  const opts = options || {};
  const conversationId = String(opts.conversationId || '').trim();
  const text = String(opts.text || '');
  const dryRun = opts.dryRun !== false; // default true

  if (!conversationId) {
    return { ok: false, error: 'conversationId required', dryRun };
  }
  if (!text) {
    return { ok: false, error: 'text required', dryRun };
  }

  const Sender = ObjC.classes.AWEIMSendMessageController;
  if (!Sender) return { ok: false, error: 'AWEIMSendMessageController missing', dryRun };
  let sender;
  try {
    sender = Sender.sharedInstance();
  } catch (e) {
    return { ok: false, error: String(e), dryRun };
  }
  if (!sender || sender.handle.isNull()) {
    return { ok: false, error: 'sharedInstance null', dryRun };
  }

  const built = buildTextMessage(text);
  if (!built.ok) return { ok: false, error: built.error, dryRun };

  const convRes = conversationFromId(conversationId);
  if (!convRes.ok) {
    // dryRun still useful: message constructed; conversation must come from inbox/net_dump
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        sent: false,
        conversationId,
        textPreview: text.slice(0, 80),
        messageClass: built.message.$className,
        messageBuilt: true,
        conversationResolved: false,
        resolveError: convRes.error,
        hint: convRes.hint ||
          'conversation resolve failed — use net_dump query:imapi|inbox then retry with real conversationId',
        note: 'dryRun: text message object OK; conversation not resolved (list inbox or capture conversationId).',
      };
    }
    return {
      ok: false,
      error: convRes.error,
      hint: convRes.hint,
      dryRun,
      messageBuilt: true,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      sent: false,
      conversationId,
      textPreview: text.slice(0, 80),
      messageClass: built.message.$className,
      conversationClass: convRes.conversation.$className,
      conversationResolved: true,
      resolveSource: convRes.source || null,
      note: 'dryRun=true: objects constructed, sendMessage not called. Pass dryRun:false to send.',
    };
  }

  try {
    if (!sender.respondsToSelector_(ObjC.selector('sendMessage:conversation:'))) {
      return { ok: false, error: 'sendMessage:conversation: missing', dryRun: false };
    }
    sender.sendMessage_conversation_(built.message, convRes.conversation);
    return {
      ok: true,
      dryRun: false,
      sent: true,
      conversationId,
      textPreview: text.slice(0, 80),
    };
  } catch (e) {
    return { ok: false, error: String(e), dryRun: false, conversationId };
  }
}
