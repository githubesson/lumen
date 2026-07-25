#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE (LMTrackTableManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(rowData, NSDictionary)
RCT_EXPORT_VIEW_PROPERTY(nowPlayingId, NSString)
RCT_EXPORT_VIEW_PROPERTY(rowHeight, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(topInset, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(bottomInset, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(accentColor, UIColor)

RCT_EXPORT_VIEW_PROPERTY(onRowActivated, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onRowContextMenu, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onEndReached, RCTDirectEventBlock)

RCT_EXTERN_METHOD(setFavorite
                  : (nonnull NSNumber *)reactTag id
                  : (NSString *)id isFavorite
                  : (BOOL)isFavorite)

@end
