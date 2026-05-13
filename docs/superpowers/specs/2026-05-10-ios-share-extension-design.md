# iOS Share Extension — Design

- **Date:** 2026-05-10
- **Branch:** TBD (suggested: `ios-share-extension`)
- **Author:** Michele Mondora (with Claude)
- **Status:** Draft

## Problem

Today, sending a URL to SoundReel from an iPhone requires the user to:
1. Tap the system share sheet.
2. Pick "Telegram" (or another channel) from the picker.
3. Pick the SoundReel bot conversation.
4. Send the message.
5. Wait for the bot reply.

The user wants a single-tap path: open share sheet → tap "SoundReel" → done. No second-level picker, no chat detour. The single-user, no-auth backend already supports this if we add an iOS client.

## Goals

- Provide an iOS **Share Extension** that, when invoked from any app's share sheet (Safari, Instagram, TikTok, X, …), does exactly one thing: POST the shared URL to `https://soundreel.casamon.dev/api/analyze` and dismiss with a brief confirmation toast.
- Provide a minimal **main app** (mandatory by Apple — extensions cannot ship alone) that exposes a single "Open SoundReel" link plus a Settings screen for overriding the backend base URL and target display name.
- Support manual "favoriting" / pinning so the user can place SoundReel at the top of their share sheet.
- Stay single-user / no-auth (matches current backend posture).

## Non-Goals

- Journal / entry list / detail UI inside the iOS app (open the web app instead).
- Login flow, OAuth, multi-user, per-device tokens.
- Push notifications about analysis completion.
- iPad-specific layouts.
- Background sync / offline queue (best-effort fire-and-forget).
- App Store distribution path beyond personal TestFlight or Xcode sideload.

## Architecture

```
┌─────────────────── iOS device ────────────────────┐
│                                                    │
│  Any app (Safari, IG, TikTok, X, Mail, …)         │
│             │                                      │
│             ▼  user taps share, picks "SoundReel" │
│  ┌───────────────────────────────┐                │
│  │ SoundReelShare (App Extension)│                │
│  │ NSExtensionPointIdentifier =  │                │
│  │   com.apple.share-services    │                │
│  │ Reads URL from inputItems     │                │
│  │ POSTs to backend              │                │
│  │ Shows toast → dismiss         │                │
│  └───────────────────────────────┘                │
│                                                    │
│  ┌───────────────────────────────┐                │
│  │ SoundReel (Main App, blank)   │                │
│  │ - "Open soundreel.casamon.dev"│                │
│  │ - Settings: backend URL,      │                │
│  │   target name (display label) │                │
│  └───────────────────────────────┘                │
└────────────────────────────────────────────────────┘
                       │
                       ▼  HTTPS POST
                ┌──────────────────┐
                │  Backend Fastify │
                │  /api/analyze    │
                │  channel: 'ios'  │
                └──────────────────┘
```

The two iOS targets share a small Swift module (or a folder of `.swift` files added to both targets) for:
- `BackendClient.swift` — async POST to `/api/analyze`.
- `Settings.swift` — read/write backend URL via `App Group` `UserDefaults` (so both targets share the override).
- `URLExtractor.swift` — `NSItemProvider` → `URL` extraction for the share extension.

App Group: `group.<your-team>.soundreel` (configured under capabilities for both targets).

## Components

### Xcode project layout

```
ios/
├── SoundReel.xcodeproj
├── SoundReel/                       # main app target
│   ├── SoundReelApp.swift           # @main App entry
│   ├── ContentView.swift            # "Open soundreel.casamon.dev" + Settings link
│   ├── SettingsView.swift           # backend URL + target name editor
│   ├── Assets.xcassets              # app icon + accent color
│   └── Info.plist
├── SoundReelShare/                  # share extension target
│   ├── ShareViewController.swift    # principal class for the extension
│   ├── MainInterface.storyboard     # minimal storyboard required by template
│   └── Info.plist                   # NSExtension keys
├── SoundReelKit/                    # shared sources (added to BOTH targets)
│   ├── BackendClient.swift
│   ├── Settings.swift
│   └── URLExtractor.swift
└── SoundReel.xcconfig               # bundle ids, marketing version, deployment target
```

> The project lives in the existing repo under `ios/`. Backend / frontend / Docker tree is unaffected.

### Bundle identifiers

- Main app: `com.mmondora.soundreel`
- Share extension: `com.mmondora.soundreel.share`
- App group: `group.com.mmondora.soundreel`

(All three are placeholders — adjust to your Apple Developer Team prefix during project setup.)

### Deployment target

