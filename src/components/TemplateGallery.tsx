/**
 * Template Gallery - Browse and install templates
 */
import React, { useState, useEffect } from 'react';
import { templateMarketplace, AgentTemplate } from '../lib/templates/template-marketplace';

export const TemplateGallery: React.FC<{ onInstall: (template: AgentTemplate) => void }> = ({ onInstall }) => {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('all');

  useEffect(() => { loadTemplates(); }, [search, category]);

  const loadTemplates = () => {
    let results = templateMarketplace.getAllTemplates();
    if (category !== 'all') results = results.filter(t => t.category === category);
    if (search) results = templateMarketplace.searchTemplates(search);
    setTemplates(results);
  };

  const categories = ['all', 'coding', 'writing', 'research', 'productivity', 'support'];

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold text-white mb-4">📦 Template Marketplace</h2>
      <input type="text" placeholder="Search templates..." value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 bg-[#1d293a] border border-gray-700 rounded text-white mb-4" />
      <div className="flex gap-2 mb-4 overflow-x-auto">
        {categories.map(cat => (
          <button key={cat} onClick={() => setCategory(cat)}
            className={`px-3 py-1 rounded text-sm whitespace-nowrap ${
              category === cat ? 'bg-[#00bbff] text-black' : 'bg-[#1d293a] text-gray-400'
            }`}>
            {cat.charAt(0).toUpperCase() + cat.slice(1)}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map(template => (
          <div key={template.id} className="bg-[#1d293a] rounded-lg p-4 hover:ring-2 ring-[#00bbff] transition">
            <div className="flex items-start justify-between mb-2">
              <span className="text-3xl">{template.icon}</span>
              {template.featured && <span className="bg-[#00bbff] text-black text-xs px-2 py-1 rounded">Featured</span>}
            </div>
            <h3 className="text-lg font-semibold text-white mb-1">{template.name}</h3>
            <p className="text-sm text-gray-400 mb-3">{template.description}</p>
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-3">
              <span>⭐ {template.rating}</span>
              <span>📥 {template.downloads}</span>
              <span>👥 {template.agents.length} agents</span>
            </div>
            <button onClick={() => onInstall(template)}
              className="w-full bg-[#00bbff] text-black font-semibold py-2 rounded hover:bg-[#009fd9] transition">
              {template.price === 0 ? 'Install Free' : `Install $${template.price}`}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TemplateGallery;
