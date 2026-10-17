# Windows Xbox Wireless reconnects

Source builds carry a narrow reconnect backport while keeping Strife's pinned
Mumble revision and dependency environment. Published downloads do not acquire
this change until a new native engine is built, packaged, validated and released.

## Behavior

On an affected Windows Xbox Wireless setup, a controller could work on its first
connection but shut off on input after reconnecting while Mumble was running.
The native shortcut backend queried XInput only while processing raw HID input,
and stopped querying when its raw-device count reached zero. Windows traces showed
final device removal deferred until input after the next connection.

The backport polls XInput independently of raw input, releases held shortcut
buttons on disconnect, and accepts reused packet numbers after reconnect.
Device removal is processed by the input worker, with queue wakeups coordinated
under a short-held mutex. Controller shortcuts remain enabled; Windows input
drivers and controller firmware are not changed.

## Backport provenance

The changes originate from these Mumble fork commits:

- `ed1a86f04edd5d269548181805f86998f441084e`: worker wakeup coordination.
- `21c9f7b062f0bb4b6ed69d42728ab79a6fa6a2c5`: worker-owned device removal.
- `d761e22a5f72054c75cb2c2051883cc1f14bacf7`: periodic XInput polling and tests.

See [the validated Mumble branch](https://github.com/M-ax/mumble/tree/fix/windows-xinput-reconnect)
and [the historical upstream report](https://github.com/mumble-voip/mumble/issues/2649).

`native/mumble-xinput-reconnect.patch` targets Mumble
`f1954599ec510a4eb894106f79631f7ff8f1b6a1`. That revision uses an older fixed-capacity
queue. The backport uses a mutex-protected `std::deque` rather than upgrading
Mumble's queue dependency: ordinary input is bounded, removal notifications stay
ordered, and input processing occurs outside the queue lock. It also retains the
pinned UTF-8 include and object-library test target.

## Validation

Run `pwsh -NoProfile -File tests/native-build.tests.ps1` to check native-input
fingerprinting, stale-payload rejection, and repeatable patch preparation.
Normal managed/web tests and package/startup checks still apply.

The patch includes Mumble's `TestXboxInput`. To run it after preparing the private
snapshot, enable `tests` in the native CMake build, build `TestXboxInput`, and run
`ctest -R '^TestXboxInput$' --output-on-failure` from that build directory.
Its fake backend checks state transitions and polling without raw HID events.

Also test the packaged Strife app with a physical controller. Close other Mumble
instances, retain XInput support and the normal Windows input drivers, and perform
at least five power-off/reconnect/input cycles without restarting Strife or the PC.
Confirm both continued connection and working input in Steam or a game. Merely
keeping the controller powered on without usable input is not a pass.