- iOS 17.0 minimum (covers iPhones from 2018 onward and gives us SwiftUI navigation, AsyncSequence, structured concurrency without back-deployment shims).

### Frameworks

- **SwiftUI** for both UI surfaces.
- **Foundation** `URLSession` for HTTPS.
- **UniformTypeIdentifiers** for `NSItemProvider` URL extraction.

No third-party dependencies. No CocoaPods, no SPM packages outside Apple frameworks.

### `BackendClient.swift`

```swift
import Foundation

public struct AnalyzeRequest: Codable {
    public let url: String
    public let channel: String   // "ios"
}

public struct AnalyzeResponse: Codable {
    public let success: Bool
    public let entryId: String?
    public let error: String?
}

public enum BackendError: Error {
    case invalidResponse(Int)
    case transport(Error)
    case decode(Error)
    case badUrl
}

public actor BackendClient {
    public init() {}

    public func analyze(url: String) async throws -> AnalyzeResponse {
        let base = Settings.shared.backendBaseUrl
        guard let endpoint = URL(string: "\(base.trimmedTrailingSlash)/api/analyze") else {
            throw BackendError.badUrl
        }
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        req.httpBody = try JSONEncoder().encode(AnalyzeRequest(url: url, channel: "ios"))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw BackendError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw BackendError.invalidResponse(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BackendError.invalidResponse(http.statusCode)
        }
        do {
            return try JSONDecoder().decode(AnalyzeResponse.self, from: data)
        } catch {
            throw BackendError.decode(error)
        }
    }
}
```

### `Settings.swift`

```swift
import Foundation

public final class Settings {
    public static let shared = Settings()

    private let defaults: UserDefaults
    private let appGroup = "group.com.mmondora.soundreel"

    private init() {
        defaults = UserDefaults(suiteName: "group.com.mmondora.soundreel") ?? .standard
    }

    public var backendBaseUrl: String {
        get { defaults.string(forKey: "backendBaseUrl") ?? "https://soundreel.casamon.dev" }
        set { defaults.set(newValue, forKey: "backendBaseUrl") }
    }

    public var targetDisplayName: String {
        get { defaults.string(forKey: "targetDisplayName") ?? "SoundReel" }
        set { defaults.set(newValue, forKey: "targetDisplayName") }
    }
}

public extension String {
    var trimmedTrailingSlash: String { hasSuffix("/") ? String(dropLast()) : self }
}
```

### `URLExtractor.swift`

```swift
import Foundation
import UniformTypeIdentifiers

public enum URLExtractor {
    public static func firstURL(from itemProviders: [NSItemProvider]) async -> URL? {
        for provider in itemProviders {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                if let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    return url
                }
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
                if let text = try? await provider.loadItem(forTypeIdentifier: UTType.text.identifier) as? String,
                   let url = extractFirstURL(in: text) {
                    return url
                }
            }
        }
        return nil
    }

    private static func extractFirstURL(in text: String) -> URL? {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..., in: text)
        return detector?.firstMatch(in: text, options: [], range: range).flatMap { $0.url }
    }
}
```

### `ShareViewController.swift`

```swift
import UIKit
import SwiftUI

final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = "Invio a \(Settings.shared.targetDisplayName)…"
        label.textAlignment = .center
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])

        Task { await processInput() }
    }

    private func processInput() async {
        guard let extensionItem = extensionContext?.inputItems.first as? NSExtensionItem else {
            return finish(success: false, message: "Nessun input")
        }
        guard let url = await URLExtractor.firstURL(from: extensionItem.attachments ?? []) else {
            return finish(success: false, message: "Nessun URL trovato")
        }

        do {
            let resp = try await BackendClient().analyze(url: url.absoluteString)
            if resp.success {
                finish(success: true, message: "Inviato ✓")
            } else {
                finish(success: false, message: resp.error ?? "Errore")
            }
        } catch {
            finish(success: false, message: "Errore di rete")
        }
    }

    private func finish(success: Bool, message: String) {
        DispatchQueue.main.async {
            // Optional: present a brief banner before dismissal.
            // Apple HIG recommends short share-sheet experiences (<2s).
            if let label = self.view.subviews.compactMap({ $0 as? UILabel }).first {
                label.text = message
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            }
        }
    }
}
```

The share extension's `Info.plist` MUST declare:

```xml
<key>NSExtension</key>
<dict>
    <key>NSExtensionAttributes</key>
    <dict>
        <key>NSExtensionActivationRule</key>
        <dict>
            <key>NSExtensionActivationSupportsWebURLWithMaxCount</key>
            <integer>1</integer>
        </dict>
    </dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.share-services</string>
    <key>NSExtensionPrincipalClass</key>
    <string>SoundReelShare.ShareViewController</string>
</dict>
```

