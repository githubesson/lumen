#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (LMContextMenuModule, NSObject)

RCT_EXTERN_METHOD(show
                  : (NSArray *)items position
                  : (NSDictionary *)position resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

@end
