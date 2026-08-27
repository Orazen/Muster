/**
 * Integrations - Connect with external services
 */
import React from 'react';
import { integrationHub, Integration } from '../../lib/integrations/integration-hub';

export const IntegrationsPage: React.FC = () => {
  const integrations = integrationHub.getAll();
  const connected = integrationHub.getConnected();

  const handleConnect = async (id: string) => {
    await integrationHub.connect(id);
    alert('Connected!');
  };

  const handleDisconnect = async (id: string) => {
    await integrationHub.disconnect(id);
    alert('Disconnected');
  };

  const categories = ['all', 'productivity', 'communication', 'storage', 'automation', 'developer'];

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold text-white mb-2">🔌 Integrations</h2>
      <p className="text-gray-400 mb-6">Connect Muster+ with your favorite tools</p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {integrations.map(integration => (
          <div key={integration.id} className="bg-[#1d293a] rounded-lg p-4">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-3xl">{integration.icon}</span>
              <div>
                <h3 className="font-semibold text-white">{integration.name}</h3>
                <p className="text-sm text-gray-400">{integration.category}</p>
              </div>
            </div>
            <p className="text-sm text-gray-400 mb-4">{integration.description}</p>
            {integration.connected ? (
              <button
                onClick={() => handleDisconnect(integration.id)}
                className="w-full bg-red-500 text-white py-2 rounded font-semibold"
              >
                Disconnect
              </button>
            ) : (
              <button
                onClick={() => handleConnect(integration.id)}
                className="w-full bg-[#00bbff] text-black py-2 rounded font-semibold hover:bg-[#009fd9]"
              >
                Connect
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default IntegrationsPage;
