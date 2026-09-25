#!/usr/bin/env python3
"""SiliconMate Local Agent - GLM SDK based.
Replaces free-code for the client-side lightweight Agent."""

import sys
import json
import os


def load_env():
    """Load GLM_API_KEY from .env or environment."""
    if os.environ.get("GLM_API_KEY"):
        return

    # Try .env in script directory, then parent directories
    search_paths = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
    ]
    for env_path in search_paths:
        env_path = os.path.normpath(env_path)
        if os.path.exists(env_path):
            for line in open(env_path):
                eq = line.find("=")
                if eq > 0:
                    k = line[:eq].strip()
                    v = line[eq+1:].strip()
                    if k and v:
                        os.environ[k] = v
            return

load_env()

from zhipuai import ZhipuAI

API_KEY = os.environ.get("GLM_API_KEY", "")
MODEL = os.environ.get("GLM_MODEL", "glm-4-flash")
MAX_TOKENS = int(os.environ.get("GLM_MAX_TOKENS", "4096"))

if not API_KEY:
    print(json.dumps({"type": "error", "error": "GLM_API_KEY not set"}))
    sys.exit(1)

client = ZhipuAI(api_key=API_KEY)


def chat(prompt: str, system: str = "You are a helpful assistant. Reply concisely.", history: list = None) -> dict:
    """Chat with GLM and return response."""
    messages = [{"role": "system", "content": system}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": prompt})

    resp = client.chat.completions.create(
        model=MODEL,
        messages=messages,
        max_tokens=MAX_TOKENS,
    )

    text = resp.choices[0].message.content if resp.choices else ""
    return {
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "model": MODEL,
        "stop_reason": "end_turn" if resp.choices[0].finish_reason == "stop" else "max_tokens",
        "usage": {
            "input_tokens": resp.usage.prompt_tokens if resp.usage else 0,
            "output_tokens": resp.usage.completion_tokens if resp.usage else 0,
        }
    }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        # CLI mode: local-agent.py "prompt"
        prompt = " ".join(sys.argv[1:])
        result = chat(prompt)
        print(json.dumps(result, ensure_ascii=False))
    else:
        # Stdin mode - free-code stream-json compatible output
        prompt = sys.stdin.read().strip()
        if not prompt:
            print(json.dumps({"type": "error", "error": "No prompt provided"}))
            sys.exit(1)

        result = chat(prompt)

        # Output in stream-json format (compatible with Tauri2 output filter)
        init = {"type": "system", "subtype": "init", "model": MODEL, "apiKeySource": "GLM_API_KEY"}
        print(json.dumps(init), flush=True)

        assistant = {"type": "assistant", "message": result}
        print(json.dumps(assistant, ensure_ascii=False), flush=True)

        final = {"type": "result", "result": result["content"][0]["text"], "duration_ms": 0}
        print(json.dumps(final, ensure_ascii=False), flush=True)