This activation rule causes the extension to appear ONLY when the share sheet has a web URL — exactly what we want.

### Main app

`SoundReelApp.swift` is a 10-line SwiftUI shell:

```swift
import SwiftUI

@main
struct SoundReelApp: App {
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                ContentView()
            }
        }
    }
}
```

`ContentView.swift`:

```swift
import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 24) {
            Text("SoundReel")
                .font(.largeTitle).bold()
            Text("Usa il tasto Condividi su Safari, Instagram, TikTok ecc. e seleziona \(Settings.shared.targetDisplayName).")
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Link("Apri soundreel.casamon.dev",
                 destination: URL(string: Settings.shared.backendBaseUrl)!)
                .buttonStyle(.borderedProminent)
            NavigationLink("Impostazioni", destination: SettingsView())
        }
        .padding()
        .navigationTitle("SoundReel")
    }
}
```

`SettingsView.swift` is a simple form bound to `Settings.shared`.

## Backend changes

The only backend change is broadening the `channel` literal in the `Entry.inputChannel` union and the analyze route.

In `backend/src/types/index.ts`:

```ts
export interface Entry {
  // ...
  inputChannel: 'telegram' | 'web' | 'ios';
  // ...
}
```

In `backend/src/routes/analyze.ts`, the existing handler already accepts `channel?: 'web' | 'telegram'`. Widen to `'web' | 'telegram' | 'ios'`. No behavior change otherwise — the field is stored as-is on the entry and used only for filtering / labeling.

Optional UI badge: `frontend/src/components/EntryCard.tsx` `getChannelIcon` returns `'BOT'` for telegram and `'WEB'` otherwise; add a third branch returning `'iOS'` when `inputChannel === 'ios'`. (Cosmetic; can be done in the same backend commit.)

## Distribution

Two viable paths for a single-user personal app (no App Store):

1. **Free Apple ID provisioning (sideload)**: Xcode signs with a free Apple ID; the app expires after 7 days and must be re-signed/re-installed. Works only with a Mac and the device cabled / wirelessly paired.
2. **Apple Developer Program ($99/year) + TestFlight**: invite yourself as a TestFlight tester; up to 90 days per build, renewable. No 7-day re-sign cycle. Recommended.

Either way, the project file checks in cleanly to git; the user signs locally with their own team identifier.

## Manual verification checklist

After setting up the Xcode project and running on a real device:

1. Open Safari → any article → tap share → confirm "SoundReel" entry appears in the share sheet.
2. Tap "SoundReel" → see "Invio a SoundReel…" → see "Inviato ✓" → sheet dismisses within ~1 second.
3. Open `https://soundreel.casamon.dev` in Safari and confirm the new entry appears with `inputChannel: 'ios'`.
4. Repeat from Instagram (Reel share), TikTok, Threads, Mail (long-press a link), Twitter/X.
5. Test error path: enable airplane mode → share → confirm "Errore di rete" toast and graceful dismiss.
6. Open the main app → tap Settings → change backend URL to `http://192.168.x.x:8080` → return → share → confirm request goes to the local override.
7. Open Settings on iOS → SoundReel → confirm app group is properly registered.
8. Pin "SoundReel" as a favorite via the share sheet "Edit Actions" interface.

## Out of Scope (re-statement)

- Journal, settings beyond backend URL + display name, prompt editor, debug console.
- iPad layout, macOS Catalyst, watchOS.
- Push notifications, in-app entry list, share-extension preview of past entries.
- Per-user auth, OAuth, login flow, multi-tenant.
- App Store submission (no privacy manifest, screenshots, copy work in scope here).
- iOS share-channel "preferred app" pinning (this is a user setting, not app-controlled).

## Implementation order (informational; the implementation plan will refine)

1. Backend: widen `inputChannel` to include `'ios'` (1 type change + optional badge).
2. Xcode project scaffold: main app + share extension + shared sources, App Group capability.
3. `Settings.swift`, `BackendClient.swift`, `URLExtractor.swift`.
4. `ShareViewController.swift` with the toast UX.
5. `ContentView.swift`, `SettingsView.swift` for the main app.
6. Wire bundle identifiers, deployment target, capability entitlements.
7. Manual smoke against staging → production.

## Open questions to resolve before writing the plan

(None blocking — the user has answered the three brainstorm questions. The new app name remains TBD but does not gate implementation: ship as `SoundReel`, rebrand when chosen via a single Info.plist `CFBundleDisplayName` change.)
