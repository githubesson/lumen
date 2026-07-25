#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE (LMVisualEffectViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(materialName, NSString)
RCT_EXPORT_VIEW_PROPERTY(blendingModeName, NSString)
RCT_EXPORT_VIEW_PROPERTY(cornerRadius, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(alwaysActive, BOOL)
RCT_EXPORT_VIEW_PROPERTY(fadeBottom, CGFloat)

@end
