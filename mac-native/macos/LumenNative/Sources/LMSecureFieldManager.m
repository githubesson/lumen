#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE (LMSecureFieldManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(value, NSString)
RCT_EXPORT_VIEW_PROPERTY(placeholder, NSString)
RCT_EXPORT_VIEW_PROPERTY(fontSize, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(textColor, UIColor)
RCT_EXPORT_VIEW_PROPERTY(editable, BOOL)

RCT_EXPORT_VIEW_PROPERTY(onChangeText, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onSubmit, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onFocusChange, RCTDirectEventBlock)

@end
