import { run } from "./pipeline.ts";
import type { Env } from "./types.ts";

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Retrying could send a second digest; the next run (minutes away) carries on.
    (controller as unknown as { noRetry?: () => void }).noRetry?.();
    const report = await run(env, new Date(controller.scheduledTime));
    if (report.kind === "digest") {
      console.log(JSON.stringify({ kind: "digest", listed: report.listed, reviewed: report.stats.reviewed, sent: report.sent, failures: report.stats.failures, subrequests: report.subrequests }));
    } else if (report.kind === "incoming-report") {
      console.log(JSON.stringify({ kind: "incoming-report", listed: report.listed, dealtWith: report.dealtWith, sent: report.sent, subrequests: report.subrequests }));
    } else {
      console.log(
        JSON.stringify({
          kind: "work",
          slices: report.slices,
          sentIndexed: report.sentIndexed,
          reviewed: report.reviewed.length,
          found: report.suspects.length,
          settledByFact: report.settledByFact,
          sentToModel: report.sentToModel,
          modelCalls: report.modelCalls,
          moved: report.rescue?.moved.length ?? 0,
          incoming: report.incoming,
          idle: report.idle,
          failures: report.failures,
          subrequests: report.subrequests,
        }),
      );
    }
  },

  // No HTTP interface on purpose: nothing to attack. (workers_dev is off.)
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
