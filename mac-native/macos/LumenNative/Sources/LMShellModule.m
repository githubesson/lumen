#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE (LMShellModule, RCTEventEmitter)

RCT_EXTERN_METHOD(setSidebar : (NSArray *)sections selectedId : (NSString *)selectedId)
RCT_EXTERN_METHOD(setSelectedItem : (NSString *)id)
RCT_EXTERN_METHOD(toggleSidebar)
RCT_EXTERN_METHOD(setToolbar : (NSDictionary *)config)
RCT_EXTERN_METHOD(focusSearch)
RCT_EXTERN_METHOD(setAppearance : (NSString *)scheme)
RCT_EXTERN_METHOD(setImmersive : (BOOL)immersive)
RCT_EXTERN_METHOD(confirmDialog : (NSDictionary *)options
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(alertDialog : (NSDictionary *)options
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(saveDownload : (NSString *)url
                  suggestedName : (NSString *)suggestedName
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

@end
