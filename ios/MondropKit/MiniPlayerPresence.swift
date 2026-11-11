// MiniPlayerPresence.swift — when the mini player is there (Michele, 11 November, trying build 16: «Il mini player non deve essere visibile se non ci sono cose in
// play.»; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U13).
//
// Pure. «In play» is what the player says (`LocalAudioPlayer.inPlay`): something was started in this run — or queued from Cerca — and it has not ended. A queue the
// phone brings back paused at launch is not in play: it is waiting on the first page as «Riprendi», and it does not put a bar over every other page.

import Foundation

public enum MiniPlayerPresence {
    public static func isShown(title: String, inPlay: Bool) -> Bool {
        inPlay && !title.isEmpty
    }
}

extension MiniPlayerPresence {
    /// Where the file of the song in play is, as one of the three marks every list shows (Michele, 11 November: «Non è chiaro dove sono i file ( locali o remoto )»):
    /// nil while nothing was started, on the phone when the player reads the file it holds, online while it streams from SoundReel or waits for it to prepare the song,
    /// error when it could not play it.
    public static func location(of status: PlaybackStatus) -> SongState? {
        switch status {
        case .idle: return nil
        case .local: return .local
        case .streaming, .preparing: return .online(percent: nil)
        case .failed(let message): return .error(message)
        }
    }
}
