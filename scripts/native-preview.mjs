import { startNativeIntegration } from '../lib/native-host.mjs';
import { parseSessionData } from '../sidecars/inspector/main.mjs';
const stop = startNativeIntegration({ parseSessionData });
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await stop(); process.exit(0); });
