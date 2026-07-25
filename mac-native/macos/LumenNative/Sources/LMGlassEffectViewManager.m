#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE (LMGlassEffectViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(cornerRadius, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(glassStyle, NSString)
RCT_EXPORT_VIEW_PROPERTY(tintColor, UIColor)

@end
