/**
 * Muster+ Main App Component
 * React-based UI with all integrated features
 */

import React, { useState, useEffect } from 'react';
import { musterPlus } from './main';

export const App: React.FC = () => {
  const [initialized, setInitialized] = useState(false);
  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    initializeApp();
  }, []);

  const initializeApp = async () => {
    await musterPlus.initialize();
    setInitialized(true);
    setStatus(musterPlus.getStatus());
  };

  if (!initialized) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#030711] text-white">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-4">🚀 Muster+</h1>
          <p className="text-gray-400">Initializing...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#030711] text-white">
      <header className="border-b border-gray-800 p-4">
        <h1 className="text-2xl font-bold">🚀 Muster+</h1>
        <p className="text-sm text-gray-400">The world's best AI assistant</p>
      </header>

      <main className="p-6">
        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-[#1d293a] p-4 rounded-lg">
              <h3 className="font-semibold mb-2">🤖 Agents</h3>
              <p className="text-sm text-gray-400">Multi-agent system ready</p>
            </div>
            <div className="bg-[#1d293a] p-4 rounded-lg">
              <h3 className="font-semibold mb-2">🧠 Memory</h3>
              <p className="text-sm text-gray-400">8 memory types active</p>
            </div>
            <div className="bg-[#1d293a] p-4 rounded-lg">
              <h3 className="font-semibold mb-2">⚡ Models</h3>
              <p className="text-sm text-gray-400">200+ via OpenRouter</p>
            </div>
          </div>

          <div className="bg-[#1d293a] p-6 rounded-lg">
            <h2 className="text-xl font-semibold mb-4">Welcome to Muster+</h2>
            <p className="text-gray-300 mb-4">
              The privacy-first, viral-friendly AI assistant that combines:
            </p>
            <ul className="space-y-2 text-gray-300">
              <li>✅ Local-first architecture (your data stays on device)</li>
              <li>✅ 200+ AI models through OpenRouter</li>
              <li>✅ 8 memory types for true personalization</li>
              <li>✅ Template marketplace for instant productivity</li>
              <li>✅ Mobile apps with cross-device sync</li>
              <li>✅ Viral sharing and referral program</li>
            </ul>
          </div>

          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <button className="bg-[#00bbff] text-black font-semibold py-3 px-6 rounded-lg hover:bg-[#009fd9] transition">
              Start Chatting
            </button>
            <button className="border border-[#00bbff] text-[#00bbff] font-semibold py-3 px-6 rounded-lg hover:bg-[#00bbff] hover:text-black transition">
              Browse Templates
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
