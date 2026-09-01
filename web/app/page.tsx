import Chat from "./chat";
import { readEvalSummary } from "@/lib/evalsummary";

/**
 * A server component purely so the eval summary can be read from disk and handed
 * to the client as a prop — no extra request, and nothing about the file system
 * reaches the browser. The chat itself is the client component next door.
 */
export default function Page() {
  return <Chat evalSummary={readEvalSummary()} />;
}
