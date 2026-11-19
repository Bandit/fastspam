import { run } from "./pipeline.ts";
import type { Env } from "./types.ts";

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Retrying could send a second digest; a missed run is caught up next time.
    (controller as unknown as { noRetry?: () => void }).noRetry?.();
    const report = await run(env, new Date(controller.scheduledTime));
    console.log(
      JSON.stringify({
        fresh: report.stats.fresh,
        reported: report.suspects.length,
        settledByFact: report.stats.settledByFact,
        sentToModel: report.stats.sentToModel,
        modelCalls: report.stats.modelCalls,
        moved: report.rescue?.moved.length ?? 0,
        failures: report.stats.failures,
        subrequests: report.subrequests,
        sent: report.sent,
      }),
    );
  },

  // No HTTP interface on purpose: nothing to attack. (workers_dev is off.)
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
