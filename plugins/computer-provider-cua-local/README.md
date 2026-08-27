# Local Computer provider

Runs the user's shared bot computer locally through Cua Sandbox. The default is a persistent Linux VM, so bot actions stay outside the host desktop while files, browser state, and logins survive reconnects and suspension.

## Setup

Install Python 3.12+, QEMU, and Cua Sandbox:

```bash
python3 -m pip install --upgrade 'cua-sandbox>=0.4.3' cua
# macOS
brew install qemu
```

On Linux or Windows, install QEMU with the platform package manager instead.

Use Plugins → Local Computer to select the Python environment. Container mode is faster but weaker isolation; VM mode is the default.

The pinned Linux desktop currently published by Cua is x86_64. Recursive selects
that disk explicitly on Apple Silicon and runs it through QEMU software emulation;
the first download is large and startup is slower than on an x86_64 host. This
avoids Cua Sandbox 0.4.3's unimplemented ARM Linux base-image builder. Docker is
only required when Full virtual machine is disabled.
