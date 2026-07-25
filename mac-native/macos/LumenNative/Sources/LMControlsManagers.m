#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE (LMSearchFieldManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(value, NSString)
RCT_EXPORT_VIEW_PROPERTY(placeholder, NSString)
RCT_EXPORT_VIEW_PROPERTY(onSearchChange, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onSearchSubmit, RCTDirectEventBlock)

RCT_EXTERN_METHOD(focus : (nonnull NSNumber *)reactTag)

@end

@interface RCT_EXTERN_MODULE (LMSegmentedControlManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(labels, NSArray)
RCT_EXPORT_VIEW_PROPERTY(selectedIndex, NSInteger)
RCT_EXPORT_VIEW_PROPERTY(onSegmentChange, RCTDirectEventBlock)

@end

@interface RCT_EXTERN_MODULE (LMButtonManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(title, NSString)
RCT_EXPORT_VIEW_PROPERTY(buttonStyle, NSString)
RCT_EXPORT_VIEW_PROPERTY(enabled, BOOL)
RCT_EXPORT_VIEW_PROPERTY(symbolName, NSString)
RCT_EXPORT_VIEW_PROPERTY(onButtonPress, RCTDirectEventBlock)

@end
