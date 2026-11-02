import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { LanguageProvider } from './i18n';
import { Home } from './pages/Home';
import { Settings } from './pages/Settings';
import { Prompts } from './pages/Prompts';
import { Console } from './pages/Console';
import { Admin } from './pages/Admin';
import { EntriesPage } from './pages/EntriesPage';
import { SongsPage } from './pages/SongsPage';
import { FilmsPage } from './pages/FilmsPage';
import { NotesPage } from './pages/NotesPage';
import { SoftwarePage } from './pages/SoftwarePage';
import { LibraryPage } from './pages/LibraryPage';
import { LicensesPage } from './pages/LicensesPage';
import './styles/index.css';

export function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/entries" element={<EntriesPage />} />
          <Route path="/songs" element={<SongsPage />} />
          <Route path="/films" element={<FilmsPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/software" element={<SoftwarePage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/licenses" element={<LicensesPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/prompts" element={<Prompts />} />
          <Route path="/console" element={<Console />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </BrowserRouter>
    </LanguageProvider>
  );
}
