# Muster+ 

The privacy-first, viral AI assistant that combines the best features from Vellum, GAIA, and other leading platforms.

## Features

- **200+ AI Models** via OpenRouter
- **8 Memory Types** for better context
- **Template Marketplace** for agent templates
- **Viral Referral System** built-in
- **Proactive AI** assistance
- **PWA** installable on any device

## Quick Start

```bash
# Clone the repo
git clone https://github.com/Orazen/Muster.git
cd Muster

# Install dependencies
pnpm install

# Add your OpenRouter API key to .env
echo "OPENROUTER_API_KEY=sk-or-v1-your-key" > .env

# Start development
pnpm dev
```

## Deployment

### Docker

```bash
docker compose -f docker-compose.prod.yml up -d
```

### Dokploy

Connect your GitHub repo to Dokploy and it will auto-deploy on push to main.

## Architecture

```
src/
  lib/
    agents/        # Agent system with 8 memory types
    memory/        # Memory store (8 types)
    providers/     # OpenRouter integration
    viral/         # Viral mechanics
    proactive/     # Proactive AI engine
    billing/       # Subscription system
    marketplace/   # Template marketplace
    integrations/  # 12+ integrations
    analytics/     # Privacy-first analytics
    plus-components/  # UI components
```

## License

SEE LICENSE IN LICENSE FILE
