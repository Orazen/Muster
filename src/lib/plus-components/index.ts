/**
 * Muster+ Integration Module
 */
import React, { useState, useEffect } from 'react';
import { PlusModelPicker } from './PlusModelPicker';
import { MemoryViewer } from './MemoryViewer';
import { TemplateGallery } from './TemplateGallery';
import { ViralShare } from './ViralShare';
import { SettingsPanel } from './SettingsPanel';

export const initializeMusterPlus = async () => {
  const savedKey = localStorage.getItem('openrouter_api_key');
  if (savedKey) {
    const { modelIntegration } = await import('../providers/openrouter');
    modelIntegration.setApiKey(savedKey);
  }
};

export const MusterPlusProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [ready, setReady] = useState(false);
  const [show, setShow] = useState(false);
  useEffect(() => {
    initializeMusterPlus().then(() => setReady(true));
  }, []);
  return (
    <>
      {children}
      <SettingsPanel isOpen={show} onClose={() => setShow(false)} />
      <button onClick={() => setShow(true)}
        className="fixed bottom-6 right-6 w-14 h-14 bg-[#00bbff] rounded-full shadow-lg flex items-center justify-center z-40"
        title="Muster+ Settings">
        <span className="text-2xl">+</span>
      </button>
    </>
  );
};

export { PlusModelPicker, MemoryViewer, TemplateGallery, ViralShare, SettingsPanel };
