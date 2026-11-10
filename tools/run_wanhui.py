"""提交一条「点击回应-元气挥手」的 Wan2.2 Fun-Control 任务到本机 ComfyUI，并轮询进度。

用法：
  python run_wanhui.py --control depth --end 0.65 --steps 25 --cfg 3.5 --prefix wanhui_depth_e65
  python run_wanhui.py --control pose  --end 1.0  --steps 25 --cfg 3.5 --prefix wanhui_pose
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:8188"

POSITIVE = (
    "Q版橘发猫耳女仆，橘色长卷发，猫耳，深色女仆装搭配白色蕾丝围裙，橘色条纹猫尾。"
    "她抬起一只手轻快地向观众挥手打招呼，身体随之轻轻起伏，猫尾左右摆动，表情元气可爱，动作流畅自然。"
    "背景是纯净的亮绿色绿幕，角色轮廓清晰，没有地面阴影。"
)

NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，画面杂乱，低质量，脸部变形，多余的手指，"
    "多余的手臂，多个人物，背景不是纯绿色，文字，水印"
)


def build(args) -> dict:
    w, h, n = args.width, args.height, args.frames
    if args.control == "depth":
        control = {
            "class_type": "DepthAnythingPreprocessor",
            "inputs": {
                "image": ["7", 0],
                "ckpt_name": "depth_anything_vitl14.pth",
                "resolution": 1024,
            },
        }
    else:
        control = {
            "class_type": "DWPreprocessor",
            "inputs": {
                "image": ["7", 0],
                "detect_hand": "enable",
                "detect_body": "enable",
                "detect_face": "enable",
                "resolution": 1024,
                "bbox_detector": "yolox_l.torchscript.pt",
                "pose_estimator": "dw-ll_ucoco_384_bs5.torchscript.pt",
                "scale_stick_for_xinsr_cn": "disable",
            },
        }
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": "cat_ref_green.png"}},
        "2": {
            "class_type": "WanVideoVAELoader",
            "inputs": {"model_name": "Wan2_2_VAE_bf16.safetensors", "precision": "bf16"},
        },
        "3": {
            "class_type": "LoadWanVideoT5TextEncoder",
            "inputs": {
                "model_name": "umt5-xxl-enc-fp8_e4m3fn.safetensors",
                "precision": "bf16",
                "load_device": "offload_device",
                "quantization": "fp8_e4m3fn",
            },
        },
        "4": {
            "class_type": "WanVideoTextEncode",
            "inputs": {
                "positive_prompt": args.positive or POSITIVE,
                "negative_prompt": NEGATIVE,
                "t5": ["3", 0],
                "force_offload": True,
                "device": "gpu",
            },
        },
        "5": {
            "class_type": "WanVideoModelLoader",
            "inputs": {
                "model": "Wan2.2-Fun-5B-Control-Q4_K_M.gguf",
                "base_precision": "bf16",
                "quantization": "disabled",
                "load_device": "offload_device",
                "attention_mode": "sdpa",
            },
        },
        "6": {"class_type": "LoadVideo", "inputs": {"file": args.video}},
        "6b": {"class_type": "GetVideoComponents", "inputs": {"video": ["6", 0]}},
        "7": {
            "class_type": "ImageFromBatch",
            "inputs": {"image": ["6b", 0], "batch_index": args.skip, "length": n},
        },
        "8": control,
        "9": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["8", 0],
                "upscale_method": "lanczos",
                "width": w,
                "height": h,
                "crop": "center",
            },
        },
        "10": {
            "class_type": "WanVideoEncode",
            "inputs": {
                "vae": ["2", 0],
                "image": ["9", 0],
                "enable_vae_tiling": False,
                "tile_x": 272,
                "tile_y": 272,
                "tile_stride_x": 144,
                "tile_stride_y": 128,
            },
        },
        "11": {
            "class_type": "WanVideoImageToVideoEncode",
            "inputs": {
                "vae": ["2", 0],
                "width": w,
                "height": h,
                "num_frames": n,
                "noise_aug_strength": 0.0,
                "start_latent_strength": 1.0,
                "end_latent_strength": 1.0,
                "force_offload": True,
                "start_image": ["1", 0],
                "fun_or_fl2v_model": True,
            },
        },
        "12": {
            "class_type": "WanVideoAddControlEmbeds",
            "inputs": {
                "embeds": ["11", 0],
                "latents": ["10", 0],
                "start_percent": 0.0,
                "end_percent": args.end,
            },
        },
        "13": {
            "class_type": "WanVideoSampler",
            "inputs": {
                "model": ["5", 0],
                "image_embeds": ["12", 0],
                "text_embeds": ["4", 0],
                "steps": args.steps,
                "cfg": args.cfg,
                "shift": args.shift,
                "seed": args.seed,
                "force_offload": True,
                "scheduler": "unipc",
                "riflex_freq_index": 0,
            },
        },
        "14": {
            "class_type": "WanVideoDecode",
            "inputs": {
                "vae": ["2", 0],
                "samples": ["13", 0],
                "enable_vae_tiling": False,
                "tile_x": 272,
                "tile_y": 272,
                "tile_stride_x": 144,
                "tile_stride_y": 128,
                "normalization": "default",
            },
        },
        "15": {
            "class_type": "SaveImage",
            "inputs": {"images": ["14", 0], "filename_prefix": args.prefix},
        },
    }


def post(url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get(url: str):
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=81)
    ap.add_argument("--skip", type=int, default=0)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--cfg", type=float, default=4.0)
    ap.add_argument("--shift", type=float, default=5.0)
    ap.add_argument("--end", type=float, default=1.0, help="control embeds 结束百分比")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--width", type=int, default=832)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--control", choices=["depth", "pose"], default="depth")
    ap.add_argument("--video", default="wanhui.mp4")
    ap.add_argument("--positive", default="")
    ap.add_argument("--prefix", default="wanhui_cat")
    args = ap.parse_args()

    prompt = build(args)
    try:
        res = post(API + "/prompt", {"prompt": prompt, "client_id": "dsh-pet-runner"})
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "ignore")
        print("提交失败:", exc.code, body[:2000], flush=True)
        return 2
    pid = res["prompt_id"]
    print(
        "已提交 prompt_id =", pid,
        "| control", args.control, "| end", args.end,
        "| 分辨率", args.width, "x", args.height, "| 帧数", args.frames,
        flush=True,
    )

    started = time.time()
    last = None
    while True:
        time.sleep(5)
        hist = get(API + "/history/" + pid)
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {})
            print("完成，用时 %.1f 分钟" % ((time.time() - started) / 60), flush=True)
            if status.get("status_str") == "error":
                for m in status.get("messages", []):
                    print("ERR:", json.dumps(m, ensure_ascii=False)[:1500])
                return 3
            outs = entry.get("outputs", {})
            for node_id, out in outs.items():
                if node_id == "15":
                    print("输出帧数", len(out.get("images", [])))
            return 0
        q = get(API + "/queue")
        running = [x[2] for x in q.get("queue_running", [])]
        state = "生成中" if pid in running else "排队中"
        if state != last:
            print("[%5.1f min] %s" % ((time.time() - started) / 60, state), flush=True)
            last = state
        if (time.time() - started) > 3 * 3600:
            print("超时退出", flush=True)
            return 4


if __name__ == "__main__":
    sys.exit(main())
