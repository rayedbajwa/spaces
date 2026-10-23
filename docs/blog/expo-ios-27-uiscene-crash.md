---
title: "Your Expo App Crashes on iOS 27 at Launch: The UIScene Fix"
description: iOS 27 enforces the UIScene life cycle and crashes apps that still start from the app delegate. Here's the crash signature, why Expo apps hit it, and a 40-line config plugin that fixes it.
date: 2026-10-28
image: /media/ios27-taasq-running.png
---

### iOS 27 now enforces the scene-based life cycle with a deliberate crash. If your Expo app opens fine on iOS 26 and dies instantly on iOS 27, this is probably why.

A tester sent four identical crash reports for a React Native app built with Expo. The app crashed **0.7 seconds after launch**, every time, but only on their phone. Ours were fine.

The difference turned out to be the operating system: their phone was on **iOS 27**.

## The signature

```
Exception Type:  EXC_BREAKPOINT (SIGTRAP)
Thread 0 Crashed:
0  UIKitCore   ___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke + 700
3  UIKitCore   -[UIApplication workspace:didCreateScene:withTransitionContext:completion:]
…
26 TaasQ       static AppDelegate.$main()
```

`EXC_BREAKPOINT` in UIKit isn't a bug in your code. It's an assertion, and the function name says exactly what it's asserting: **no scene life-cycle adoption.**

Apple has been warning since iOS 13 that apps should adopt `UIScene`, the life cycle where windows belong to scenes rather than to the app delegate. iOS 27 stopped warning. An app built the old way, creating its `UIWindow` in `application(_:didFinishLaunchingWithOptions:)`, now asserts at launch.

## Why Expo apps hit it

If you use Continuous Native Generation (no committed `ios/` folder), your `AppDelegate.swift` comes from Expo's prebuild template. In our version (Expo SDK 57), that template still does this:

```swift
window = UIWindow(frame: UIScreen.main.bounds)
factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
```

That's the app-delegate life cycle. And there's no scene configuration in `Info.plist`.

The good news: Expo 57 already ships the other half. `ExpoAppSceneDelegate` is a `UIWindowSceneDelegate` whose own documentation says it's *"required by the iOS 27, which asserts at launch unless the app adopts the scene-based life cycle."* It creates the window from the connecting scene, starts React Native into it, and forwards URL and user-activity events. Nothing in the template turns it on yet.

## The fix: a small config plugin

Three changes, all through a config plugin so they survive every `expo prebuild`:

**1. Declare a scene in `Info.plist`** that uses Expo's delegate. Its Objective-C name is fixed (`EXExpoAppSceneDelegate`), so no Swift file is needed:

```js
cfg.modResults.UIApplicationSceneManifest = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'EXExpoAppSceneDelegate' },
    ],
  },
}
```

**2. Make the app delegate provide the React Native factory** to the scene delegate, by conforming to `ExpoReactNativeFactoryProvider`. The template already has the `window` and `reactNativeFactory` properties the protocol needs.

**3. Stop the app delegate from creating the window and starting React Native.** The scene delegate does both now. Keep everything else, including `FirebaseApp.configure()` and your URL handlers:

```js
out = out.replace(/class AppDelegate: ExpoAppDelegate\b/, 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider')
out = out.replace(/^\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*\n/m, '\n')
out = out.replace(/^\s*factory\.startReactNative\(\s*withModuleName: "main",\s*in: window,\s*launchOptions: launchOptions\)\s*\n/m, '\n')
if (/factory\.startReactNative\(/.test(out)) throw new Error('template changed')
```

That last line matters. Regex-editing generated code is fragile, so **if the template ever stops matching, the plugin fails the build** instead of shipping an app that crashes. A unit test covers the transform, running it twice, and a changed template.

## Verifying it

We built a Release configuration and ran it on an **iOS 27.0 simulator** (iPhone 18 Pro). The unfixed build died within a second; the fixed one launched, stayed running and drew the onboarding screen:

![The app running on the iOS 27 simulator after the fix](/media/ios27-taasq-running.png)

Two things to know when you ship it:

- **It's native code.** An over-the-air update can't deliver it. You need a new store build.
- **If you use EAS's fingerprint runtime policy,** build from a clean `node_modules`. Our first cloud build failed on a fingerprint mismatch because the local test build had written files into a dependency's folder. A fresh `npm ci` made the fingerprints match.

## Checklist

- [ ] Crash reports show `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` on iOS 27
- [ ] Add a scene manifest pointing at `EXExpoAppSceneDelegate`
- [ ] AppDelegate conforms to `ExpoReactNativeFactoryProvider` and no longer creates the window
- [ ] Prebuild, build, launch on an iOS 27 simulator
- [ ] Ship a new binary

*We found this while shipping a mobile app with Spaces, an AI software factory that turns tickets into reviewed, tested pull requests. It's [on GitHub](https://github.com/rayedbajwa/spaces).*
