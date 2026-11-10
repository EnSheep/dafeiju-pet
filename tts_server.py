"""本机 Qwen3-TTS 服务：给桌宠提供「克隆音色」的 mp3。

启动（桌宠那边的 `启动桌宠.cmd` 会自动拉起来，也可手动跑）：

    .qwen-tts\\venv\\Scripts\\python.exe cat-pet\\tts_server.py

接口：
    GET  /health          -> {"ok":true,"ref":"烦死你了","model":"..."}
    POST /tts {"text":...} -> audio/mpeg

为什么单独起一个进程：模型加载要 2.5 秒、建克隆 prompt 要 15 秒，
每次合成重来一遍没法用；驻留进程后每句只剩推理时间。
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, ".qwen-tts", "models", "Qwen3-TTS-12Hz-0.6B-Base")
REF_WAV = os.path.join(ROOT, "samples", "refs", "烦死你了.wav")
REF_TEXT = "烦死你了"
HOST = "127.0.0.1"
PORT = int(os.environ.get("DSH_PET_TTS_PORT", "8765"))
MAX_CHARS = 300
MP3_KBPS = 128

_state = {"model": None, "prompt": None, "ref": REF_TEXT, "lock": threading.Lock()}

_LOG = {"fh": None}


def log(msg):
    fh = _LOG["fh"]
    line = f"[tts] {msg}"
    if fh is not None:
        fh.write(line + "\n")
        fh.flush()
        return
    try:
        print(line, flush=True)
    except Exception:  # stdout 可能是 None（无控制台启动）
        pass


def load():
    import torch
    from qwen_tts import Qwen3TTSModel

    t0 = time.time()
    model = Qwen3TTSModel.from_pretrained(
        MODEL, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa"
    )
    log(f"模型就绪 {time.time() - t0:.1f}s")
    t0 = time.time()
    prompt = model.create_voice_clone_prompt(
        ref_audio=REF_WAV, ref_text=REF_TEXT, x_vector_only_mode=False
    )
    log(f"音色就绪 {time.time() - t0:.1f}s  ref={os.path.basename(REF_WAV)}")
    _state["model"] = model
    _state["prompt"] = prompt


def synthesize(text):
    import lameenc
    import numpy as np
    import torch

    text = text.strip()
    if not text:
        raise ValueError("empty text")
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS]

    # 12Hz：约 4.2 个 token/字；给 30 个 token 余量，最少 60、最多 900
    max_tokens = max(60, min(900, int(len(text) * 4.2) + 30))
    with _state["lock"]:
        wavs, sr = _state["model"].generate_voice_clone(
            text=text,
            language="Chinese",
            voice_clone_prompt=_state["prompt"],
            do_sample=True,
            temperature=0.9,
            top_k=50,
            top_p=1.0,
            repetition_penalty=1.05,
            max_new_tokens=max_tokens,
        )
    wav = np.asarray(wavs[0], dtype=np.float32)
    pcm = np.clip(wav, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype(np.int16)

    enc = lameenc.Encoder()
    enc.set_bit_rate(MP3_KBPS)
    enc.set_in_sample_rate(sr)
    enc.set_channels(1)
    enc.set_quality(2)
    mp3 = bytes(enc.encode(pcm16.tobytes()) + enc.flush())
    del torch
    return mp3, len(wav) / sr


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静点，只留关键行
        return

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(
                200,
                {
                    "ok": _state["prompt"] is not None,
                    "ref": _state["ref"],
                    "refFile": os.path.basename(REF_WAV),
                    "model": os.path.basename(MODEL),
                },
            )
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/tts":
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
            text = str(payload.get("text") or "")
            t0 = time.time()
            mp3, dur = synthesize(text)
            log(f"synth {len(text)}字 -> {dur:.2f}s 音频, {len(mp3)}B, {time.time() - t0:.1f}s")
            self.send_response(200)
            self.send_header("content-type", "audio/mpeg")
            self.send_header("content-length", str(len(mp3)))
            self.end_headers()
            self.wfile.write(mp3)
        except Exception as error:  # noqa: BLE001 - 服务不因单次失败退出
            log(f"失败 {type(error).__name__}: {error}")
            self._json(500, {"error": f"{type(error).__name__}: {error}"})


def main():
    # 自己接管日志：要脱离父进程启动（cmd start），拿不到重定向的 stdout
    log_path = os.path.join(ROOT, "cat-pet", "tts-server.log")
    fh = open(log_path, "a", encoding="utf-8", buffering=1)
    _LOG["fh"] = fh
    sys.stdout = fh
    sys.stderr = fh

    if not os.path.exists(REF_WAV):
        log(f"缺少参考音频 {REF_WAV}")
        sys.exit(2)
    log(f"--- 启动 {time.strftime('%Y-%m-%d %H:%M:%S')} ---")
    log(f"加载中 ... ref={os.path.basename(REF_WAV)}")
    load()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"就绪 http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
