/**
 * iOS Frida Agent · 入口。
 *
 * 编译：`frida.Compiler` 把本文件及其所有相对 import 打包成一个 bundle。
 * project_root 约定在最近一级含 `node_modules` 的目录（即 pnpm 根）。
 *
 * 运行时架构：
 *   UIApplication._touchesEvent + UITouch + IOHIDEvent  →  CADisplayLink 主线程派发
 *
 * 所有 RPC 都是**通用能力**，不包含业务语义：上层 Python 层（tiktok_actions）
 * 负责把它们组合成业务动作。
 */
import { tap }                             from './tap/tap.js';
import { swipe, swipePath }                from './swipe/swipe.js';
import { doubleTap }                       from './double_tap_like/double_tap.js';
import { inputText, firstResponderInfo, clearText } from './text_input/comment.js';
import { pressHome }                       from './press_home/press_home.js';
import { dumpModalView }                   from './handle_popup/handle_popup.js';
import { findView, findViews, dumpTree, dumpLoginGate, windowFrame } from './shared_js/view_tree.js';
import { collectTexts, collectTextsWithFrames, setTextAtPoint, findButtons, dumpAllViewStates } from './collect_labels.js';
import { setOtpCode } from './otp_input/otp_input.js';
import { netEnable, netDisable, netClear, netDump, netStatus, signLast } from './net_capture.js';
import { sbAlertList, sbAlertTap, sbAlertDismiss, sbAlertTrigger } from './springboard/sb_alerts.js';
import { ttnetRequest, ttnetStatus } from './ttnet_request.js';
import {
    imStatus,
    imListConversations,
    imSendText,
    userPhoneBindStatus,
} from './tiktok_im.js';
import { postsListSelf } from './tiktok_posts.js';

rpc.exports = {
    // --- 存活探针（MCP / 宿主勿用错误方法名当探针）---
    ping:       ()                       => 'pong',

    // --- 触摸原语 ---
    tap:        (x, y)                   => tap(x, y),
    swipe:      (direction, duration)    => swipe(direction, duration),
    swipePath:  (x0, y0, x1, y1, dur)    => swipePath(x0, y0, x1, y1, dur),
    doubleTap:  (x, y, gapMs)            => doubleTap(x, y, gapMs),

    // --- 视图树定位（TikTok 生产路径禁止调用 dump/find*）---
    findView:   (query)                  => findView(query || {}),
    findViews:  (query)                  => findViews(query || {}),
    dumpTree:   (opts)                   => dumpTree(opts || {}),
    windowFrame: ()                      => windowFrame(),

    // --- 文字输入 ---
    inputText:  (text, perCharDelayMs)   => inputText(text, perCharDelayMs),
    firstResponderInfo: ()               => firstResponderInfo(),
    clearText: ()                        => clearText(),

    // --- 系统操作 ---
    pressHome:  ()                       => pressHome(),

    // --- 弹窗 / 登录拦截检测 ---
    dumpModalView: ()                    => dumpModalView(),
    dumpLoginGate: ()                    => dumpLoginGate(),

    // --- 文字收集（不触发反调试）---
    collectTexts: ()                     => collectTexts(),
    collectTextsWithFrames: ()           => collectTextsWithFrames(),
    dumpAllViewStates: ()                => dumpAllViewStates(),
    setTextAtPoint: (cx, cy, text)       => setTextAtPoint(cx, cy, text),
    findButtons: ()                      => findButtons(),

    // --- OTP 输入（TikTok TMVerificationCodeInputView + TUXPinField）---
    setOtpCode: (code, source)           => setOtpCode(code, source),

    // --- 网络捕获（NSURLSession + TTNet/Cronet，进程内明文/解密后）---
    netEnable:  (options)                => netEnable(options || {}),
    netDisable: ()                       => netDisable(),
    netClear:   ()                       => netClear(),
    netDump:    (options)                => netDump(options || {}),
    netStatus:  ()                       => netStatus(),
    signLast:   (options)                => signLast(options || {}),

    // --- TTNet 代签请求 + TikTok IM / posts ---
    ttnetStatus:  ()                     => ttnetStatus(),
    ttnetRequest: (options)              => ttnetRequest(options || {}),
    imStatus:     ()                     => imStatus(),
    imListConversations: (options)       => imListConversations(options || {}),
    imSendText:   (options)              => imSendText(options || {}),
    userPhoneBindStatus: ()              => userPhoneBindStatus(),
    postsListSelf: (options)             => postsListSelf(options || {}),

    // --- SpringBoard 系统弹窗（注入 SpringBoard 时用）---
    sbAlertList:    ()                   => sbAlertList(),
    sbAlertTap:     (title)              => sbAlertTap(title),
    // opts: string policy (legacy) | { policy?, all?, maxRounds? }
    sbAlertDismiss: (opts)               => sbAlertDismiss(opts == null ? {} : opts),
    sbAlertTrigger: (force)              => sbAlertTrigger(!!force),
};

send({ type: 'ready' });
