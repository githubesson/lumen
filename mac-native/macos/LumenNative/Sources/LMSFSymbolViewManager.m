#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE (LMSFSymbolViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(symbolName, NSString)
RCT_EXPORT_VIEW_PROPERTY(pointSize, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(weightName, NSString)
RCT_EXPORT_VIEW_PROPERTY(tintColor, UIColor)

@end
