/**
 * 触摸 / HID 事件相关的常量定义（被 touch_injector 和各 action js 共享）。
 */

// UITouch phase
export const UITouchPhaseBegan      = 0;
export const UITouchPhaseMoved      = 1;
export const UITouchPhaseStationary = 2;
export const UITouchPhaseEnded      = 3;

// UITouch flag
export const UITOUCH_FLAG_IS_FIRST_TOUCH_FOR_VIEW = 1;
export const UITOUCH_FLAG_IS_TAP                  = 2;

// CoreGraphics 浮点类型（32 位用 float，64 位用 double）
export const CGFloat = (Process.pointerSize === 4) ? 'float' : 'double';
export const CGPoint = [CGFloat, CGFloat];

// IOHIDEvent 事件掩码
export const kIOHIDDigitizerEventRange    = 0x00000001;
export const kIOHIDDigitizerEventTouch    = 0x00000002;
export const kIOHIDDigitizerEventPosition = 0x00000004;
