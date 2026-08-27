/**
 * Settings Panel - OpenRouter API Key Integration
 */
import React, { useState, useEffect } from 'react';
import { Settings, Key, Check, X } from 'lucide-react';
import { modelIntegration, ModelInfo } from '../providers/openrouter';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ isOpen, onClose }) => {
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('openai/gpt-4o');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem('openrouter_api_key');
    if (saved) setApiKey(saved);
    loadModels();
  }, []);

  const loadModels = async () => {
    try {
      const m = await modelIntegration.getModels();
      setModels(m);
    } catch (e) { console.error(e); }
  };

  const saveKey = () => {
    modelIntegration.setApiKey(apiKey);
    localStorage.setItem('openrouter_api_key', apiKey);
    localStorage.setItem('selected_model', selectedModel);
  };

  const test = async () => {
    if (!apiKey) return;
    setIsTesting(true);
    try {
      modelIntegration.setApiKey(apiKey);
      const m = await modelIntegration.getModels();
      setTestResult(m.length > 0 ? 'success' : 'error');
    } catch { setTestResult('error'); }
    setIsTesting(false);
  };

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#1d293a] rounded-lg p-6 w-full max-w-2xl">
        <div className="flex justify-between mb-6">
          <h2 className="text-xl font-bold text-white">Settings</h2>
          <button onClick={onClose}><X size={24} /></button>
        </div>
        <section className="mb-6">
          <h3 className="text-lg font-semibold text-white mb-4">OpenRouter API Key</h3>
          <div className="flex gap-2">
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
              placeholder="sk-or-v1-..."
              className="flex-1 px-4 py-2 bg-[#0a0e1a] border border-gray-700 rounded-lg text-white" />
            <button onClick={test} disabled={!apiKey || isTesting}
              className="px-4 py-2 bg-[#00bbff] text-black rounded-lg font-semibold">
              {isTesting ? 'Testing...' : 'Test'}
            </button>
            <button onClick={saveKey}
              className="px-4 py-2 bg-green-600 text-white rounded-lg font-semibold">Save</button>
          </div>
          {testResult && (
            <div className={'mt-2 ' + (testResult === 'success' ? 'text-green-400' : 'text-red-400')}>
              {testResult === 'success' ? 'Connected! ' + models.length + ' models' : 'Failed'}
            </div>
          )}
        </section>
        <section className="mb-6">
          <h3 className="text-lg font-semibold text-white mb-4">Default Model</h3>
          <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)}
            className="w-full px-4 py-2 bg-[#0a0e1a] border border-gray-700 rounded-lg text-white">
            {models.slice(0, 20).map(m => (
              <option key={m.id} value={m.id}>{m.label} - {m.provider}</option>
            ))}
          </select>
        </section>
        <section className="bg-[#0a0e1a] rounded-lg p-4">
          <h3 className="text-lg font-semibold text-[#00bbff] mb-2">Muster+ Features</h3>
          <ul className="text-sm text-gray-400 space-y-1">
            <li>200+ AI models via OpenRouter</li>
            <li>8 memory types</li>
            <li>Template marketplace</li>
            <li>Viral referral system</li>
          </ul>
        </section>
      </div>
    </div>
  );
};

export default SettingsPanel;
