#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  self.moduleName = @"LumenMac";
  self.initialProps = @{};
  self.dependencyProvider = [RCTAppDependencyProvider new];

  // Cover art is fetched by RN's <Image>, which goes through NSURLSession and
  // therefore the shared cache. The 4 MB memory default thrashes on a grid of
  // album art, so give it room to keep a browsing session resident.
  [NSURLCache setSharedURLCache:[[NSURLCache alloc] initWithMemoryCapacity:50 * 1024 * 1024
                                                             diskCapacity:500 * 1024 * 1024
                                                                 diskPath:nil]];

  [super applicationDidFinishLaunching:notification];

  [self configureMainWindow];
}

/// RCTAppDelegate creates the window and restores its saved frame; this adds the
/// chrome that makes it read as a Mac app — a full-height sidebar running under
/// a transparent titlebar, with the traffic lights floating over it.
- (void)configureMainWindow
{
  NSWindow *window = self.window;
  if (window == nil) {
    return;
  }

  window.titlebarAppearsTransparent = YES;
  window.titleVisibility = NSWindowTitleHidden;
  window.styleMask |= NSWindowStyleMaskFullSizeContentView;
  window.minSize = NSMakeSize(960, 620);

  // A restored frame can be smaller than the current minimum; grow it back so
  // the first launch after a min-size change is not clipped.
  NSRect frame = window.frame;
  if (frame.size.width < window.minSize.width || frame.size.height < window.minSize.height) {
    frame.size.width = MAX(frame.size.width, window.minSize.width);
    frame.size.height = MAX(frame.size.height, window.minSize.height);
    [window setFrame:frame display:YES];
  }
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender
{
  return YES;
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
