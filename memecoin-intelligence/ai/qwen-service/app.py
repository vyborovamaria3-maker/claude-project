from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Literal

import torch
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

MODEL_ID = os.getenv("QWEN_MODEL_ID", "Qwen/Qwen2.5-7B-Instruct")
REVISION = os.getenv("QWEN_REVISION") or None
LOAD_MODE = os.getenv("QWEN_LOAD_MODE", "4bit").lower()
MAX_INPUT_TOKENS = int(os.getenv("QWEN_MAX_INPUT_TOKENS", "8192"))
MAX_OUTPUT_TOKENS = int(os.getenv("QWEN_MAX_OUTPUT_TOKENS", "1536"))
LAZY_LOAD = os.getenv("QWEN_LAZY_LOAD", "true").lower() in {"1", "true", "yes"}
HF_TOKEN = os.getenv("HF_TOKEN") or None
SERVICE_API_KEY = os.getenv("QWEN_SERVICE_API_KEY") or None


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage] = Field(min_length=1)
    temperature: float = Field(default=0.1, ge=0, le=1.5)
    max_tokens: int = Field(default=1024, ge=1, le=8192)
    stream: bool = False
    response_format: dict[str, Any] | None = None


class Runtime:
    def __init__(self) -> None:
        self.tokenizer: Any | None = None
        self.model: Any | None = None
        self.loaded_at: float | None = None
        self.load_error: str | None = None
        self.lock = asyncio.Lock()

    def load_sync(self) -> None:
        if self.model is not None:
            return
        if LOAD_MODE == "4bit" and not torch.cuda.is_available():
            raise RuntimeError(
                "QWEN_LOAD_MODE=4bit requires a CUDA-capable GPU. "
                "Use mock mode in the Node app or an external llama.cpp/OpenAI-compatible server on CPU."
            )

        tokenizer = AutoTokenizer.from_pretrained(
            MODEL_ID,
            revision=REVISION,
            token=HF_TOKEN,
            use_fast=True,
        )
        common: dict[str, Any] = {
            "revision": REVISION,
            "token": HF_TOKEN,
            "device_map": "auto",
            "low_cpu_mem_usage": True,
        }
        if LOAD_MODE == "4bit":
            compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
            common["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
                bnb_4bit_compute_dtype=compute_dtype,
            )
        elif LOAD_MODE == "bf16":
            common["torch_dtype"] = torch.bfloat16
        elif LOAD_MODE == "fp16":
            common["torch_dtype"] = torch.float16
        elif LOAD_MODE != "auto":
            raise RuntimeError(f"Unsupported QWEN_LOAD_MODE: {LOAD_MODE}")

        model = AutoModelForCausalLM.from_pretrained(MODEL_ID, **common).eval()
        if tokenizer.pad_token_id is None:
            tokenizer.pad_token_id = tokenizer.eos_token_id
        self.tokenizer = tokenizer
        self.model = model
        self.loaded_at = time.time()
        self.load_error = None

    async def ensure_loaded(self) -> None:
        if self.model is not None:
            return
        async with self.lock:
            if self.model is not None:
                return
            try:
                await asyncio.to_thread(self.load_sync)
            except Exception as exc:  # noqa: BLE001
                self.load_error = str(exc)
                raise

    def generate_sync(self, request: ChatRequest) -> tuple[str, int, int]:
        assert self.model is not None and self.tokenizer is not None
        messages = [message.model_dump() for message in request.messages]
        rendered = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        encoded = self.tokenizer(
            rendered,
            return_tensors="pt",
            truncation=True,
            max_length=MAX_INPUT_TOKENS,
        )
        device = next(self.model.parameters()).device
        encoded = {key: value.to(device) for key, value in encoded.items()}
        input_tokens = int(encoded["input_ids"].shape[-1])
        max_new_tokens = min(request.max_tokens, MAX_OUTPUT_TOKENS)
        do_sample = request.temperature > 0
        generation_args: dict[str, Any] = {
            **encoded,
            "max_new_tokens": max_new_tokens,
            "do_sample": do_sample,
            "repetition_penalty": 1.05,
            "pad_token_id": self.tokenizer.pad_token_id,
            "eos_token_id": self.tokenizer.eos_token_id,
        }
        if do_sample:
            generation_args["temperature"] = max(request.temperature, 1e-5)
            generation_args["top_p"] = 0.9
        generation = self.model.generate(**generation_args)
        output_ids = generation[0, input_tokens:]
        text = self.tokenizer.decode(output_ids, skip_special_tokens=True).strip()
        return text, input_tokens, int(output_ids.shape[-1])



def require_api_key(authorization: str | None) -> None:
    if SERVICE_API_KEY is None:
        return
    if authorization != f"Bearer {SERVICE_API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid inference service API key")


runtime = Runtime()
app = FastAPI(title="Qwen2.5 Telegram Inference", version="1.0.0")


@app.on_event("startup")
async def startup() -> None:
    if not LAZY_LOAD:
        await runtime.ensure_loaded()


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok" if runtime.load_error is None else "degraded",
        "model": MODEL_ID,
        "loadMode": LOAD_MODE,
        "loaded": runtime.model is not None,
        "loadedAt": runtime.loaded_at,
        "cudaAvailable": torch.cuda.is_available(),
        "cudaDevice": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "error": runtime.load_error,
    }


@app.get("/v1/models")
async def models(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_api_key(authorization)
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "Qwen"}]}


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_api_key(authorization)
    if request.stream:
        raise HTTPException(status_code=400, detail="Streaming is not enabled in this service")
    try:
        await runtime.ensure_loaded()
        started = time.perf_counter()
        async with runtime.lock:
            text, input_tokens, output_tokens = await asyncio.to_thread(runtime.generate_sync, request)
        return {
            "id": f"qwen-{int(time.time() * 1000)}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": MODEL_ID,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": input_tokens,
                "completion_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens,
                "latency_ms": (time.perf_counter() - started) * 1000,
            },
        }
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc
