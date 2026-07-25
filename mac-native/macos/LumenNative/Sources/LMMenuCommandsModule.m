#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE (LMMenuCommandsModule, RCTEventEmitter)

RCT_EXTERN_METHOD(setPlaybackState : (NSDictionary *)state)

@end
