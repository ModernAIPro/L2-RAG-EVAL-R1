"""A super simple terminal chatbot. Run: python chatbot.py  (Ctrl-C or 'exit' to quit)"""

import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

MODEL = os.getenv("MODEL", "Llama 3.2")

client = OpenAI()  # reads OPENAI_API_KEY and OPENAI_BASE_URL from .env

messages = [{"role": "system", "content": "You are a helpful, concise assistant."}]

print(f"Chatbot ready ({MODEL}). Type 'exit' to quit.\n")

while True:
    try:
        user = input("you> ").strip()
    except (EOFError, KeyboardInterrupt):
        break
    if not user:
        continue
    if user.lower() in {"exit", "quit"}:
        break

    messages.append({"role": "user", "content": user})

    print("bot> ", end="", flush=True)
    reply = ""
    for chunk in client.chat.completions.create(
        model=MODEL, messages=messages, stream=True
    ):
        if not chunk.choices:  # the proxy's final usage-only chunk
            continue
        piece = chunk.choices[0].delta.content or ""
        reply += piece
        print(piece, end="", flush=True)
    print("\n")

    messages.append({"role": "assistant", "content": reply})

print("\nbye.")
