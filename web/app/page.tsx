"use client";

import { useEffect, useRef, useState } from "react";

type Message = { role: "user" | "assistant"; content: string };

const STORAGE_KEY = "chat-password";

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  // localStorage is browser-only, so read it after mount to keep hydration happy.
  useEffect(() => {
    setPassword(localStorage.getItem(STORAGE_KEY));
    setReady(true);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function unlock(event: React.FormEvent) {
    event.preventDefault();
    const entered = input.trim();
    if (!entered) return;
    localStorage.setItem(STORAGE_KEY, entered);
    setPassword(entered);
    setInput("");
    setAuthError("");
  }

  // The password is wrong or has been rotated — send the visitor back to unlock.
  function lockOut() {
    localStorage.removeItem(STORAGE_KEY);
    setPassword(null);
    setMessages([]);
    setAuthError("That password was not accepted. Try again.");
    setBusy(false);
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    const history: Message[] = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-chat-password": password ?? "",
      },
      body: JSON.stringify({ messages: history }),
    });

    if (response.status === 401) {
      lockOut();
      return;
    }

    if (!response.ok || !response.body) {
      const detail = await response.text();
      setMessages([...history, { role: "assistant", content: `Error: ${detail}` }]);
      setBusy(false);
      return;
    }

    // Append each streamed token to the last (assistant) message.
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let reply = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      reply += value;
      setMessages([...history, { role: "assistant", content: reply }]);
    }

    setBusy(false);
  }

  if (!ready) return null;

  if (!password) {
    return (
      <main className="chat">
        <h1>Chatbot</h1>
        <div className="thread">
          <p className="hint">This chatbot is password protected.</p>
          {authError && <p className="error">{authError}</p>}
        </div>
        <form onSubmit={unlock}>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Password"
            autoFocus
          />
          <button type="submit" disabled={!input.trim()}>
            Unlock
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="chat">
      <h1>Chatbot</h1>

      <div className="thread">
        {messages.length === 0 && <p className="hint">Say something to get started.</p>}
        {messages.map((message, i) => (
          <div key={i} className={`bubble ${message.role}`}>
            {message.content || "…"}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <form onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask anything"
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
