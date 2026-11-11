// MiniPlayerScrollRule.swift — when the mini player tucks away (Michele, 11 November, trying build 16: «E comunque non deve sovrapporre le cose sotto, oppure deve sparire/
// nascondersi se navigo.»; spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U13).
//
// Pure: the offset of the page the user is scrolling goes in, whether the bar is hidden comes out. Scrolling DOWN (the content moves up) hides it once the user has gone a
// little way; scrolling back UP brings it back, and so does the top of the page. A tremor of the finger, or the bounce at the end of a list, changes nothing: the
// distances are measured from where the direction last changed.

import Foundation

public struct MiniPlayerScrollRule: Equatable, Sendable {
    /// Points scrolled down, from where the movement began, after which the bar tucks away.
    public static let hideAfter = 40.0
    /// Points scrolled back up after which it returns.
    public static let showAfter = 16.0
    /// Within this distance of the top of the page the bar is always shown.
    public static let topZone = 8.0

    public private(set) var hidden = false
    private var last = 0.0
    private var anchor = 0.0
    private var movingDown = true

    public init() {}

    /// The page is now scrolled to `offset` points from its top (0 at the top, growing as the user scrolls down).
    public mutating func scrolled(to offset: Double) {
        guard offset > Self.topZone else {
            self = MiniPlayerScrollRule()
            last = offset
            return
        }
        if offset != last {
            let down = offset > last
            if down != movingDown {
                movingDown = down
                anchor = last                      // the direction changed: measure from here
            }
        }
        if movingDown {
            if offset - anchor >= Self.hideAfter { hidden = true }
        } else if anchor - offset >= Self.showAfter {
            hidden = false
        }
        last = offset
    }

    /// A new page: the bar is back.
    public mutating func reset() { self = MiniPlayerScrollRule() }
}
