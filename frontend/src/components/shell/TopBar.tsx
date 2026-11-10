import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLanguage } from '../../i18n';
import { fetchMe } from '../../services/api';
import type { MeResponse } from '../../types';
import { PersonalizePanel } from './PersonalizePanel';

const APP_VERSION = __APP_VERSION__;
const GIT_REVISION = __GIT_REVISION__;

/** The bar at the top of every page: the brand, the search of the whole library, «Incolla un link», who is signed in and the menu of the rest. */
export function TopBar() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const [me, setMe] = useState<MeResponse | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [personalizeOpen, setPersonalizeOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((m) => {
        if (!cancelled) setMe(m);
      })
      .catch(() => {
        /* nobody is shown: the bar works without it */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const setQuery = (value: string) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set('q', value);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );

  const items = [
    { to: '/library', label: t.libraryNav },
    { to: '/console', label: t.console },
    { to: '/prompts', label: t.aiPrompts },
    { to: '/admin', label: 'Admin' },
    { to: '/settings', label: t.settings },
  ];

  return (
    <header className="shell-top">
      <Link to="/" className="shell-brand">
        <span className="shell-drop" aria-hidden="true" />
        <b>SoundReel</b>
        <span className="shell-version" title={`build ${GIT_REVISION}`}>v{APP_VERSION}</span>
      </Link>

      <div className="shell-search" role="search">
        <svg className="shell-ic" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="search"
          className="shell-search-input"
          placeholder={t.navSearchPlaceholder}
          aria-label={t.navSearchPlaceholder}
          value={q}
          onChange={(e) => setQuery(e.target.value)}
        />
        {q && (
          <button type="button" className="shell-search-clear" aria-label={t.shellClearSearch} onClick={() => setQuery('')}>
            ×
          </button>
        )}
      </div>

      <Link to="/#paste" className="shell-cta">
        <svg className="shell-ic" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14M12 5v14" />
        </svg>
        {t.shellPaste}
      </Link>

      <div className="shell-who" ref={menuRef}>
        {me && (
          <span className="shell-user" title={me.authenticated ? `Authelia · ${me.user}` : 'Anonymous (no Remote-User)'}>
            {me.displayName}
            {me.isAdmin ? ' · admin' : ''}
          </span>
        )}
        <button
          ref={moreRef}
          type="button"
          className={`shell-more-btn${menuOpen ? ' open' : ''}`}
          aria-label={t.shellMore}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="shell-more-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setPersonalizeOpen(true); }}>
              {t.personalizeOpen}
            </button>
            {items.map((item) => (
              <Link key={item.to} to={item.to} role="menuitem" onClick={() => setMenuOpen(false)}>
                {item.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      {personalizeOpen && (
        <PersonalizePanel
          onClose={() => {
            setPersonalizeOpen(false);
            moreRef.current?.focus();   // the menu item that opened it is gone: the focus goes back to the «⋯» button
          }}
        />
      )}
    </header>
  );
}
