/**
 * ObjC 类与原生函数的懒加载与缓存。
 */
import ObjC from 'frida-objc-bridge';
import { CGFloat, CGPoint } from './constants.js';

let _api = null;

export function getApi() {
    if (_api !== null) return _api;

    const coreGraphics   = Process.getModuleByName('CoreGraphics');
    const coreFoundation = Process.getModuleByName('CoreFoundation');
    const foundation     = Process.getModuleByName('Foundation');
    const libSystem      = Process.getModuleByName('libSystem.B.dylib');

    _api = {
        CADisplayLink:     ObjC.classes.CADisplayLink,
        NSAutoreleasePool: ObjC.classes.NSAutoreleasePool,
        NSRunLoop:         ObjC.classes.NSRunLoop,
        UIApplication:     ObjC.classes.UIApplication,
        UITouch:           ObjC.classes.UITouch,
        NSString:          ObjC.classes.NSString,

        CGPointEqualToPoint: new NativeFunction(
            coreGraphics.getExportByName('CGPointEqualToPoint'),
            'uint8', [CGPoint, CGPoint]),
        CGPointZero: coreGraphics.getExportByName('CGPointZero').readPointer(),

        IOHIDEventCreateDigitizerFingerEvent: new NativeFunction(
            Module.getGlobalExportByName('IOHIDEventCreateDigitizerFingerEvent'),
            'pointer',
            [
                'pointer',
                ['uint32', 'uint32'],
                'uint32', 'uint32', 'uint32',
                CGFloat, CGFloat, CGFloat, CGFloat, CGFloat,
                'uint8', 'uint8',
                'uint32'
            ]),

        kCFAllocatorDefault:  coreFoundation.getExportByName('kCFAllocatorDefault').readPointer(),
        NSRunLoopCommonModes: foundation.getExportByName('NSRunLoopCommonModes').readPointer(),

        CFGetSystemUptime: new NativeFunction(
            coreFoundation.getExportByName('CFGetSystemUptime'), 'double', []),
        CFRelease: new NativeFunction(
            coreFoundation.getExportByName('CFRelease'), 'void', ['pointer']),
        mach_absolute_time: new NativeFunction(
            libSystem.getExportByName('mach_absolute_time'), 'uint64', []),
    };
    return _api;
}

/**
 * 取到当前"关键窗口"（优先 keyWindow，失败取第一个 window）。
 */
export function getKeyWindow() {
    const api = getApi();
    const app = api.UIApplication.sharedApplication();
    let window = app.keyWindow();
    if (window === null || window.handle.isNull()) {
        const wins = app.windows();
        if (wins && wins.count() > 0) {
            window = wins.objectAtIndex_(0);
        }
    }
    if (window === null || window.handle.isNull()) return null;
    return window;
}
