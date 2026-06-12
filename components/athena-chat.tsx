"use client";

// Athena chat drawer — self-contained dossier copilot. Collapsed: a fixed
// bottom-right α button. Expanded: a right-side drawer wired to
// /api/athena/chat. Not mounted anywhere yet; the dossier page wires it in.
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";

const SUGGESTIONS = [
  "What changed since our thesis?",
  "What would kill this thesis?",
  "Summarize the latest filing",
  "Is the valuation asymmetry still intact?",
];

function toolLabel(name: string, input: unknown): string {
  const query =
    input && typeof input === "object" && "query" in input && typeof input.query === "string"
      ? input.query
      : null;
  switch (name) {
    case "searchVault":
      return `searched the vault${query ? `: ${query}` : ""}`;
    case "getQuote":
      return "pulled the live quote";
    case "getFundamentals":
      return "pulled EDGAR fundamentals";
    case "listClaims":
      return "reviewed the claim ledger";
    case "listCatalysts":
      return "reviewed the catalyst calendar";
    default:
      return `ran ${name}`;
  }
}

/** The 503 no-key case returns JSON { error } — surface it in institutional tone. */
function friendlyError(err: Error): string {
  try {
    const parsed = JSON.parse(err.message) as { error?: string };
    if (parsed?.error) return parsed.error;
  } catch {
    // not JSON — fall through
  }
  return err.message || "Athena is unreachable. Check the dev server and try again.";
}

export function AthenaChat({ ticker }: { ticker: string }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/athena/chat", body: { ticker } }),
    [ticker],
  );
  const { messages, sendMessage, status, error } = useChat({ transport });

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, status, error]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ text: trimmed });
    setInput("");
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open Athena chat for ${ticker}`}
        className="serif fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full border border-platinum/50 bg-ink-raised/95 text-2xl leading-none text-parchment backdrop-blur transition-colors hover:border-platinum"
      >
        α
      </button>
    );
  }

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-[420px] max-w-full flex-col border-l border-line-strong bg-ink-raised/95 backdrop-blur">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div className="label !text-parchment-dim">ATHENA — {ticker}</div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="label cursor-pointer transition-colors hover:text-parchment"
        >
          CLOSE
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {messages.length === 0 && !error && (
          <div className="fade-up">
            <div className="label mb-3">OPEN QUESTIONS</div>
            <div className="flex flex-col gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => submit(s)}
                  className="card cursor-pointer px-3 py-2 text-left text-sm text-parchment-dim transition-colors hover:text-parchment"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[85%] border border-line bg-ink-card px-3 py-2 text-sm text-parchment-dim">
                {message.parts.map((part, i) =>
                  part.type === "text" ? <span key={i}>{part.text}</span> : null,
                )}
              </div>
            </div>
          ) : (
            <div key={message.id} className="space-y-1.5">
              {message.parts.map((part, i) => {
                if (part.type === "text") {
                  return (
                    <p
                      key={i}
                      className="serif whitespace-pre-wrap text-[15px] leading-relaxed text-parchment"
                    >
                      {part.text}
                    </p>
                  );
                }
                if (isToolUIPart(part)) {
                  return (
                    <div key={i} className="label !normal-case !tracking-normal">
                      › {toolLabel(getToolName(part), part.input)}
                      {part.state === "output-error" ? " — failed" : ""}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          ),
        )}

        {status === "submitted" && <div className="label animate-pulse">ATHENA IS WORKING…</div>}

        {error && (
          <div className="card border-bear/40 px-4 py-3">
            <div className="label mb-1 !text-bear">ATHENA OFFLINE</div>
            <p className="text-sm text-parchment-dim">{friendlyError(error)}</p>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="flex gap-2 border-t border-line px-4 py-4"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Ask Athena about ${ticker}…`}
          className="min-w-0 flex-1 border border-line bg-transparent px-3 py-2 text-sm text-parchment placeholder:text-parchment-faint focus:border-line-strong focus:outline-none"
        />
        <button type="submit" className="btn" disabled={busy || input.trim().length === 0}>
          SEND
        </button>
      </form>
    </aside>
  );
}
