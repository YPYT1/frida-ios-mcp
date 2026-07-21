/**
 * Self posts list via in-process TTNet (App signs).
 */
import { ttnetRequest } from './ttnet_request.js';
import ObjC from 'frida-objc-bridge';

function safeStr(v) {
  try {
    if (v == null) return '';
    return String(v);
  } catch (_e) {
    return '';
  }
}

function currentUserId() {
  try {
    const S = ObjC.classes.AWEUserService || ObjC.classes.TTKUserService;
    if (!S) return '';
    let inst = null;
    if (S.respondsToSelector_(ObjC.selector('sharedService'))) inst = S.sharedService();
    else if (S.respondsToSelector_(ObjC.selector('sharedInstance'))) inst = S.sharedInstance();
    if (!inst) return '';
    const u = inst.respondsToSelector_(ObjC.selector('currentLoginUser'))
      ? inst.currentLoginUser()
      : null;
    if (!u || u.handle.isNull()) return '';
    if (u.respondsToSelector_(ObjC.selector('userID'))) return safeStr(u.userID());
    if (u.respondsToSelector_(ObjC.selector('uid'))) return safeStr(u.uid());
  } catch (_e) { /* */ }
  return '';
}

/**
 * Parse aweme_list even when JSON was truncated mid-object by ttnetRequest.
 */
function parseAwemeList(bodyJson) {
  const s = typeof bodyJson === 'string' ? bodyJson : '';
  let obj = null;
  try {
    obj = JSON.parse(s);
  } catch (_e) {
    obj = null;
  }

  const items = [];
  if (obj && typeof obj === 'object' && Array.isArray(obj.aweme_list)) {
    for (let i = 0; i < obj.aweme_list.length; i++) {
      const a = obj.aweme_list[i] || {};
      const stats = a.statistics || a.stats || {};
      let shareUrl =
        (a.share_info && (a.share_info.share_url || a.share_info.shareUrl)) ||
        a.share_url ||
        '';
      shareUrl = String(shareUrl || '');
      let awemeId = String(a.aweme_id || a.awemeId || a.group_id || a.groupId || '');
      if (!awemeId && shareUrl) {
        const um = shareUrl.match(/\/video\/(\d+)/);
        if (um) awemeId = um[1];
      }
      if (!shareUrl && awemeId) {
        const author =
          (a.author && (a.author.unique_id || a.author.uniqueId || a.author.uid)) || '';
        if (author) {
          shareUrl = 'https://www.tiktok.com/@' + author + '/video/' + awemeId;
        } else {
          shareUrl = 'https://www.tiktok.com/video/' + awemeId;
        }
      }
      items.push({
        awemeId,
        desc: String(a.desc || a.title || '').slice(0, 200),
        createTime: a.create_time || a.createTime || null,
        shareUrl: shareUrl || null,
        stats: {
          digg: stats.digg_count || stats.diggCount || null,
          comment: stats.comment_count || stats.commentCount || null,
          share: stats.share_count || stats.shareCount || null,
          play: stats.play_count || stats.playCount || null,
        },
      });
    }
    return {
      items,
      cursor: obj.max_cursor || obj.cursor || null,
      hasMore: obj.has_more === 1 || obj.has_more === true,
      statusCode: obj.status_code != null ? obj.status_code : null,
      parseMode: 'json',
    };
  }

  // Truncated JSON fallback: scrape aweme_id (+ nearby desc) from raw string
  const idRe = /"aweme_id"\s*:\s*"?(\d+)"?/g;
  let m;
  const seen = {};
  while ((m = idRe.exec(s)) !== null) {
    const id = m[1];
    if (seen[id]) continue;
    seen[id] = true;
    const slice = s.slice(Math.max(0, m.index - 50), Math.min(s.length, m.index + 800));
    let desc = '';
    const dm = slice.match(/"desc"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (dm) {
      try {
        desc = JSON.parse('"' + dm[1] + '"').slice(0, 200);
      } catch (_e) {
        desc = dm[1].slice(0, 200);
      }
    }
    let createTime = null;
    const cm = slice.match(/"create_time"\s*:\s*(\d+)/);
    if (cm) createTime = Number(cm[1]);
    items.push({
      awemeId: id,
      desc,
      createTime,
      shareUrl: 'https://www.tiktok.com/video/' + id,
      stats: {},
    });
    if (items.length >= 50) break;
  }
  return {
    items,
    cursor: null,
    hasMore: false,
    statusCode: null,
    parseMode: 'scrape',
  };
}

export function postsListSelf(options) {
  const opts = options || {};
  const count = Math.max(1, Math.min(50, Number(opts.count) || 12));
  const cursor = opts.cursor != null ? String(opts.cursor) : '0';
  const userId = String(opts.userId || currentUserId() || '');
  const url = opts.url || 'https://api.tiktokv.com/aweme/v1/aweme/post/';

  const params = Object.assign(
    {
      count: String(count),
      max_cursor: cursor,
      min_cursor: '0',
      source: '0',
    },
    opts.params || {},
  );
  if (userId) params.user_id = userId;

  const res = ttnetRequest({
    url,
    method: 'GET',
    params,
    needCommonParams: true,
    timeoutMs: opts.timeoutMs || 20000,
    maxBody: opts.maxBody || 200000,
  });

  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
      url,
      userId: userId || null,
      api: res.api,
      hint:
        'Calibrate path with net_dump query:aweme/post|aweme/v1/aweme/post then pass url/userId',
    };
  }

  const bodyStr = res.body && res.body.json ? res.body.json : '';
  const parsed = parseAwemeList(bodyStr);
  return {
    ok: true,
    url,
    userId: userId || null,
    count: parsed.items.length,
    items: parsed.items,
    cursor: parsed.cursor,
    hasMore: parsed.hasMore,
    statusCode: parsed.statusCode,
    parseMode: parsed.parseMode,
    bodyTruncated: !!(res.body && res.body.truncated),
    api: res.api,
    elapsedMs: res.elapsedMs,
  };
}
