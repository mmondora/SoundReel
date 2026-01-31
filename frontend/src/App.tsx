import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { LanguageProvider } from './i18n';
import { Home } from './pages/Home';
import { Settings } from './pages/Settings';
import { Prompts } from './pages/Prompts';
import { Console } from './pages/Console';
import './styles/index.css';

export function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/prompts" element={<Prompts />} />
          <Route path="/console" element={<Console />} />
        </Routes>
      </BrowserRouter>
    </LanguageProvider>
  );
}
