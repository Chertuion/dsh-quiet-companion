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
        assert native_status.get('growthPanelVisible') is False
        assert native_status.get('petPanelWidth') == 320
        assert native_status.get('panelWithinVisibleScreen') is True
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
            snapshot_counter = 0

            def fresh_status():
                nonlocal snapshot_counter
                snapshot_counter += 1
                value = 0.80 + snapshot_counter / 1000
                write((json.dumps({'type': 'control', 'action': 'set-appearance',
                                   'opacity': value}) + '\n').encode())
                return wait_for('native-status', predicate=lambda state:
                                abs(state.get('opacity', 0) - value) < 0.00001)

            def positions(state):
                points = state.get('snackPositions')
                assert state.get('snackLayout') == 'around-character'
                assert isinstance(points, list) and len(points) == 8
                assert len({point['slot'] for point in points}) == 8
                assert sum(point['x'] < 160 for point in points) == 4
                assert sum(point['x'] > 160 for point in points) == 4
                for point in points:
                    assert 0 <= point['x'] and point['x'] + point['width'] <= 320
                    assert 0 <= point['y'] and point['y'] + point['height'] < 275
                return {point['id']: (point['slot'], point['x'], point['y'],
                                      point['width'], point['height']) for point in points}

            snacks = [{'id': f'qa-snack-{index}', 'kind': ['mantou', 'lamian', 'dianxin', 'cake'][index % 4],
                       'nutrition': 8, 'createdAt': index} for index in range(10)]
            growth = {'level': 1, 'experience': 18, 'nextLevelExperience': 100,
                      'satiety': 45, 'energy': 76, 'mood': 83, 'stage': '幼年期',
                      'stats': {'earnedSnacks': 12, 'eatenSnacks': 0},
                      'snackCount': 12, 'snacks': snacks, 'status': '等待进食决定'}
            initial = {'type': 'growth', 'state': growth,
                       'event': {'id': 'qa-spawn', 'type': 'snack-spawned',
                                 'snackId': 'qa-snack-0', 'kind': 'mantou'}}
            write((json.dumps(initial) + '\n').encode())
            hidden = wait_for('native-status', predicate=lambda state: len(state.get('snackPositions', [])) == 8)
            assert hidden.get('growthPanelVisible') is False and hidden.get('petPanelWidth') == 320
            assert hidden.get('growthBadgeVisible') is False and hidden.get('inventoryLabelVisible') is False
            assert hidden.get('snackArrivalCount') == 0, 'Old startup inventory must stay still.'
            initial_positions = positions(hidden)

            # Exercise the actual menu's shared action; it emits only an appearance patch.
            write(b'{"type":"control","action":"preview-place-at-right-edge"}\n')
            write(b'{"type":"control","action":"toggle-growth-panel"}\n')
            patch = wait_for('settings', predicate=lambda state: state.get('growthPanelVisible') is True)
            assert set(patch) == {'type', 'growthPanelVisible'}, 'Menu must preserve other growth settings.'
            shown = wait_for('native-status', predicate=lambda state: state.get('growthPanelVisible') is True)
            assert shown.get('petPanelWidth') == 420
            assert shown.get('panelWithinVisibleScreen') is True, 'Expanded sidebar must remain on screen.'
            assert shown.get('growthBadgeVisible') is True and shown.get('inventoryLabelVisible') is True
            assert positions(shown) == initial_positions
            write(b'{"type":"settings","settings":{"growthPanelVisible":false}}\n')
            hidden = wait_for('native-status', predicate=lambda state:
                              state.get('growthPanelVisible') is False and state.get('petPanelWidth') == 320)
            assert positions(hidden) == initial_positions
            assert hidden.get('panelWithinVisibleScreen') is True

            growth['snacks'] = snacks[1:]
            growth['snackCount'] = 11
            growth['stats']['eatenSnacks'] = 1
            eaten = {'type': 'growth', 'state': growth,
                     'event': {'id': 'qa-eaten', 'type': 'snack-eaten',
                               'snackId': 'qa-snack-0', 'kind': 'mantou'}}
            write((json.dumps(eaten) + '\n').encode())
            wait_for('native-status', predicate=lambda state: state.get('snackEatingActive') is True)
            write((json.dumps(eaten) + '\n').encode())
            # Change scale/sidebar during the real preview flight; no inventory echo is allowed.
            write(b'{"type":"control","action":"set-appearance","scale":1.2}\n')
            write(b'{"type":"settings","settings":{"growthPanelVisible":true}}\n')
            resized = wait_for('native-status', predicate=lambda state:
                               abs(state.get('scale', 0) - 1.2) < 0.001 and state.get('growthPanelVisible') is True)
            assert resized.get('panelWithinVisibleScreen') is True, 'Scaled panel must remain on screen.'
            for identity, prior in initial_positions.items():
                if identity != 'qa-snack-0':
                    assert all(abs(left - right) < 0.00001 for left, right in zip(positions(resized)[identity], prior))
            write(b'{"type":"settings","settings":{"growthPanelVisible":false}}\n')
            wait_for('native-status', predicate=lambda state: state.get('snackEatingActive') is False, timeout=3)

            new_snack = {'id': 'qa-new-snack', 'kind': 'cake', 'nutrition': 8, 'createdAt': 20}
            growth['snacks'] = [new_snack, *snacks[1:]]
            growth['snackCount'] = 12
            spawned = {'type': 'growth', 'state': growth,
                       'event': {'id': 'qa-new-spawn', 'type': 'snack-spawned',
                                 'snackId': 'qa-new-snack', 'kind': 'cake'}}
            write((json.dumps(spawned) + '\n').encode())
            wait_for('native-status', predicate=lambda state: state.get('snackArrivalCount') == 1)
            write((json.dumps(spawned) + '\n').encode())
            spawned['event']['id'] = 'qa-new-spawn-again'
            write((json.dumps(spawned) + '\n').encode())
            assert fresh_status().get('snackArrivalCount') == 1, 'Duplicate snapshots must not restart arrival.'
            batch_snacks = [{'id': 'qa-batch-a', 'kind': 'mantou', 'createdAt': 30},
                            {'id': 'qa-batch-b', 'kind': 'dianxin', 'createdAt': 31}]
            growth['snacks'] = [*batch_snacks, *growth['snacks']]
            growth['snackCount'] += 2
            batch = {'type': 'growth', 'state': growth,
                     'event': {'id': 'qa-batch-spawn', 'type': 'snack-spawned',
                               'snackId': 'qa-batch-b', 'kind': 'dianxin'}}
            write((json.dumps(batch) + '\n').encode())
            batched = wait_for('native-status', predicate=lambda state: state.get('snackArrivalCount') == 3)
            assert {'qa-batch-a', 'qa-batch-b'} <= positions(batched).keys()
            write((json.dumps(batch) + '\n').encode())
            assert fresh_status().get('snackArrivalCount') == 3, 'Batch replay must not restart arrivals.'
            write(b'{"type":"settings","settings":{"reduceMotion":true}}\n')
            growth['snacks'] = [{'id': 'qa-still-snack', 'kind': 'mantou', 'createdAt': 21}, *snacks[1:]]
            write((json.dumps({'type': 'growth', 'state': growth,
                               'event': {'id': 'qa-still-spawn', 'type': 'snack-spawned',
                                         'snackId': 'qa-still-snack', 'kind': 'mantou'}}) + '\n').encode())
            still = fresh_status()
            assert still.get('snackArrivalCount') == 3, 'Reduced motion must not animate arrival.'
            positions(still)
            growth['level'] = 2
            growth['experience'] = 0
            write((json.dumps({'type': 'growth', 'state': growth,
                               'event': {'id': 'qa-level', 'type': 'level-up'}}) + '\n').encode())
            write(b'{"type":"control","action":"sleep"}\n')
            wait_for('native-status', predicate=lambda state: state.get('petSleeping') is True)
            write(b'{"type":"control","action":"wake"}\n')
            wait_for('native-status', predicate=lambda state: state.get('petSleeping') is False)
            assert not any(item.get('type') == 'snack-offer' for item in messages)
            assert not any(item.get('type') == 'settings' for item in messages), 'Host settings must not echo.'
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
            'growth_snapshot_eat_level_replay_safe': args.launch_services,
            'snacks_around_character_stable': args.launch_services,
            'growth_panel_hidden_by_default_and_toggle_safe': args.launch_services,
            'arrival_events_deduplicated_and_reduced_motion_safe': args.launch_services,
            'eating_resize_and_sidebar_toggle_safe': args.launch_services,
            'batch_spawn_two_arrivals_and_replay_safe': args.launch_services,
            'panel_clamped_after_sidebar_and_scale': args.launch_services,
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
