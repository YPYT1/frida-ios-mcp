/**
 * 三阶贝塞尔曲线路径生成器，用于模拟真人手指滑动轨迹。
 *
 * 控制点在起点与终点连线上取 0.3 / 0.7 处，各自叠加 ±offsetRatio*距离 的随机偏移；
 * 采样点数量随 duration 变化（60fps 近似）。每个采样点还会叠加 ±0.6px 亚像素抖动。
 */

function bezier3(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    return [
        b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0],
        b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1],
    ];
}

/**
 * 构造从 (x0,y0) 到 (x1,y1) 的贝塞尔采样路径。
 *
 * @param {number} x0 起点 x
 * @param {number} y0 起点 y
 * @param {number} x1 终点 x
 * @param {number} y1 终点 y
 * @param {number} steps 采样点数量（含首尾）
 * @param {number} offsetRatio 控制点偏移比例，默认 0.08
 * @returns {Array<[number, number]>}
 */
export function bezierPath(x0, y0, x1, y1, steps, offsetRatio = 0.08) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    // 用垂直于主方向的单位向量 + 主方向的 0.3/0.7 位置做控制点
    const nx = -dy / len;
    const ny =  dx / len;

    const c1 = [
        x0 + dx * 0.3 + nx * (Math.random() - 0.5) * 2 * len * offsetRatio,
        y0 + dy * 0.3 + ny * (Math.random() - 0.5) * 2 * len * offsetRatio,
    ];
    const c2 = [
        x0 + dx * 0.7 + nx * (Math.random() - 0.5) * 2 * len * offsetRatio,
        y0 + dy * 0.7 + ny * (Math.random() - 0.5) * 2 * len * offsetRatio,
    ];

    const path = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // ease-out：快速启动 + 末端保持速度，确保 UIScrollView 识别为翻页手势
        const e = 1 - Math.pow(1 - t, 2);
        const p = bezier3([x0, y0], c1, c2, [x1, y1], e);
        // 亚像素抖动
        const jx = (Math.random() - 0.5) * 1.2;
        const jy = (Math.random() - 0.5) * 1.2;
        path.push([p[0] + jx, p[1] + jy]);
    }
    return path;
}
