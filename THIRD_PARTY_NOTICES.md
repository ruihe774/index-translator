# Third-party notices

## libopus

- `src/` is a port of the libopus SILK encoder (and the parts of CELT and the Opus layer it
  uses) and is a derivative work of libopus.
- `third_party/opus` is a git submodule of upstream libopus (https://github.com/xiph/opus,
  tag `v1.6.1`), used only by the tests (`test/build-native.sh`).

License: BSD-3-Clause, reproduced from libopus `COPYING`:

```
Copyright 2001-2023 Xiph.Org, Skype Limited, Octasic,
                    Jean-Marc Valin, Timothy B. Terriberry,
                    CSIRO, Gregory Maxwell, Mark Borgerding,
                    Erik de Castro Lopo, Mozilla, Amazon

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

- Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

- Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

- Neither the name of Internet Society, IETF or IETF Trust, nor the
names of specific contributors, may be used to endorse or promote
products derived from this software without specific prior written
permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER
OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Opus is subject to the royalty-free patent licenses which are
specified at:

Xiph.Org Foundation:
https://datatracker.ietf.org/ipr/1524/

Microsoft Corporation:
https://datatracker.ietf.org/ipr/1914/

Broadcom Corporation:
https://datatracker.ietf.org/ipr/1526/
```

## Speech recordings (`test/audio/*.wav`)

The ALSA `speaker-test` voice prompts (`Front_Left.wav`, `Front_Center.wav`, ..., `Noise.wav`)
from alsa-utils (https://github.com/alsa-project/alsa-utils, `speaker-test/samples/`), taken
from the Ubuntu package alsa-utils 1.2.15.2-1ubuntu1.

- Copyright: 1998-2026 Jaroslav Kysela and others (as stated for the package in its Debian
  `copyright` file; upstream gives no per-file statement for the recordings).
- License: GPL-2.0; the full text is in `LICENSES/GPL-2.0.txt`.
- Modifications: converted from 48 kHz to 16 kHz mono 16-bit PCM with FFmpeg 8.0.1, with
  metadata stripped.

They are test inputs only and are not part of any minisilk build.
