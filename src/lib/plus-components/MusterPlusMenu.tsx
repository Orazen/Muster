/**
 * Muster+ Menu Component
 */
import React, { useState } from 'react';
import { Sparkles, Cpu, Brain, Layout, Share2, ChevronDown } from 'lucide-react';

export const MusterPlusMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-gray-800 pt-2 mt-2">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[#00bbff] hover:bg-[#1d293a] rounded-lg">
        <Sparkles size={18} />
        <span className="font-semibold">Muster+</span>
        <ChevronDown size={16} className={'ml-auto ' + (open ? 'rotate-180' : '')} />
      </button>
      {open && (
        <div className="ml-4 mt-2 space-y-1">
          <a href="/models" className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-[#1d293a] rounded">
            <Cpu size={14} />Model Picker
          </a>
          <a href="/memory" className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-[#1d293a] rounded">
            <Brain size={14} />Memory
          </a>
          <a href="/templates" className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-[#1d293a] rounded">
            <Layout size={14} />Templates
          </a>
          <a href="/viral" className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-[#1d293a] rounded">
            <Share2 size={14} />Viral Share
          </a>
        </div>
      )}
    </div>
  );
};

export default MusterPlusMenu;
