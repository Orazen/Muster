import Foundation
import UserNotifications
import CompanionCore

/// The on-device notification surface. Delivery comes from live or replayed
/// companion frames; a future APNs relay can feed the same categories and
/// userInfo without changing the rest of the app.
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()
    private let center = UNUserNotificationCenter.current()

    private override init() {
        super.init()
        center.delegate = self
    }

    /// A tap on a banner — the body or its one action — should land the user
    /// in the conversation that produced it, not on the top of the roster.
    /// The Session installs this at launch; it is a closure rather than a
    /// reference because the coordinator outlives every session (it is a
    /// process singleton) and must never keep one alive.
    var onOpenThread: ((String) -> Void)?

    /// The categories the delivered notifications name. Without this call the
    /// `categoryIdentifier` on the content selects nothing and the banner is a
    /// dead tap — which is exactly the bug this closes. Approval banners get a
    /// "Review" action that opens the conversation; the lease discipline in
    /// `ApprovalActionCoordinator` means the actual Approve/Deny still happens
    /// there, on a card the user has looked at, not blind from the lock screen.
    func registerCategories() {
        let review = UNNotificationAction(
            identifier: "MUSTER_REVIEW", title: "Review", options: [.foreground]
        )
        let open = UNNotificationAction(
            identifier: "MUSTER_OPEN", title: "Open", options: [.foreground]
        )
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: "MUSTER_APPROVAL", actions: [review],
                intentIdentifiers: [], options: []
            ),
            UNNotificationCategory(
                identifier: "MUSTER_UPDATE", actions: [open],
                intentIdentifiers: [], options: []
            ),
        ])
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
    }

    func deliver(_ notification: NotificationFrame, sequence: Int?) {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        content.categoryIdentifier = notification.isBlocking ? "MUSTER_APPROVAL" : "MUSTER_UPDATE"
        content.threadIdentifier = notification.threadId
        content.userInfo = [
            "threadId": notification.threadId,
            "botId": notification.botId,
            "kind": notification.kind,
        ]
        if notification.isBlocking { content.interruptionLevel = .timeSensitive }

        // A replay after a short disconnect must reconcile a missed alert,
        // but a repeated frame must not draw it twice.
        let identifier = "muster.\(notification.threadId).\(sequence.map(String.init) ?? notification.title)"
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    func setBadge(_ count: Int) {
        center.setBadgeCount(max(0, count))
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Both the body tap and the action carry the thread the alert came
        // from; route whichever the user chose to that conversation.
        if let threadId = response.notification.request.content.userInfo["threadId"] as? String {
            onOpenThread?(threadId)
        }
        completionHandler()
    }
}
