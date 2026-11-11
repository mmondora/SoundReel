// SizeQuestionPresenter.swift — the question «Da scaricare 3,4 GB (812 brani)» of a sync that the person started on a page (the «Scarica tutta» of a playlist, spec
// 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md §12, U20): the sync asks, the page puts the question on the display, the answer goes back. The same
// waiting as the playing sync and the check of the Settings do inside themselves, for a screen that has no such object of its own.

import Foundation

@MainActor
public final class SizeQuestionPresenter: ObservableObject {
    /// The question that is on screen, if any.
    @Published public private(set) var question: SyncSizeQuestion?

    private var pending: CheckedContinuation<SyncSizeChoice?, Never>?

    public init() {}

    /// Puts the question on the display and waits for the answer; nil when it was withdrawn, or when another question was already waiting (one at a time).
    public func ask(_ question: SyncSizeQuestion) async -> SyncSizeChoice? {
        guard pending == nil else { return nil }
        self.question = question
        return await withCheckedContinuation { (continuation: CheckedContinuation<SyncSizeChoice?, Never>) in
            pending = continuation
        }
    }

    /// The person's answer. Only the first counts; one that arrives when nothing is asked is ignored.
    public func answer(_ choice: SyncSizeChoice) {
        guard let waiting = pending else { return }
        pending = nil
        question = nil
        waiting.resume(returning: choice)
    }

    /// The question is not needed any more (the page was left): it goes away without an answer.
    public func withdraw() {
        guard let waiting = pending else { return }
        pending = nil
        question = nil
        waiting.resume(returning: nil)
    }
}
