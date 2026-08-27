/**
 * Viral Share - Referral program and sharing
 */
import React, { useState } from 'react';
import { viralMechanics } from '../lib/viral/viral-mechanics';

export const ViralShare: React.FC<{ userId: string }> = ({ userId }) => {
  const [stats, setStats] = useState(viralMechanics.getReferralStats(userId));
  const [shareUrl, setShareUrl] = useState<string>('');

  const generateReferral = () => {
    const code = viralMechanics.generateReferralCode(userId);
    setShareUrl(`https://muster-plus.heyworld.ai/r/${code.code}`);
    setStats(viralMechanics.getReferralStats(userId));
  };

  const copyToClipboard = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(shareUrl);
      alert('Copied to clipboard!');
    }
  };

  const shareToTwitter = () => {
    window.open(`https://twitter.com/intent/tweet?text=I just started using Muster%2B&url=${encodeURIComponent(shareUrl)}`, '_blank');
    viralMechanics.trackShare('referral');
  };

  return (
    <div className="bg-[#1d293a] rounded-lg p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold text-white mb-2">🌟 Share & Earn</h2>
      <p className="text-gray-400 mb-4">Get 7 free Pro days for each friend you refer</p>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-[#0a0e1a] p-4 rounded">
          <div className="text-2xl font-bold text-[#00bbff]">{stats.totalReferrals}</div>
          <div className="text-sm text-gray-400">Total Referrals</div>
        </div>
        <div className="bg-[#0a0e1a] p-4 rounded">
          <div className="text-2xl font-bold text-[#00bbff]">{stats.points}</div>
          <div className="text-sm text-gray-400">Points Earned</div>
        </div>
      </div>

      <button
        onClick={generateReferral}
        className="w-full bg-[#00bbff] text-black font-semibold py-3 rounded mb-4 hover:bg-[#009fd9] transition"
      >
        Generate Referral Link
      </button>

      {shareUrl && (
        <div className="bg-[#0a0e1a] p-4 rounded">
          <p className="text-sm text-gray-400 mb-2">Your referral link:</p>
          <div className="flex gap-2">
            <input type="text" value={shareUrl} readOnly className="flex-1 bg-[#1d293a] px-3 py-2 rounded text-white text-sm" />
            <button onClick={copyToClipboard} className="bg-[#00bbff] text-black px-4 py-2 rounded font-semibold">Copy</button>
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-4">
        <button onClick={shareToTwitter} className="flex-1 bg-[#1DA1F2] text-white py-2 rounded font-semibold hover:opacity-90">
          Share on Twitter
        </button>
      </div>
    </div>
  );
};

export default ViralShare;
