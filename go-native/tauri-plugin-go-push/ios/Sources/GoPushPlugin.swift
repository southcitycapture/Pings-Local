// go-push: APNs registration for the Pings Go! shell.
//
// Tauri's iOS glue (tao) declares its UIApplicationDelegate as a runtime
// ObjC class named "AppDelegate" that implements only launch/lifecycle
// selectors — nothing for remote notifications, and nothing claims
// UNUserNotificationCenter.delegate. So this plugin adds the two APNs
// delegate methods onto that class at runtime (a pure class_addMethod —
// the selectors are absent, no swizzle-swap needed; UIKit checks
// respondsToSelector at callback time) and takes the notification-center
// delegate for foreground/tap handling.

import SwiftRs
import Tauri
import UIKit
import UserNotifications
import WebKit

class SetBadgeArgs: Decodable {
  let count: Int?
}

// The plugin instance, reachable from the delegate IMPs below.
private weak var instance: GoPushPlugin?

class GoPushPlugin: Plugin, UNUserNotificationCenterDelegate {
  static var lastToken: String = ""

  @objc public override func load(webview: WKWebView) {
    instance = self
    installAppDelegateHooks()
    UNUserNotificationCenter.current().delegate = self
  }

  private func installAppDelegateHooks() {
    guard let delegate = UIApplication.shared.delegate,
      let cls = object_getClass(delegate)
    else {
      Logger.error("go-push: no app delegate to hook")
      return
    }

    let registered = #selector(
      UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:))
    if !class_respondsToSelector(cls, registered) {
      let imp: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { _, _, token in
        let hex = (token as Data).map { String(format: "%02x", $0) }.joined()
        GoPushPlugin.lastToken = hex
        instance?.trigger("pushToken", data: ["token": hex])
      }
      class_addMethod(cls, registered, imp_implementationWithBlock(imp), "v@:@@")
    }

    let failed = #selector(
      UIApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:))
    if !class_respondsToSelector(cls, failed) {
      let imp: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, error in
        Logger.error("go-push: registration failed: \(error.localizedDescription)")
        instance?.trigger("pushError", data: ["message": error.localizedDescription])
      }
      class_addMethod(cls, failed, imp_implementationWithBlock(imp), "v@:@@")
    }
  }

  @objc public func requestPush(_ invoke: Invoke) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) {
      granted, _ in
      DispatchQueue.main.async {
        if granted {
          UIApplication.shared.registerForRemoteNotifications()
        }
        invoke.resolve(["granted": granted])
      }
    }
  }

  @objc public func getToken(_ invoke: Invoke) {
    invoke.resolve(["token": GoPushPlugin.lastToken])
  }

  @objc public func setBadge(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetBadgeArgs.self)
    let count = args.count ?? 0
    DispatchQueue.main.async {
      if #available(iOS 16.0, *) {
        UNUserNotificationCenter.current().setBadgeCount(count)
      } else {
        UIApplication.shared.applicationIconBadgeNumber = count
      }
    }
    invoke.resolve()
  }

  // Foregrounded: suppress the system banner — the in-app flash owns
  // attention while the app is visible.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([])
  }

  // A tap on a notification launched/foregrounded us — let JS route.
  // The server puts the sender's peer id in the payload so the app can
  // open the right thread.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let content = response.notification.request.content
    var data: JSObject = ["title": content.title, "body": content.body]
    if let from = content.userInfo["fromPeerId"] as? String {
      data["fromPeerId"] = from
    }
    trigger("pushTap", data: data)
    completionHandler()
  }
}

@_cdecl("init_plugin_go_push")
func initPlugin() -> Plugin {
  return GoPushPlugin()
}
