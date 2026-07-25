#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE (LMPlaybackModule, RCTEventEmitter)

RCT_EXTERN_METHOD(load : (NSString *)url)
RCT_EXTERN_METHOD(play : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(pause)
RCT_EXTERN_METHOD(seek : (double)seconds)
RCT_EXTERN_METHOD(setVolume : (double)volume)
RCT_EXTERN_METHOD(setMuted : (BOOL)muted)
RCT_EXTERN_METHOD(dispose)

RCT_EXTERN_METHOD(setNowPlayingInfo : (NSDictionary *)info)
RCT_EXTERN_METHOD(clearNowPlayingInfo)
RCT_EXTERN_METHOD(setRemoteCommandsEnabled : (BOOL)enabled)

@end
