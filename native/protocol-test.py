#!/usr/bin/python3
"""Exercise the real helper's live stdin pipe without observation or model calls."""

import argparse
import json
import os
from pathlib import Path
import selectors
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('application', type=Path)
    args = parser.parse_args()
    executable = args.application
    if executable.suffix == '.app':
        executable = executable / 'Contents' / 'MacOS' / 'QuietCompanion'
    process = subprocess.Popen(
        [str(executable), '--preview'], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
    )
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffered = bytearray()
    messages = []

    def wait_for(kind, identity=None, timeout=2):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for index, message in enumerate(messages):
                if message.get('type') == kind and (identity is None or message.get('id') == identity):
                    return messages.pop(index)
            ready = selector.select(max(0, deadline - time.monotonic()))
            if not ready:
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                raise AssertionError(f'Native helper closed stdout before {kind}.')
            buffered.extend(chunk)
            while b'\n' in buffered:
                line, _, remainder = buffered.partition(b'\n')
                buffered[:] = remainder
                if line.strip():
                    value = json.loads(line)
                    if isinstance(value, dict):
                        messages.append(value)
        raise AssertionError(f'No {kind}({identity}) within {timeout} seconds while stdin remained open.')

    def write(data):
        assert process.poll() is None, 'Native helper exited during live-pipe test.'
        assert not process.stdin.closed
        process.stdin.write(data)
        process.stdin.flush()

    try:
        wait_for('ready', timeout=15)
        tiny = b'{"type":"ping","id":"tiny"}\n'
        assert len(tiny) < 100
        started = time.monotonic()
        write(tiny)
        wait_for('pong', 'tiny')
        tiny_latency = time.monotonic() - started
        fragmented = b'{"type":"ping","id":"fragmented"}\n'
        write(fragmented[:12])
        time.sleep(0.1)
        started = time.monotonic()
        write(fragmented[12:])
        wait_for('pong', 'fragmented')
        fragmented_latency = time.monotonic() - started
        long_identity = 'x' * 256
        write((json.dumps({'type': 'ping', 'id': long_identity}) + '\n').encode())
        wait_for('pong', 'x' * 128)
        assert not process.stdin.closed and process.poll() is None
        print(json.dumps({
            'passed': True, 'stdin_open_during_checks': True,
            'tiny_bytes': len(tiny), 'tiny_latency_ms': round(tiny_latency * 1000, 2),
            'fragmented_latency_ms': round(fragmented_latency * 1000, 2),
            'bounded_echo_characters': 128,
        }))
    finally:
        try:
            if process.poll() is None:
                write(b'{"type":"shutdown"}\n')
                process.wait(timeout=5)
        except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
            process.kill()
            process.wait(timeout=5)
        finally:
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
            process.stdout.close()
            selector.close()


if __name__ == '__main__':
    main()
