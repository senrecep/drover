// simd bridging header: the few CoreSimulator / SimulatorKit methods the helper calls, declared
// from the runtime's own class metadata (Xcode 27). Clean-room; see NOTICE.
//
// Every private call goes through a helper below that checks respondsToSelector: and catches
// Objective-C exceptions, so a CoreSimulator that changed shape reads as "unsupported" (nil / NO
// with *unsupported set) instead of crashing the server.
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurfaceObjC.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdlib.h>

@protocol SimDisplayIOSurfaceRenderable
- (void)registerCallbackWithUUID:(NSUUID *)uuid ioSurfacesChangeCallback:(void (^)(IOSurface *fb, IOSurface *masked))cb;
- (void)unregisterIOSurfacesChangeCallbackWithUUID:(NSUUID *)uuid;
@property (readonly) IOSurface *framebufferSurface;
@end

@protocol SimDisplayRenderable
- (void)registerCallbackWithUUID:(NSUUID *)uuid damageRectanglesCallback:(void (^)(NSArray *rects))cb;
- (void)unregisterDamageRectanglesCallbackWithUUID:(NSUUID *)uuid;
@end

@interface NSObject (SimdPrivate)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)err;
- (id)defaultDeviceSetWithError:(NSError **)err;
- (NSDictionary *)devicesByUDID;
- (id)io;
- (NSArray *)ioPorts;
- (id)descriptor;
- (id)state;
- (unsigned short)displayClass;
- (id)initWithDevice:(id)device error:(NSError **)err;
- (void)sendWithMessage:(void *)msg freeWhenDone:(BOOL)free completionQueue:(dispatch_queue_t)q completion:(void (^)(NSError *))cb;
@end

/// The booted-or-not device for `udid`; nil when it isn't there. *unsupported is set when
/// CoreSimulator doesn't have the calls this helper needs.
static inline id SimdLookupDevice(NSString *devDir, NSUUID *udid, BOOL *unsupported) {
  *unsupported = NO;
  @try {
    NSError *e = nil;
    Class cls = NSClassFromString(@"SimServiceContext");
    if (!cls || ![cls respondsToSelector:@selector(sharedServiceContextForDeveloperDir:error:)]) { *unsupported = YES; return nil; }
    id ctx = [cls sharedServiceContextForDeveloperDir:devDir error:&e];
    if (!ctx) return nil;
    if (![ctx respondsToSelector:@selector(defaultDeviceSetWithError:)]) { *unsupported = YES; return nil; }
    id set = [ctx defaultDeviceSetWithError:&e];
    if (!set) return nil;
    if (![set respondsToSelector:@selector(devicesByUDID)]) { *unsupported = YES; return nil; }
    NSDictionary *all = [set devicesByUDID];
    if (![all isKindOfClass:[NSDictionary class]]) { *unsupported = YES; return nil; }
    return all[udid];
  } @catch (NSException *x) { *unsupported = YES; return nil; }
}

/// The device's main screen (display class 0); nil while it has none yet.
static inline id SimdMainDisplay(id device, BOOL *unsupported) {
  *unsupported = NO;
  @try {
    if (![device respondsToSelector:@selector(io)]) { *unsupported = YES; return nil; }
    id io = [(NSObject *)device io];
    if (!io) return nil;
    if (![io respondsToSelector:@selector(ioPorts)]) { *unsupported = YES; return nil; }
    id ports = [(NSObject *)io ioPorts];
    if (![ports isKindOfClass:[NSArray class]]) return nil;
    for (id p in (NSArray *)ports) {
      if (![p respondsToSelector:@selector(descriptor)]) continue;
      id d = [(NSObject *)p descriptor];
      if (![d respondsToSelector:@selector(framebufferSurface)] || ![d respondsToSelector:@selector(state)]) continue;
      if (![d respondsToSelector:@selector(registerCallbackWithUUID:ioSurfacesChangeCallback:)]
          || ![d respondsToSelector:@selector(registerCallbackWithUUID:damageRectanglesCallback:)]) continue;
      id st = [(NSObject *)d state];
      if (![st respondsToSelector:@selector(displayClass)]) continue;
      if ([(NSObject *)st displayClass] == 0) return d;
    }
    return nil;
  } @catch (NSException *x) { *unsupported = YES; return nil; }
}

static inline IOSurface *SimdFramebuffer(id display) {
  @try {
    if (![display respondsToSelector:@selector(framebufferSurface)]) return nil;
    id s = [(id<SimDisplayIOSurfaceRenderable>)display framebufferSurface];
    return [s isKindOfClass:[IOSurface class]] ? s : nil;
  } @catch (NSException *x) { return nil; }
}

/// Screen changes: a new framebuffer surface (`surface`, may be nil) or damaged areas (`damage`).
static inline BOOL SimdRegister(id display, NSUUID *uuid, void (^surface)(IOSurface *fb), void (^damage)(void)) {
  @try {
    [(id<SimDisplayIOSurfaceRenderable>)display registerCallbackWithUUID:uuid ioSurfacesChangeCallback:^(IOSurface *fb, IOSurface *masked) {
      surface([fb isKindOfClass:[IOSurface class]] ? fb : nil);
    }];
    [(id<SimDisplayRenderable>)display registerCallbackWithUUID:uuid damageRectanglesCallback:^(NSArray *rects) { damage(); }];
    return YES;
  } @catch (NSException *x) { return NO; }
}

static inline void SimdUnregister(id display, NSUUID *uuid) {
  @try {
    if ([display respondsToSelector:@selector(unregisterDamageRectanglesCallbackWithUUID:)])
      [(id<SimDisplayRenderable>)display unregisterDamageRectanglesCallbackWithUUID:uuid];
    if ([display respondsToSelector:@selector(unregisterIOSurfacesChangeCallbackWithUUID:)])
      [(id<SimDisplayIOSurfaceRenderable>)display unregisterIOSurfacesChangeCallbackWithUUID:uuid];
  } @catch (NSException *x) { }
}

static inline id SimdMakeHIDClient(id device) {
  @try {
    NSError *e = nil;
    Class cls = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
    if (!cls || ![cls instancesRespondToSelector:@selector(initWithDevice:error:)]
        || ![cls instancesRespondToSelector:@selector(sendWithMessage:freeWhenDone:completionQueue:completion:)]) return nil;
    return [[cls alloc] initWithDevice:device error:&e];
  } @catch (NSException *x) { return nil; }
}

/// Sends one HID message (freed once taken); `done` runs when it was taken or couldn't be sent.
static inline void SimdSend(id hid, void *msg, dispatch_queue_t q, void (^done)(void)) {
  @try {
    [(NSObject *)hid sendWithMessage:msg freeWhenDone:YES completionQueue:q completion:^(NSError *e) { done(); }];
  } @catch (NSException *x) {
    free(msg);
    dispatch_async(q, done);
  }
}

// The device's state as a number (3: booted), or -1 when it can't be read.
static inline long SimdDeviceState(id device) {
  @try {
    id v = [device valueForKey:@"state"];
    return [v respondsToSelector:@selector(longValue)] ? [v longValue] : -1;
  } @catch (NSException *e) { return -1; }
}
