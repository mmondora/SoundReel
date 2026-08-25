import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Structural tests, in the same spirit as analyze.transcribe.test.ts: the
 * analyze route is too tangled to exercise end to end here, but the properties
 * that matter most about the second pass are pinnable at the source level, and
 * they are exactly the kind a refactor would silently undo.
 *
 * The hard prohibition is that a second pass reaches no external service. It
 * will eventually run over hundreds of archived Instagram posts: re-fetching
 * them is what gets the account banned, and re-scanning them is what gets an
 * unofficial endpoint to notice.
 */
describe('analyze route second pass', () => {
  const source = readFileSync(path.join(__dirname, 'analyze.ts'), 'utf8');

  /**
   * Comments are dropped before every guard scan below. Each guarded call site
   * carries a comment explaining its guard, and counting that prose as the
   * guard would make these tests pass on code with the guard deleted — the one
   * thing they exist to catch.
   */
  function codeOnly(text: string): string {
    return text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  }

  /** Occurrences of `needle`, as indices into the source. */
  function sites(needle: string): number[] {
    const out: number[] = [];
    for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) out.push(i);
    return out;
  }

  describe('never downloads', () => {
    it('calls extractContent from exactly one place', () => {
      expect(sites('await extractContent(')).toHaveLength(1);
    });

    it('reaches that call only through the non-reanalyse branch', () => {
      const before = source.slice(0, sites('await extractContent(')[0]);
      const guardAt = before.lastIndexOf('if (reanalyze) {');
      const elseAt = before.lastIndexOf('} else {');
      expect(guardAt).toBeGreaterThan(-1);
      // The nearest `} else {` above the call must itself be below the nearest
      // `if (reanalyze) {`: that is what makes the call the else of that if.
      expect(elseAt).toBeGreaterThan(guardAt);
    });

    it('rebuilds the media from disk instead', () => {
      expect(source).toMatch(/await rebuildLocalPaths\(entryId\)/);
    });

    it('abandons the pass when the disk holds nothing, without downloading', () => {
      const at = source.indexOf('await rebuildLocalPaths(entryId)');
      const branch = source.slice(at, at + 900);
      expect(branch).toMatch(/if \(!local\)/);
      expect(branch).toMatch(/no local media/);
      expect(branch).not.toMatch(/extractContent/);
    });
  });

  describe('never calls an external service', () => {
    // The rule that replaced per-operation gates. Gating them one at a time is
    // what let five of them go unguarded; a call site added later without a
    // guard is the regression this catches, whichever service it is.

    /** The whole statement a call sits in: previous `;`, `{` or `}` to next `;`. */
    function statementAround(at: number): string {
      const start = Math.max(
        source.lastIndexOf(';', at),
        source.lastIndexOf('{', at),
        source.lastIndexOf('}', at)
      );
      const end = source.indexOf(';', at);
      return source.slice(start + 1, end === -1 ? at : end);
    }

    // Tier 1 — the whole operation is off limits on a second pass. Absence of
    // a result is not evidence the service was ever asked, so these stay off
    // even when the entry has nothing.
    for (const call of ['await scanFullAudio(', 'await resolveYoutubeUrl(']) {
      it(`never runs ${call.replace('await ', '').replace('(', '')} on a second pass`, () => {
        const found = sites(call);
        expect(found.length).toBeGreaterThan(0);
        for (const at of found) {
          expect(codeOnly(source.slice(Math.max(0, at - 900), at))).toContain('reanalyze');
        }
      });
    }

    // Tier 2 — the lookup is skipped for an item the merge is about to discard.
    // Checked at statement level, not by proximity: the guard sits in the same
    // expression as the call, and a nearby mention of the flag is not a guard.
    for (const call of ['await searchTrack(', 'await searchFilm(']) {
      it(`never spends ${call.replace('await ', '').replace('(', '')} on an item already on the entry`, () => {
        const found = sites(call);
        expect(found.length).toBeGreaterThan(0);
        for (const at of found) {
          expect(statementAround(at)).toMatch(/alreadyOnEntry|AlreadyOnEntry/);
        }
      });
    }

    it('reaches the playlist only through a lookup that was allowed to run', () => {
      // addToPlaylist takes a uri that can only come from a non-null
      // spotifyResult, and spotifyResult is guarded above — so guarding the
      // lookup transitively guards the write.
      const found = sites('await addToPlaylist(');
      expect(found.length).toBeGreaterThan(0);
      for (const at of found) expect(statementAround(at)).toContain('spotifyResult');
    });

    it('never runs the OpenAI auto-enrichment on a second pass', () => {
      // A missing `results.enrichments` is not evidence enrichment never ran.
      expect(source).toMatch(/if \(openaiConfig\.apiKey && !reanalyze\)/);
    });

    it('never fetches a page on a second pass either', () => {
      // Unreachable today, but the guarantee must not depend on who happens to
      // set the flag: document ingestion is specced and creates entries from
      // URLs. The page pipeline persists nothing locally, so it abandons.
      const at = source.indexOf('await extractPage(normalizedUrl)');
      expect(at).toBeGreaterThan(-1);
      const before = codeOnly(source.slice(Math.max(0, at - 900), at));
      expect(before).toContain('if (reanalyze) {');
      expect(before).toContain('return;');
    });

    it('falls back to a locally built YouTube search URL rather than none', () => {
      // Skipping the resolver must not leave a genuinely new song linkless.
      const at = source.indexOf('if (reanalyze && featuresConfig.youtubeDirect)');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(Math.max(0, at - 400), at)).toContain('generateYoutubeSearchUrl(');
    });
  });

  describe('recomputes only what is missing, and only locally', () => {
    it('reads the derivations the first pass persisted off the entry', () => {
      expect(source).toMatch(/const reusedOverlayText = priorResults\?\.overlayText \?\? null;/);
      expect(source).toMatch(/const reusedVisualContext = priorResults\?\.visualContext \?\? null;/);
    });

    it('treats an empty slide array as absent, as the merge does', () => {
      expect(source).toMatch(/const reusedSlides = priorResults\?\.slides\?\.length \? priorResults\.slides : null;/);
    });

    it('reuses persisted slides instead of re-analysing them', () => {
      const at = source.indexOf('if (reusedSlides) {');
      expect(at).toBeGreaterThan(-1);
      // analyzeSlides must sit in the else, not run regardless.
      const analyseAt = source.indexOf('await analyzeSlides(');
      expect(analyseAt).toBeGreaterThan(at);
      expect(source.slice(at, analyseAt)).toContain('} else if (pagePaths.length > 0) {');
    });

    it('reuses a persisted visual description instead of re-running vision', () => {
      const at = source.indexOf('let visualContext: string | null = reusedVisualContext;');
      expect(at).toBeGreaterThan(-1);
      const visionAt = source.indexOf('await describeFramesWithVision(');
      expect(visionAt).toBeGreaterThan(at);
      expect(source.slice(at, visionAt)).toContain('} else if (featuresConfig.mediaAnalysisEnabled');
    });

    it('still computes a missing derivation, because those stay local', () => {
      // soundreel-ocr and Ollama through the router: an entry archived before
      // OCR existed gains OCR rather than being frozen without it.
      const at = source.indexOf('ocr = await ocrImages(ocrPaths);');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(Math.max(0, at - 300), at)).toContain('} else {');
    });

    it('runs OCR again when a carousel still needs its per-image split', () => {
      expect(source).toMatch(/const carouselSlidesPending = !reusedSlides && slides\.length > 0;/);
    });

    it('does not re-derive carousel items already folded into the entry', () => {
      expect(source).toMatch(/if \(!reanalyze && featuresConfig\.carouselStructuredExtraction/);
    });
  });

  describe('leaves the archive as it found it', () => {
    it('never queues a third pass', () => {
      // transcribe → reanalyse → transcribe → ... is an infinite loop, and
      // audio.wav is still on disk when the second pass runs.
      expect(source).toMatch(/if \(!reanalyze && featuresConfig\.transcriptionEnabled/);
    });

    it('merges the results instead of replacing them', () => {
      expect(source).toMatch(/mergeEntryResults\(before\.results, finalResults\)/);
    });

    it('merges unconditionally, not only on a second pass', () => {
      // The merge being flag-free is what lets `reanalyze` mean exactly one
      // thing — the media is on disk, fetch nothing — so that a repair run
      // keeps its download. It is a no-op when the existing results are empty.
      const at = source.indexOf('mergeEntryResults(before.results, finalResults)');
      expect(at).toBeGreaterThan(-1);
      const preceding = source.slice(Math.max(0, at - 400), at);
      expect(preceding).toContain('const before = await getEntry(entryId);');
      expect(preceding).not.toContain('if (reanalyze) {');
    });

    it('leaves the entry status untouched when a second pass throws', () => {
      // Flipping an archived `completed` entry to `error` degrades the archive
      // and feeds it back to requeueErrors.
      expect(source).toMatch(/reanalyze \? \(priorEntry\?\.status \?\? 'error'\) : 'error'/);
    });

    it('keeps the entry caption, thumbnail and mediaUrl out of the second pass', () => {
      // content.videoUrl and content.audioUrl are null on the rebuilt path, so
      // writing them back would blank an archived entry's mediaUrl.
      expect(source).toMatch(/if \(!reanalyze\) \{\s*\n\s*\/\/ -+\s*\n\s*\/\/ Thumbnail persistence/);
    });

    it('tells both Claude fallbacks that this is a second pass', () => {
      // The fallback gets *more* likely on a reanalyse, because the transcript
      // pushes source text past the length threshold. Both call sites must hand
      // the flag down so the cheap model is used.
      expect(source).toMatch(/\}, \{ reanalyze \}\);/);
      const threaded = (source.match(/\}, \{ reanalyze \}\)/g) ?? []).length;
      // two analyzeWithAi call sites (local + legacy) and one analyzeSlides
      expect(threaded).toBe(3);
    });

    it('does not re-enrich songs and notes the entry already carries', () => {
      expect(source).toMatch(/\.filter\(\(s\) => !priorSongKeys\.has\(songKey\(s\.title, s\.artist\)\)\)/);
      expect(source).toMatch(/notes\.filter\(\(n\) => !priorNoteKeys\.has\(noteKey\(n\.category, n\.text\)\)\)/);
    });
  });
});
