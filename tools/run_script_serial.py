"""在沙箱里串行跑仓库的 scripts/*.py（它们用 ProcessPoolExecutor 开子进程，
而本机沙箱禁止命名管道 → WinError 5）。这里把 ProcessPoolExecutor 换成一个
同步的上下文管理器替身，语义等价（map 顺序、返回值都一样），只是不并行。

用法：python run_script_serial.py <脚本路径> [脚本参数...]
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


class SerialPool:
    def __init__(self, *args, **kwargs) -> None:
        self.max_workers = 1

    def __enter__(self) -> SerialPool:
        return self

    def __exit__(self, *exc) -> bool:
        return False

    def map(self, fn, iterable, *args, **kwargs):  # noqa: A003 - 对齐 concurrent.futures 的接口名
        for item in iterable:
            yield fn(item)

    def submit(self, fn, /, *args, **kwargs):
        class _Done:
            def __init__(self, value):
                self._value = value

            def result(self):
                return self._value

        return _Done(fn(*args, **kwargs))

    def shutdown(self, *args, **kwargs) -> None:
        return None


def main() -> int:
    script = Path(sys.argv[1]).resolve()
    sys.argv = [str(script), *sys.argv[2:]]
    spec = importlib.util.spec_from_file_location(script.stem, script)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[script.stem] = mod
    spec.loader.exec_module(mod)
    mod.ProcessPoolExecutor = SerialPool  # type: ignore[attr-defined]
    return int(mod.main() or 0)


if __name__ == "__main__":
    sys.exit(main())
