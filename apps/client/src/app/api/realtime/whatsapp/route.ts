import { auth } from "@/auth";
import {
  buildWhatsappUserChannel,
  createWhatsappRealtimeSubscriber,
} from "@/lib/whatsapp/realtime";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const subscriber = createWhatsappRealtimeSubscriber();
  const encoder = new TextEncoder();
  const channel = buildWhatsappUserChannel(userId);
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      await subscriber.subscribe(channel);

      const onMessage = (incomingChannel: string, payload: string) => {
        if (incomingChannel !== channel) return;
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      };

      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15000);

      subscriber.on("message", onMessage);
      controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));

      const close = async () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        subscriber.off("message", onMessage);
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
      }

      req.signal.addEventListener("abort", () => {
        void close();
      });
    },
    async cancel() {
      if (closed) return;
      closed = true;
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
