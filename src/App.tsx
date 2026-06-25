import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Config from './pages/Config';
import Dashboard from './pages/Dashboard';

function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Config />} />
            <Route path="/dashboard" element={<Dashboard />} />
          </Routes>
        </main>

        <footer className="site-footer">
          <span>(C) 2026 - Dr. Pantaleon Fassbender - leo@twistersmanagementconsultingllc.com.</span>
        </footer>
      </div>
    </BrowserRouter>
  );
}

export default App;
