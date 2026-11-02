#!/usr/bin/python3
"""Exercise live stdin or LaunchServices + private UDS without capture/model calls."""

import argparse
import json
import os
from pathlib import Path
import secrets
import selectors
import shutil
import signal
import socket
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('application', type=Path)
    parser.add_argument('--launch-services', action='store_true')
    args = parser.parse_args()
    executable = args.application
    if executable.suffix == '.app':
        executable = executable / 'Contents' / 'MacOS' / 'QuietCompanion'

    ipc_dir = None
    listener = None
    channel = None
    native_pid = None
    token = None
    process = None
    selector = selectors.DefaultSelector()
    buffered = bytearray()
    messages = []

    def write(data):
        assert process.poll() is None, 'Launcher/helper exited during live transport test.'
        if channel is not None:
            channel.sendall(data)
        else:
            assert not process.stdin.closed
            process.stdin.write(data)
            process.stdin.flush()

    def wait_for(kind, identity=None, timeout=2, predicate=None):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for index, message in enumerate(messages):
                if (message.get('type') == kind
                        and (identity is None or message.get('id') == identity)
                        and (predicate is None or predicate(message))):
                    return messages.pop(index)
            ready = selector.select(max(0, deadline - time.monotonic()))
            if not ready:
                continue
            read_fd = channel.fileno() if channel is not None else process.stdout.fileno()
            chunk = os.read(read_fd, 65536)
            if not chunk:
                raise AssertionError(f'Helper closed transport before {kind}.')
            buffered.extend(chunk)
            while b'\n' in buffered:
                line, _, remainder = buffered.partition(b'\n')
                buffered[:] = remainder
                if line.strip():
                    value = json.loads(line)
                    if isinstance(value, dict):
                        messages.append(value)
        raise AssertionError(f'No {kind}({identity}) within {timeout}s with transport open.')

    try:
        if args.launch_services:
            assert args.application.suffix == '.app', 'LaunchServices test requires an .app bundle.'
            ipc_dir = Path(tempfile.mkdtemp(prefix='qc-native-test-', dir='/private/tmp'))
            os.chmod(ipc_dir, 0o700)
            endpoint = ipc_dir / 'bridge.sock'
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(endpoint))
            os.chmod(endpoint, 0o600)
            listener.listen(1)
            listener.settimeout(15)
            token = secrets.token_urlsafe(24)
            process = subprocess.Popen([
                '/usr/bin/open', '-n', '-W', '-g', '--stderr', '/dev/null',
                str(args.application), '--args', '--preview',
                '--ipc-socket', str(endpoint), '--ipc-token', token,
            ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            channel, _ = listener.accept()
            selector.register(channel, selectors.EVENT_READ)
        else:
            process = subprocess.Popen(
                [str(executable), '--preview'], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
            )
            selector.register(process.stdout, selectors.EVENT_READ)

        ready = wait_for('ready', timeout=15)
        native_pid = ready.get('pid')
        if args.launch_services:
            assert ready.get('ipcToken') == token, 'Private socket token mismatch.'
            assert isinstance(native_pid, int) and native_pid > 1
            assert native_pid != process.pid
            assert ready.get('parentPid') != os.getpid(), 'App was directly spawned instead of using LaunchServices.'
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
        write((json.dumps({'type': 'ping', 'id': 'x' * 256}) + '\n').encode())
        wait_for('pong', 'x' * 128)

        native_status = wait_for('native-status')
        assert native_status.get('preview') is True
        assert native_status.get('screenAuthorized') is False
        assert native_status.get('audioAuthorized') is False
        assert isinstance(native_status.get('voices'), list)
        assert native_status.get('usingSocketTransport') is args.launch_services
        if args.launch_services:
            write(b'{"type":"control","action":"set-appearance","scale":1.05,"opacity":0.93}\n')
            wait_for('native-status', predicate=lambda value:
                     abs(value.get('scale', 0) - 1.05) < 0.001 and abs(value.get('opacity', 0) - 0.93) < 0.001)
            write(b'{"type":"control","action":"enable-system-audio"}\n')
            audio_status = wait_for('native-status', predicate=lambda value: '界面预览' in value.get('audioStatus', ''))
            assert audio_status.get('audioEnabled') is False
            assert audio_status.get('permissionRequestInFlight') is False
            write(b'{"type":"control","action":"mouse-play"}\n')
            mouse_status = wait_for('native-status', predicate=lambda value: '预览' in value.get('mouseStatus', ''))
            assert mouse_status.get('mousePlayActive') is False
            assert mouse_status.get('mouseAuthorized') is False
        assert process.poll() is None
        print(json.dumps({
            'passed': True, 'transport': 'launch-services-uds' if args.launch_services else 'stdin',
            'transport_open_during_checks': True,
            'tiny_bytes': len(tiny), 'tiny_latency_ms': round(tiny_latency * 1000, 2),
            'fragmented_latency_ms': round(fragmented_latency * 1000, 2),
            'bounded_echo_characters': 128,
            'authenticated_ready': bool(token and ready.get('ipcToken') == token),
            'native_parent_pid': ready.get('parentPid'),
            'preview_audio_enable_stayed_off': args.launch_services,
            'preview_pointer_play_no_warp': args.launch_services,
        }))
    finally:
        try:
            if process is not None and process.poll() is None:
                write(b'{"type":"shutdown"}\n')
                process.wait(timeout=5)
        except (AssertionError, BrokenPipeError, OSError, subprocess.TimeoutExpired):
            if channel is not None:
                channel.close()
                channel = None
            if native_pid is not None:
                try:
                    os.kill(native_pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
        finally:
            if channel is not None:
                channel.close()
            if listener is not None:
                listener.close()
            if process is not None:
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()
                if process.stdout:
                    process.stdout.close()
            selector.close()
            if ipc_dir is not None:
                shutil.rmtree(ipc_dir)


if __name__ == '__main__':
    main()
