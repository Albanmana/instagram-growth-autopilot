import { createClient } from "@supabase/supabase-js";

import { loadServiceConfig } from "./config.mjs";
import { createControlPlane } from "./domain.mjs";
import { createFollowupRepository } from "./repository.mjs";
import { createLocalService } from "./server.mjs";

const config = loadServiceConfig();
const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const service = createLocalService({
  controlPlane: createControlPlane({ repository: createFollowupRepository(client) }),
  config,
});

const address = await service.listen();
console.log(`Instagram Growth Autopilot local service listening on http://${address.address}:${address.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await service.close();
    process.exit(0);
  });
}
