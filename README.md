# bc250-bios-modder-online

Reads and edits AMD BC-250 BIOS images: the two menu colour palettes and the
boot logo. No vendor tools, no backend, runs in a browser or in node.

There is a hosted UI built on this: **https://gabriwar.xyz/bc250** — drop a ROM
in, pick a colour, swap the logo, download the result. Nothing is uploaded.

## Read this first

You are modding a BIOS at your own risk. A power cut mid-flash or the wrong
board revision leaves the machine dead until you reflash the chip externally.
Do not do this without a hardware programmer on hand.

## What it does

A BC-250 image keeps its DXE volume LZMA-compressed inside an outer firmware
volume. Everything interesting lives in there:

```
ROM
 └ outer FV
    └ file 9E21FD93...
       └ GUID-defined section (LZMA)
          └ volume image section
             └ inner DXE FV
                ├ GraphicsConsole -> PE32   screen palette
                ├ HiiDatabase     -> PE32   popup palette
                └ Logo            -> raw    boot splash
```

**Colour** on this BIOS is an EFI attribute byte, `(bg << 4) | fg`, where each
nibble indexes a 16-entry BGRA table. There are two such tables and they are
independent: `GraphicsConsole` paints the Setup screen, `HiiDatabase` paints the
popups. Both ship the same blue, so recolouring one leaves half the BIOS
untouched. `setColorEverywhere` writes both.

The palettes are found by shape, not by their stock colours. Matching known
values only works on a virgin image; once repainted, a content-based search goes
blind to its own output.

**The logo** sits under a second LZMA layer inside its own file, so a plain scan
of raw sections walks straight past it. Both PNG and JPEG are read, and
`Logo.format` tells you which the image carries. Write back the same one: each
board only carries the decoder for the format it shipped with.

## What is in here

```
src/         the parser. plain TypeScript, no framework, runs anywhere
ui/          the actual page from gabriwar.xyz/bc250, verbatim
examples/    a CLI that recolours and swaps the logo from node
```

`src/` and `ui/` are byte-for-byte what the hosted site runs, not a
reimplementation. The `ui/` files are Nuxt-flavoured: they lean on auto-imports
(`ref`, `computed`, `useI18n`) and resolve the parser through the `~/utils/bc250`
alias, so dropping them into a bare Vue app means wiring those up. `src/` has no
such baggage.

The ANSI look is all in the page's own `<style scoped>`, apart from the pixel
checkbox in `ui/components/SCheckbox.vue`, which reads `--s-*` custom properties
from the site theme.

## Use

```js
import * as w from "lzma-wasm";
import { openContainer, sealContainer } from "bc250-bios-modder-online";
import { findPalettes, setColorEverywhere } from "bc250-bios-modder-online";

await w.initWasm();
const lzma = {
  async decompress(d) { return new Uint8Array(w.decompress(d)); },
  // "alone" is the container EDK2 expects; the xz default would not decode
  async compress(d) { return new Uint8Array(w.compress(d, { format: "alone" })); },
};

const c = await openContainer(new Uint8Array(rom), lzma);
setColorEverywhere(c, findPalettes(c), 1, 0x9141ac);
const out = await sealContainer(c, lzma);
```

From the command line:

```
node examples/recolour.mjs in.ROM out.ROM 1 9141ac skull.png
```

## Notes from the board

Findings that cost a flash cycle each, so you do not have to repeat them:

- **Index 1 is the safe one.** It is the menu text and the default dialog
  background. Index 7 is the body background and doubles as the selected row's
  text, because the browser highlights a row by swapping the attribute nibbles.
  Colours 8 to 15 are foreground only; the background nibble is 3 bits.
- **Index 0 paints help text over the body background.** Pick it for contrast or
  the right-hand pane washes out.
- **The firmware centres the logo at its own pixel size and does not scale it**,
  so a bigger canvas is the only way to get a bigger splash. 1024x768 is tested
  and boots. Other BC-250 images ship 400x400, 600x600 and 600x393, so varying
  it is normal.
- **Volume growth works.** Some images ship as little as 248 bytes of free space
  inside the DXE volume, but a couple of MB after the compressed blob. The
  volume is grown and the outer file resized; the chip image stays 16 MiB.
- **Never trust the slack.** It is whatever `0xFF` happens to follow the file,
  and an already-modified ROM can have far less than a stock one.
  `measureBudget` reports it per image, and `sealContainer` refuses rather than
  overwriting what comes next.

## Verify before you flash

Reopen the result and check it. `sealContainer` gives you bytes; it does not
promise they are sane. The hosted UI refuses to offer a download unless the
rebuilt image reopens, keeps its file count, and reads back the colours and the
logo it was given. Do at least that much.

Cross-checking against `uefiextract` is worth the minute it takes: a correct
build extracts the same number of files as the input.
