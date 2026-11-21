"""``python -m qlint_kernel``: run the kernel (as Jupyter does, with ``-f``),
or ``install`` its kernel spec.

    python -m qlint_kernel install [--user | --sys-prefix | --prefix DIR]
        [--name NAME] [--display-name TEXT] [--replace]
        [--connect HOST:PORT [--user-name USER] | --q "Q COMMAND LINE"]
        [--console-size ROWS COLS] [--env NAME=VALUE]...

With neither ``--connect`` nor ``--q``, each kernel starts its own ``q``
from PATH. A password is never an argument: the kernel reads
``QLINT_Q_PASSWORD`` from its environment. An existing kernel spec of the
same name is replaced only with ``--replace``.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from pathlib import Path

NAME = "q-lint"
DISPLAY = "q (q-lint)"


def _process_options(parser: argparse.ArgumentParser) -> None:
    where = parser.add_mutually_exclusive_group()
    where.add_argument("--connect", metavar="HOST:PORT", help="run cells on this q process")
    where.add_argument("--q", metavar="COMMAND", help='start this q for each kernel (a command line, e.g. "q" or "env QHOME=~/q ~/q/m64/q")')
    parser.add_argument("--user-name", metavar="USER", help="the user for --connect; the password comes from QLINT_Q_PASSWORD")
    parser.add_argument("--console-size", nargs=2, type=int, metavar=("ROWS", "COLS"), default=[100, 200], help="the size results are formatted at (100 200)")


def user_data_dir() -> Path:
    if os.environ.get("JUPYTER_DATA_DIR"):
        return Path(os.environ["JUPYTER_DATA_DIR"])
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Jupyter"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home())) / "jupyter"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "jupyter"


def kernel_spec(args: argparse.Namespace) -> dict:
    argv = [sys.executable, "-m", "qlint_kernel", "-f", "{connection_file}"]
    if args.connect:
        argv += ["--connect", args.connect]
    if args.q:
        argv += ["--q", args.q]
    if args.user_name:
        argv += ["--user-name", args.user_name]
    argv += ["--console-size", *map(str, args.console_size)]
    env = {}
    for pair in args.env or []:
        key, sep, value = pair.partition("=")
        if not sep or not key:
            raise SystemExit(f"qlint_kernel: --env takes NAME=VALUE, not {pair!r}")
        env[key] = value
    return {
        "argv": argv,
        "display_name": args.display_name,
        "language": "q",
        "interrupt_mode": "message",
        **({"env": env} if env else {}),
        "metadata": {"debugger": False},
    }


def install(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m qlint_kernel install", description="Install the q-lint q kernel's spec for Jupyter.")
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--user", action="store_true", help="for this user (the default)")
    target.add_argument("--sys-prefix", action="store_true", help="in this Python environment")
    target.add_argument("--prefix", metavar="DIR", help="under DIR/share/jupyter")
    parser.add_argument("--name", default=NAME, help=f"the kernel's name ({NAME})")
    parser.add_argument("--display-name", default=DISPLAY, help=f"its name in Jupyter ({DISPLAY})")
    parser.add_argument("--replace", action="store_true", help="replace a kernel spec of the same name")
    parser.add_argument("--env", action="append", metavar="NAME=VALUE", help="an environment variable for the kernel and the q it starts (QHOME, QLIC)")
    _process_options(parser)
    args = parser.parse_args(argv)
    base = Path(sys.prefix) / "share" / "jupyter" if args.sys_prefix else Path(args.prefix) / "share" / "jupyter" if args.prefix else user_data_dir()
    folder = base / "kernels" / args.name
    spec = kernel_spec(args)
    target_file = folder / "kernel.json"
    text = json.dumps(spec, indent=1) + "\n"
    if target_file.exists() and target_file.read_text() != text and not args.replace:
        print(f"qlint_kernel: {target_file} exists and differs; pass --replace to replace it.", file=sys.stderr)
        return 1
    folder.mkdir(parents=True, exist_ok=True)
    target_file.write_text(text)
    print(f"Installed the q kernel {args.name!r} in {folder}")
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["install"]:
        return install(argv[1:])
    parser = argparse.ArgumentParser(prog="python -m qlint_kernel", description="A Jupyter kernel for q (run by Jupyter; `install` installs it).")
    parser.add_argument("-f", dest="connection_file", required=True, help="the connection file Jupyter gives")
    _process_options(parser)
    args = parser.parse_args(argv)
    from .kernel import run

    run(args.connection_file, args.connect, shlex.split(args.q) if args.q else None, args.user_name, tuple(args.console_size))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
