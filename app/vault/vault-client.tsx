"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function VaultIngest({ initialTicker = "" }: { initialTicker?: string }) {
  const router = useRouter();
  const [ticker, setTicker] = useState(initialTicker);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  async function ingest(e: React.FormEvent) {
    e.preventDefault();
    if (!ticker.trim() || running) return;
    setRunning(true);
    setLog([]);
    try {
      const res = await fetch("/api/vault/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: ticker.trim() }),
      });
      if (!res.body) throw new Error("No response");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as { message: string };
            setLog((prev) => [...prev, ev.message]);
          } catch {}
        }
      }
      router.refresh();
    } catch {
      setLog((prev) => [...prev, "Ingestion failed — connection error."]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <form onSubmit={ingest} className="card px-6 py-5">
      <div className="label mb-1">SEC EDGAR Ingestion</div>
      <p className="mb-4 text-[11px] leading-relaxed text-parchment-faint">
        Pulls the latest annual, quarterly, and current filings (10-K/10-Q/8-K, or 20-F/6-K for foreign issuers) directly from EDGAR — real primary sources, free.
      </p>
      <div className="flex gap-3">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="TSEM"
          maxLength={8}
          disabled={running}
          className="fin w-32 border border-line-strong bg-ink px-3 py-2.5 text-lg tracking-[0.15em] text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
        />
        <button
          type="submit"
          disabled={running || !ticker.trim()}
          className="fin flex-1 border border-line-strong px-4 text-xs tracking-[0.2em] text-parchment hover:bg-ink-raised disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? "INGESTING…" : "PULL FILINGS"}
        </button>
      </div>
      {log.length > 0 && (
        <div className="card-rule mt-4 space-y-1.5 pt-4">
          {log.map((m, i) => (
            <p key={i} className="fin text-[11px] leading-relaxed text-parchment-dim">
              › {m}
            </p>
          ))}
        </div>
      )}
    </form>
  );
}

export function VaultUpload() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [ticker, setTicker] = useState("");
  const [docType, setDocType] = useState("transcript");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/vault/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, ticker: ticker || undefined, docType, content }),
    });
    const j = await res.json();
    if (res.ok) {
      setMsg(`Stored — ${j.chunkCount} chunks indexed.`);
      setTitle("");
      setContent("");
      router.refresh();
    } else {
      setMsg(j.error ?? "Upload failed.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={upload} className="card px-6 py-5">
      <div className="label mb-1">Manual Upload</div>
      <p className="mb-4 text-[11px] leading-relaxed text-parchment-faint">
        Earnings transcripts, expert call notes, analyst memos, articles. Paste text below.
      </p>
      <div className="mb-3 flex gap-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title — e.g. 'TSEM Q1 FY26 earnings call'"
          className="flex-1 border border-line bg-ink px-3 py-2 text-sm text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
        />
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="TICKER"
          maxLength={8}
          className="fin w-24 border border-line bg-ink px-3 py-2 text-sm text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
        />
      </div>
      <select
        value={docType}
        onChange={(e) => setDocType(e.target.value)}
        className="fin mb-3 w-full border border-line bg-ink px-3 py-2 text-xs text-parchment-dim focus:border-platinum focus:outline-none"
      >
        <option value="transcript">Earnings transcript</option>
        <option value="expert_call">Expert call notes</option>
        <option value="note">Analyst note</option>
        <option value="presentation">Investor presentation</option>
        <option value="article">Article</option>
      </select>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Paste document text…"
        rows={6}
        className="w-full resize-none border border-line bg-ink px-3 py-2 text-xs leading-relaxed text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
      />
      <button
        type="submit"
        disabled={busy || !title.trim() || content.length < 200}
        className="fin mt-3 w-full border border-line-strong px-4 py-2.5 text-xs tracking-[0.2em] text-parchment hover:bg-ink-raised disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "INDEXING…" : "COMMIT TO VAULT"}
      </button>
      {msg && <p className="fin mt-2 text-[11px] text-parchment-dim">› {msg}</p>}
    </form>
  );
}

type Excerpt = {
  title: string;
  formType: string | null;
  filedAt: string | null;
  source: string | null;
  text: string;
};

export function VaultAsk() {
  const [question, setQuestion] = useState("");
  const [ticker, setTicker] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [excerpts, setExcerpts] = useState<Excerpt[]>([]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !question.trim()) return;
    setBusy(true);
    setAnswer(null);
    setNote(null);
    setExcerpts([]);
    const res = await fetch("/api/vault/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, ticker: ticker || undefined }),
    });
    const j = await res.json();
    setAnswer(j.answer ?? null);
    setNote(j.note ?? null);
    setExcerpts(j.excerpts ?? []);
    setBusy(false);
  }

  return (
    <section className="card px-6 py-5">
      <div className="label mb-1">Interrogate the Vault</div>
      <p className="mb-4 text-[11px] leading-relaxed text-parchment-faint">
        Ask a research question. Answers are grounded only in documents on file, with citations.
      </p>
      <form onSubmit={ask} className="flex gap-3">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Is revenue growth coming from real demand or channel build?"
          className="flex-1 border border-line-strong bg-ink px-3 py-2.5 text-sm text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
        />
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="TICKER"
          maxLength={8}
          className="fin w-24 border border-line bg-ink px-3 py-2.5 text-sm text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !question.trim()}
          className="fin border border-line-strong px-5 text-xs tracking-[0.2em] text-parchment hover:bg-ink-raised disabled:opacity-40"
        >
          {busy ? "…" : "ASK"}
        </button>
      </form>

      {(answer || note) && (
        <div className="card-rule mt-5 pt-5">
          {answer && (
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-parchment">{answer}</p>
          )}
          {note && <p className="text-[11px] italic text-warn">{note}</p>}
        </div>
      )}

      {excerpts.length > 0 && (
        <div className="card-rule mt-5 space-y-3 pt-5">
          <div className="label">Matching excerpts</div>
          {excerpts.slice(0, 4).map((ex, i) => (
            <div key={i} className="border-l border-line-strong pl-3">
              <div className="fin text-[10px] text-parchment-faint">
                {ex.title}
                {ex.filedAt ? ` · filed ${ex.filedAt}` : ""}
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-parchment-dim">
                {ex.text.slice(0, 400)}…
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
