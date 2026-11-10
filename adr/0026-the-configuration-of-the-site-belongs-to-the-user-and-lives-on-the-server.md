# ADR-0026: The configuration of the site belongs to the user and lives on the server

## Status
**Accepted** (10 November 2026): Michele's answer «configurazione per utente - di default vista A». **Built and tested in phase P2** (backend: SoundReel 2.21.0, contract `docs/ui-prefs.md`); the site reads it from phase P3; it waits for Michele's OK to deploy.

## Date
2026-11-10

## Owners
Michele Mondora

## Related
- spec `2026-11-10-web-look-and-feel-rethink-design.md` (§3.3 L4–L5)
- ADR-0018 (rule P: the clients talk to SoundReel, the server decides), ADR-0020 (the Home is decided by the server), ADR-0025 (design tokens)
- `routes/me.ts`-style routes behind Authelia (`Remote-User`), `utils/db`

---

## 1. Context
The site becomes configurable: the view of each page (Studio, Bacheca, Home), the sections of the Home and their order, the place of the Player. Michele: «configurazione per utente - di default vista A». Three people use the site (Michele, Sara, Archimede) from several devices; a setting kept in one browser would be lost on the next one.

## 2. Decision
1. **The configuration is a small document per user** in the database: table `user_prefs (user_id TEXT PRIMARY KEY, prefs JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`. The user is the Authelia user of the request (`Remote-User`); an anonymous request has none and gets the defaults without being able to save.
2. **The server owns the defaults** (rule P): `GET /api/me/prefs` answers the **complete** configuration (what the user chose, the rest filled from the defaults), so every client draws the same thing and none carries a table of defaults. Default: **every page opens in Studio (the A view)**, the Home sections in the order Riprendi · Nuove canzoni · Le tue playlist · Raccolte · Da vedere, all visible, the Player at the bottom.
3. **The server validates.** `PUT /api/me/prefs` takes a partial document, checks every key against a closed list (pages, views, section ids, player positions, a position for the floating Player within bounds, at most 4 KB), merges it into what is stored and answers the complete result; an unknown key or value is a `400` that names it, never a silently wrong setting. `DELETE /api/me/prefs` goes back to the defaults.
4. **No colour in it** (ADR-0025): the configuration says where things are and how a list is drawn, never what colour it is.
5. **The clients remember nothing on their own** except a cached copy to draw at once while the answer is on its way (so the first paint is not blank); the server's answer wins.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| `localStorage` per browser | The phone and the PC would differ, and clearing the browser loses the setting; Michele chose «per utente» |
| One row per setting | A closed document of a few keys is read and written in one go; there is no query by setting |
| Defaults in the client | Two clients (and later Mondrop) would drift; rule P says the server decides |
| A free JSON blob the client defines | It would keep whatever a client sends; a closed schema keeps the data clean and the errors readable |

## 4. Consequences
- ✅ The same look on every device of the same person; defaults change in one place.
- ✅ Additive: one table, two routes; nothing existing changes.
- ⚠️ A first paint before the answer uses the cached copy (or the defaults of the last answer); a change made on another device shows at the next load.
- ⚠️ Mondrop does not use it yet (its Home is already decided by the server, ADR-0020).
