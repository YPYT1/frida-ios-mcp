/**
 * 弹窗检测（中间 modal / alert / sheet）。
 * 实际检测逻辑在 shared_js/view_tree.js 里；本文件只做 RPC 薄封装，保持"一个动作一个目录"。
 */
import { dumpModalView as _dump } from '../shared_js/view_tree.js';

export function dumpModalView() {
    return _dump();
}
