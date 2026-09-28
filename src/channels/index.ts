// Channel self-registration barrel for the Gateway.
// Each import triggers registerChannelAdapter().
//
// Gateway product: Zoho Cliq (env-based single account). Multi-account Cliq
// also registers from src/gateway/channels/zoho-cliq-multi.ts.
// Extra channels: install via /add-<channel> skills and append an import here.

import './zoho-cliq.js';
