import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { assessOutlet } from "@/lib/inngest/functions";

// Because Next is configured with basePath: "/cited", the SDK's actual URL
// is /cited/api/inngest. Inngest needs to know this explicitly — it can't
// infer it from the incoming request when basePath is in play.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [assessOutlet],
  servePath: "/cited/api/inngest",
});
