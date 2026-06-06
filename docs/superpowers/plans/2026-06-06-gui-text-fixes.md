# GUI Text Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove outdated "Gemini" model references from all user-visible UI text.

**Architecture:** Pure text changes in two files — no logic, no new components. All Gemini mentions replaced with generic "AI" to avoid future re-rotting if the model changes again.

**Tech Stack:** React + TypeScript frontend, Vite build

---

## Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `frontend/src/components/ActivityTimeline.tsx` | 18 | Label: `'Analisi AI (Gemini)'` → `'Analisi AI'` |
| `frontend/src/i18n/translations.ts` | 409, 416, 418 | IT strings: drop "Gemini" → "AI" |
| `frontend/src/i18n/translations.ts` | ~642, ~649, ~651 | EN strings: drop "Gemini" → "AI" |

---

## Task 1: Fix ActivityTimeline label

**Files:**
- Modify: `frontend/src/components/ActivityTimeline.tsx:18`

- [ ] **Step 1: Edit the label**

In `frontend/src/components/ActivityTimeline.tsx`, change line 18:

```typescript
// before
ai_analyzed: { it: 'Analisi AI (Gemini)', en: 'AI Analysis (Gemini)' },

// after
ai_analyzed: { it: 'Analisi AI', en: 'AI Analysis' },
```

- [ ] **Step 2: TypeScript check**

```bash
cd /home/mike/works/Soundreel/backend && npx tsc --noEmit
cd /home/mike/works/Soundreel/frontend && npx tsc --noEmit
```

Expected: no errors.

---

## Task 2: Fix translations.ts — Italian strings

**Files:**
- Modify: `frontend/src/i18n/translations.ts:409,416,418`

- [ ] **Step 1: Fix mediaAnalysisDescription (IT)**

Change line ~409:
```typescript
// before
mediaAnalysisDescription: 'Scarica audio/video e li analizza con Gemini per trascrizione, riconoscimento scene e testo sovrapposto.',

// after
mediaAnalysisDescription: 'Scarica audio/video e li analizza con AI per trascrizione, riconoscimento scene e testo sovrapposto.',
```

- [ ] **Step 2: Fix aiAnalysisToggleDescription (IT)**

Change line ~416:
```typescript
// before
aiAnalysisToggleDescription: 'Analizza il contenuto con Gemini per estrarre canzoni, film, note e tag.',

// after
aiAnalysisToggleDescription: 'Analizza il contenuto con AI per estrarre canzoni, film, note e tag.',
```

- [ ] **Step 3: Fix transcriptionToggleDescription (IT)**

Change line ~418:
```typescript
// before
transcriptionToggleDescription: 'Trascrive il parlato dall\'audio usando Gemini.',

// after
transcriptionToggleDescription: 'Trascrive il parlato dall\'audio usando AI.',
```

---

## Task 3: Fix translations.ts — English strings

**Files:**
- Modify: `frontend/src/i18n/translations.ts` (EN section, ~line 642+)

- [ ] **Step 1: Fix mediaAnalysisDescription (EN)**

```typescript
// before
mediaAnalysisDescription: 'Downloads audio/video and analyzes them with Gemini for transcription, scene recognition, and overlay text.',

// after
mediaAnalysisDescription: 'Downloads audio/video and analyzes them with AI for transcription, scene recognition, and overlay text.',
```

- [ ] **Step 2: Fix aiAnalysisToggleDescription (EN)**

```typescript
// before
aiAnalysisToggleDescription: 'Analyze content with Gemini to extract songs, films, notes, and tags.',

// after
aiAnalysisToggleDescription: 'Analyze content with AI to extract songs, films, notes, and tags.',
```

- [ ] **Step 3: Fix transcriptionToggleDescription (EN)**

```typescript
// before
transcriptionToggleDescription: 'Transcribes speech from audio using Gemini.',

// after
transcriptionToggleDescription: 'Transcribes speech from audio using AI.',
```

---

## Task 4: TypeScript check + commit

- [ ] **Step 1: TypeScript check (frontend)**

```bash
cd /home/mike/works/Soundreel/frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Verify no remaining Gemini references in UI-visible strings**

```bash
grep -n "Gemini\|gemini" /home/mike/works/Soundreel/frontend/src/components/ActivityTimeline.tsx /home/mike/works/Soundreel/frontend/src/i18n/translations.ts
```

Expected: zero output.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ActivityTimeline.tsx frontend/src/i18n/translations.ts
git commit -m "fix(frontend): replace Gemini model name with generic AI in UI text"
```

- [ ] **Step 4: Deploy**

```bash
touch /home/mike/works/Soundreel/.rebuild
```
