/**
 * Memory Viewer - Visualize 8 memory types
 */
import React, { useState, useEffect } from 'react';
import { MemoryManager, MemoryType } from '../lib/memory/memory-store';

const MEMORY_COLORS: Record<string, string> = {
  episodic: '#fbbf24', semantic: '#60a5fa', procedural: '#34d399',
  emotional: '#f87171', prospective: '#a78bfa', behavioral: '#fb923c',
  narrative: '#06b6d4', shared: '#84cc16', temporal: '#ec4899',
};

const MEMORY_ICONS: Record<string, string> = {
  episodic: '💬', semantic: '🧠', procedural: '⚙️',
  emotional: '❤️', prospective: '🎯', behavioral: '🔄',
  narrative: '📖', shared: '👥', temporal: '⏰',
};

export const MemoryViewer: React.FC<{ agentId: string }> = ({ agentId }) => {
  const [memory] = useState(() => new MemoryManager(agentId));
  const [stats, setStats] = useState<any>(null);
  const [selectedType, setSelectedType] = useState<string>('episodic');

  useEffect(() => { loadStats(); }, []);

  const loadStats = async () => {
    const memoryStats = await memory.getStats();
    setStats(memoryStats);
  };

  return (
    <div className="bg-[#1d293a] rounded-lg p-4">
      <h2 className="text-xl font-bold text-white mb-4">🧠 Memory System</h2>
      {stats && (
        <div className="mb-4 p-3 bg-[#0a0e1a] rounded">
          <p className="text-sm text-gray-400">Total Items: <span className="text-white font-semibold">{stats.total}</span></p>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 mb-4">
        {Object.keys(MEMORY_ICONS).map(type => (
          <button
            key={type}
            onClick={() => setSelectedType(type)}
            className={`p-2 rounded text-sm ${selectedType === type ? 'ring-2 ring-[#00bbff]' : ''}`}
            style={{ backgroundColor: MEMORY_COLORS[type] + '20' }}
          >
            <div className="text-2xl">{MEMORY_ICONS[type]}</div>
            <div className="text-xs text-gray-300 capitalize">{type}</div>
          </button>
        ))}
      </div>
      <p className="text-gray-400 text-sm capitalize">{selectedType} memory active</p>
    </div>
  );
};

export default MemoryViewer;
