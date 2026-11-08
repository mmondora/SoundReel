// ShareOutcome.swift — what the sheet says after «Invia a SoundReel» (spec SH3): one clear line built from the server's
// answer, the extra lines that matter (who it was shared with, what could not be done), and the reasons of a failure.
// Pure, so every sentence is tested.

import Foundation

public struct ShareOutcome: Equatable, Sendable {
    /// The one line: «Brano aggiunto a Road trip», «Link in analisi, ti avviso».
    public let headline: String
    /// Quiet lines under it: the song, «Condiviso con archi e sara».
    public let details: [String]
    /// Things the user asked for that could not be done (the link is saved all the same).
    public let warnings: [String]

    /// How long the success state stays before the sheet closes: long enough to read, longer when something needs reading.
    public var closeDelay: TimeInterval { warnings.isEmpty ? 1.2 : 3.0 }

    public init(headline: String, details: [String] = [], warnings: [String] = []) {
        self.headline = headline
        self.details = details
        self.warnings = warnings
    }
}

public enum ShareOutcomeText {
    /// kinds the server knows as a song at once (no analysis to wait for)
    private static let songKinds: Set<String> = ["spotify", "shazam"]

    /// The state after a share the server accepted (`success: true`).
    public static func success(_ r: ShareResponse) -> ShareOutcome {
        let isSong = r.kind.map { songKinds.contains($0.lowercased()) } ?? false
        var headline: String
        if isSong {
            headline = "Brano salvato su SoundReel"
        } else if r.status?.lowercased() == "completed" {
            headline = "Link salvato su SoundReel"
        } else {
            headline = "Link in analisi, ti avviso"
        }

        var warnings: [String] = []
        switch r.playlist {
        case .added(_, let name, let count)?:
            if count == 1 {
                headline = "Brano aggiunto a \(name)"
            } else if count > 1 {
                headline = "\(count) brani aggiunti a \(name)"
            } else {
                headline = "Già in \(name)"
            }
        case .pending(_, let name)?:
            headline = "Link in analisi: i brani andranno in \(name), ti avviso"
        case .invalid(_, let problem)?:
            warnings.append("Playlist non usata (\(describe(problem))): il link è in libreria")
        case nil:
            break
        }

        var details: [String] = []
        if let title = r.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            let artist = r.artist?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            details.append(artist.isEmpty ? title : "\(title) — \(artist)")
        }
        if !r.sharedWith.isEmpty {
            details.append("Condiviso con \(names(r.sharedWith))")
        }
        for rejection in r.rejected {
            warnings.append("Non condiviso con \(rejection.user): \(describe(rejectionReason: rejection.reason))")
        }
        return ShareOutcome(headline: headline, details: details, warnings: warnings)
    }

    /// «archi», «archi e sara», «mike, archi e sara».
    static func names(_ users: [String]) -> String {
        switch users.count {
        case 0: return ""
        case 1: return users[0]
        default: return users.dropLast().joined(separator: ", ") + " e " + users[users.count - 1]
        }
    }

    static func describe(_ problem: SharePlaylistProblem) -> String {
        switch problem {
        case .notFound: return "non esiste più"
        case .dynamic: return "è dinamica: la regola decide i brani"
        case .readOnly: return "è in sola lettura"
        case .other(let text): return text.isEmpty ? "non valida" : text
        }
    }

    static func describe(rejectionReason reason: String) -> String {
        switch reason.lowercased() {
        case "self": return "sei tu"
        case "unknown_user": return "utente sconosciuto"
        // the key is not bound to a user, so the server has no sender to show the entry from
        case "sender_unknown": return "la tua chiave non è legata a un utente"
        case "": return "non accettato"
        default: return reason
        }
    }

    // MARK: failures

    /// The server answered 200 with `success: false` (e.g. a Shazam page that could not be read): its reason, as is.
    public static func failure(for r: ShareResponse) -> String {
        let reason = r.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return reason.isEmpty ? "Il server non ha accettato il link" : reason
    }

    /// The call itself failed.
    public static func failure(for error: Error) -> String {
        guard let backend = error as? BackendError else { return "Errore: \(error.localizedDescription)" }
        switch backend {
        case .http(401, _), .http(403, _):
            return "API key non valida: rinnovala in Mondrop → Impostazioni"
        case .http(400, _):
            return "Il server non accetta questo link"
        case .http(let code, _) where code >= 500:
            return "Il server SoundReel ha avuto un problema (HTTP \(code)): riprova tra poco"
        case .transport:
            return "Server non raggiungibile: controlla la connessione e riprova"
        case .decode:
            return "Risposta del server non leggibile: riprova (rimandare lo stesso link non crea doppioni)"
        case .http, .badUrl, .missingApiKey, .missingUser:
            return backend.description
        }
    }
}
